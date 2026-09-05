import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { Apple2tsCore } from "../server/mcp_stdio.mjs"
import {
  resolveBrowserBuildDir,
  startApple2tsServer,
  stopApple2tsServer,
} from "../server/server.mjs"
import { statusFixture } from "./fixtures/status_fixture.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const fakeChromium = path.join(__dirname, "fixtures", "fake_chromium.mjs")
const mcpTestRunner = path.join(__dirname, "fixtures", "mcp_stdio_runner.mjs")
const wedgedRunner = path.join(__dirname, "fixtures", "wedged_runner.mjs")
const uploadHelper = path.join(repoRoot, "cli", "apple2ts-upload.mjs")
const token = "test-private-token"
const controllerToken = "test-controller-token"
const rendererId = "test-renderer"
const cleanupGraceTimeoutMs = 5000
const cleanupKillTimeoutMs = 1000
let timeoutModuleSequence = 0

const runUpload = (ticket) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [uploadHelper], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  child.once("error", reject)
  child.once("close", (code) => {
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error(stderr.trim() || `apple2ts-upload exited with status ${code}`))
  })
  child.stdin.end(`${ticket}\n`)
})

const importCoreWithCommandTimeout = async (commandTimeoutMs) => {
  const previousCommandTimeout = process.env.COMMAND_TIMEOUT_MS
  process.env.COMMAND_TIMEOUT_MS = String(commandTimeoutMs)
  try {
    const module = await import(
      `../server/mcp_stdio.mjs?command-timeout=${commandTimeoutMs}-${timeoutModuleSequence++}`
    )
    return module.Apple2tsCore
  } finally {
    if (previousCommandTimeout === undefined) delete process.env.COMMAND_TIMEOUT_MS
    else process.env.COMMAND_TIMEOUT_MS = previousCommandTimeout
  }
}

const postJson = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const readPrivateJson = async (baseUrl, pathname) => {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { Authorization: `Bearer ${controllerToken}` },
  })
  return { response, body: await response.json() }
}

const connectFakeRenderer = async (baseUrl, options = {}) => {
  const activeToken = options.token || token
  const activeRendererId = options.rendererId || rendererId
  const connectResponse = await postJson(new URL("/api/client/connect", baseUrl), {
    remoteControlToken: activeToken,
    rendererId: activeRendererId,
    pathname: "/",
    userAgent: "test",
  })
  assert.equal(connectResponse.status, 200)
  const { clientId } = await connectResponse.json()
  const eventUrl = new URL("/api/client/events", baseUrl)
  eventUrl.searchParams.set("clientId", clientId)
  eventUrl.searchParams.set("remoteControlToken", activeToken)
  eventUrl.searchParams.set("rendererId", activeRendererId)
  const eventResponse = await fetch(eventUrl)
  assert.equal(eventResponse.status, 200)

  const reader = eventResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let stopped = false
  const commands = []
  const waiters = []

  const deliver = (command) => {
    const waiter = waiters.shift()
    if (waiter) waiter(command)
    else commands.push(command)
  }

  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n\n")) {
          const boundary = buffer.indexOf("\n\n")
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))
          const eventLine = frame.split("\n").find((line) => line.startsWith("event: "))
          if (dataLine && eventLine === "event: command") deliver(JSON.parse(dataLine.slice(6)))
        }
      }
    } catch (error) {
      if (!stopped && error?.message !== "terminated") throw error
    }
  })()

  const nextCommand = () =>
    commands.length ? Promise.resolve(commands.shift()) : new Promise((resolve) => waiters.push(resolve))

  const reply = (command, extra = {}) =>
    postJson(new URL("/api/client/reply", baseUrl), {
      clientId,
      remoteControlToken: activeToken,
      rendererId: activeRendererId,
      commandId: command.commandId,
      ok: true,
      result: statusFixture,
      ...extra,
    })

  const serveStatus = (async () => {
    if (options.autoServe === false) return
    while (!stopped) {
      const command = await nextCommand()
      if (!command) break
      assert.equal(command.action, "getStatus")
      try {
        const response = await reply(command)
        assert.equal(response.status, 200)
      } catch (error) {
        if (!stopped && error?.message !== "fetch failed") throw error
      }
    }
  })()

  return {
    clientId,
    nextCommand,
    reply,
    async stop() {
      stopped = true
      waiters.splice(0).forEach((resolve) => resolve(null))
      await reader.cancel().catch(() => {})
      await Promise.allSettled([pump, serveStatus])
    },
  }
}

const waitForLine = (stream, predicate, timeoutMs = 5000, getHistory = () => "") =>
  new Promise((resolve, reject) => {
    let buffer = ""
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for process output")), timeoutMs)
    const inspect = (text) => {
      for (const line of text.split("\n")) {
        if (!line) continue
        if (predicate(line)) {
          finish(null, line)
          return true
        }
      }
      return false
    }
    const onData = (chunk) => {
      buffer += chunk.toString("utf8")
      const lines = buffer.split("\n")
      buffer = lines.pop()
      inspect(lines.join("\n"))
    }
    const finish = (error, value) => {
      clearTimeout(timeout)
      stream.off("data", onData)
      if (error) reject(error)
      else resolve(value)
    }
    stream.on("data", onData)
    inspect(getHistory())
  })

const waitFor = (promise, timeoutMs) =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    promise.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })

const launchMcp = async (overrides = {}, runner = mcpTestRunner) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-mcp-test-"))
  const receiptPath = path.join(testRoot, "chromium.json")
  const child = spawn(process.execPath, [runner], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      APPLE2TS_PRIVATE_PORT: "0",
      APPLE2TS_REMOTE_CONTROL_TOKEN: token,
      APPLE2TS_RENDERER_ID: rendererId,
      APPLE2TS_STARTUP_TIMEOUT_MS: "3000",
      APPLE2TS_CHROMIUM_EXECUTABLE: fakeChromium,
      APPLE2TS_CHROMIUM_MODE: "headless",
      APPLE2TS_FAKE_CHROMIUM_RECEIPT: receiptPath,
      ...overrides,
    },
  })
  const exitPromise = new Promise((resolve) => {
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    child.once("error", (error) => settle({ code: null, signal: null, error }))
    child.once("exit", (code, signal) => settle({ code, signal, error: null }))
  })
  let stdout = ""
  let stderr = ""
  let cleanupPromise
  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
  const readReceipt = async () => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(receiptPath, "utf8"))
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    throw new Error("Timed out waiting for fake Chromium launch receipt")
  }
  return {
    child,
    receiptPath,
    getStdout: () => stdout,
    getStderr: () => stderr,
    waitForStdout: (predicate, timeoutMs) => waitForLine(child.stdout, predicate, timeoutMs, () => stdout),
    waitForStderr: (predicate, timeoutMs) => waitForLine(child.stderr, predicate, timeoutMs, () => stderr),
    waitForExit: () => exitPromise,
    readReceipt,
    cleanup: () => cleanupPromise ||= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end()
        if (!await waitFor(exitPromise, cleanupGraceTimeoutMs)) {
          child.kill("SIGTERM")
          if (!await waitFor(exitPromise, cleanupGraceTimeoutMs)) {
            child.kill("SIGKILL")
            if (!await waitFor(exitPromise, cleanupKillTimeoutMs)) {
              throw new Error(
                `Test MCP child ${child.pid} did not exit after EOF, SIGTERM, and SIGKILL; `
                  + `retained test root ${testRoot}`,
              )
            }
          }
        }
      }
      await rm(testRoot, { recursive: true, force: true })
    })(),
  }
}

const parseBridgeUrl = (line) => {
  const match = line.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)
  assert.ok(match, `missing bridge URL in: ${line}`)
  return match[1]
}

const assertClosed = async (url) => {
  await assert.rejects(fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(500) }))
}

const waitForAbsent = async (target, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(target)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await assert.rejects(access(target))
}

const waitForPresent = async (target, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(target)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  await access(target)
}

const sendMcpRequest = async (processState, id, method, params = {}) => {
  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  return JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === id))
}

const initializeMcp = async (processState, id = "initialize") => {
  const initialized = await sendMcpRequest(processState, id, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  })
  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  return initialized
}

const startMcpSession = async (processState, id = "start-session", args = {}) =>
  sendMcpRequest(processState, id, "tools/call", { name: "start_session", arguments: args })

test("private bridge binds one renderer and rejects forged replies", async (t) => {
  const listener = await startApple2tsServer({
    port: 0,
    privateRenderer: { remoteControlToken: token, rendererId, controllerToken },
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)

  const wrong = await postJson(new URL("/api/client/connect", listener.url), {
    remoteControlToken: "wrong",
    rendererId,
  })
  assert.equal(wrong.status, 403)

  const renderer = await connectFakeRenderer(listener.url, { autoServe: false })
  t.after(() => renderer.stop())

  const second = await postJson(new URL("/api/client/connect", listener.url), {
    remoteControlToken: token,
    rendererId: "other-renderer",
  })
  assert.equal(second.status, 403)

  const duplicateEventsUrl = new URL("/api/client/events", listener.url)
  duplicateEventsUrl.searchParams.set("clientId", renderer.clientId)
  duplicateEventsUrl.searchParams.set("remoteControlToken", token)
  duplicateEventsUrl.searchParams.set("rendererId", rendererId)
  const duplicateEvents = await fetch(duplicateEventsUrl)
  assert.equal(duplicateEvents.status, 409)

  const unauthenticatedRead = await fetch(new URL("/api/machine", listener.url))
  assert.equal(unauthenticatedRead.status, 401)
  assert.equal(unauthenticatedRead.headers.get("access-control-allow-headers"), "Content-Type")
  const unauthenticatedMutation = await fetch(new URL("/api/machine/pause", listener.url), { method: "POST" })
  assert.equal(unauthenticatedMutation.status, 401)

  const machineRequest = fetch(new URL("/api/machine", listener.url), {
    headers: { Authorization: `Bearer ${controllerToken}` },
  })
  const command = await renderer.nextCommand()
  const forged = await renderer.reply(command, { remoteControlToken: "wrong" })
  assert.equal(forged.status, 403)
  const accepted = await renderer.reply(command)
  assert.equal(accepted.status, 200)
  const machine = await machineRequest.then((response) => response.json())
  assert.equal(machine.data.machineName, "APPLE2EE")

  for (const key of ["\u0000", "\u0100", "😀"]) {
    const response = await fetch(new URL("/api/input/keys", listener.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${controllerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "keyState", key, isDown: true }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /code from 1 through 255/)
  }
})

test("private renderer reconnect cancels definitive disconnect", async (t) => {
  let disconnectCount = 0
  let resolveDisconnected
  const disconnected = new Promise((resolve) => {
    resolveDisconnected = resolve
  })
  const listener = await startApple2tsServer({
    port: 0,
    privateRenderer: {
      remoteControlToken: token,
      rendererId,
      controllerToken,
      disconnectGraceMs: 100,
      onDisconnect: () => {
        disconnectCount += 1
        resolveDisconnected()
      },
    },
    logger: { log() {} },
  })
  t.after(() => stopApple2tsServer())

  const first = await connectFakeRenderer(listener.url)
  await first.stop()
  const reconnected = await connectFakeRenderer(listener.url)
  t.after(() => reconnected.stop())
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(disconnectCount, 0)

  await reconnected.stop()
  await disconnected
  assert.equal(disconnectCount, 1)
})

test("private bridge reads bounded memory in byte and hex formats", async (t) => {
  const listener = await startApple2tsServer({
    port: 0,
    privateRenderer: { remoteControlToken: token, rendererId, controllerToken },
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)

  const renderer = await connectFakeRenderer(listener.url, { autoServe: false })
  t.after(() => renderer.stop())
  const memoryDump = new Array(65536).fill(0)
  memoryDump[0] = 17
  memoryDump[1] = 34
  memoryDump[65534] = 171
  memoryDump[65535] = 205

  const maximumRequest = readPrivateJson(
    listener.url,
    "/api/debug/memory?start=0&length=65536",
  )
  const maximumCommand = await renderer.nextCommand()
  assert.deepEqual(
    { action: maximumCommand.action, payload: maximumCommand.payload },
    { action: "getMemory", payload: {} },
  )
  assert.equal((await renderer.reply(maximumCommand, { result: { memoryDump } })).status, 200)
  const maximum = await maximumRequest
  assert.equal(maximum.response.status, 200)
  assert.equal(maximum.body.data.start, 0)
  assert.equal(maximum.body.data.length, 65536)
  assert.equal(maximum.body.data.format, "bytes")
  assert.equal(maximum.body.data.data.length, 65536)
  assert.deepEqual(maximum.body.data.data.slice(0, 2), [17, 34])
  assert.equal(maximum.body.data.data.at(-1), 205)

  const hexRequest = readPrivateJson(
    listener.url,
    "/api/debug/memory?start=65534&length=2&format=hex",
  )
  const hexCommand = await renderer.nextCommand()
  assert.equal(hexCommand.action, "getMemory")
  assert.equal((await renderer.reply(hexCommand, { result: { memoryDump } })).status, 200)
  const hex = await hexRequest
  assert.equal(hex.response.status, 200)
  assert.deepEqual(hex.body, {
    ok: true,
    data: { start: 65534, length: 2, format: "hex", data: "AB CD" },
  })
})

test("private bridge captures the current renderer screen", async (t) => {
  const listener = await startApple2tsServer({
    port: 0,
    privateRenderer: { remoteControlToken: token, rendererId, controllerToken },
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)

  const renderer = await connectFakeRenderer(listener.url, { autoServe: false })
  t.after(() => renderer.stop())
  const captureRequest = readPrivateJson(listener.url, "/api/private/screen")
  const command = await renderer.nextCommand()
  assert.deepEqual(
    { action: command.action, payload: command.payload },
    { action: "captureScreen", payload: {} },
  )
  assert.equal((await renderer.reply(command, {
    result: {
      mimeType: "image/png",
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      width: 1,
      height: 1,
    },
  })).status, 200)

  const capture = await captureRequest
  assert.equal(capture.response.status, 200)
  assert.deepEqual(capture.body.data, {
    mimeType: "image/png",
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    width: 1,
    height: 1,
  })
})

test("private bridge rejects invalid and unavailable memory ranges", async (t) => {
  const listener = await startApple2tsServer({
    port: 0,
    privateRenderer: { remoteControlToken: token, rendererId, controllerToken },
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)

  const renderer = await connectFakeRenderer(listener.url, { autoServe: false })
  t.after(() => renderer.stop())

  for (const pathname of [
    "/api/debug/memory?start=-1&length=1",
    "/api/debug/memory?start=0&length=0",
    "/api/debug/memory?start=65535&length=2",
    "/api/debug/memory?start=0&length=1&format=raw",
  ]) {
    const result = await readPrivateJson(listener.url, pathname)
    assert.equal(result.response.status, 400, pathname)
    assert.equal(result.body.error.code, "BAD_REQUEST", pathname)
  }

  const unavailableRequest = readPrivateJson(
    listener.url,
    "/api/debug/memory?start=3&length=2",
  )
  const command = await renderer.nextCommand()
  assert.equal(command.action, "getMemory")
  assert.equal((await renderer.reply(command, { result: { memoryDump: [0, 1, 2, 3] } })).status, 200)
  const unavailable = await unavailableRequest
  assert.equal(unavailable.response.status, 400)
  assert.equal(unavailable.body.ok, false)
  assert.equal(unavailable.body.error.code, "BAD_REQUEST")
})

test("private bridge loads a binary into main RAM and returns a completion receipt", async (t) => {
  const listener = await startApple2tsServer({
    port: 0,
    privateRenderer: { remoteControlToken: token, rendererId, controllerToken },
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)

  const renderer = await connectFakeRenderer(listener.url, { autoServe: false })
  t.after(() => renderer.stop())
  const bytes = Buffer.from([0xA9, 0x42, 0x60])

  const loadRequest = fetch(new URL("/api/debug/binary?address=24576", listener.url), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${controllerToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  })
  const loadCommand = await renderer.nextCommand()
  assert.deepEqual(
    { action: loadCommand.action, payload: loadCommand.payload },
    { action: "loadBinary", payload: { address: 0x6000, dataBase64: bytes.toString("base64") } },
  )
  assert.equal((await renderer.reply(loadCommand)).status, 200)

  const response = await loadRequest
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    data: {
      address: 0x6000,
      bytesWritten: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  })

  const rejectedResponse = await fetch(new URL("/api/debug/binary?address=49151", listener.url), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${controllerToken}`,
      "Content-Type": "application/octet-stream",
    },
    body: Buffer.from([1, 2]),
  })
  assert.equal(rejectedResponse.status, 400)
  assert.equal((await rejectedResponse.json()).error.message, "Binary block must fit within main RAM at $0000-$BFFF")
})

test("private bridge rejects invalid binary input", async (t) => {
  const listener = await startApple2tsServer({
    port: 0,
    privateRenderer: { remoteControlToken: token, rendererId, controllerToken },
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)

  const renderer = await connectFakeRenderer(listener.url, { autoServe: false })
  t.after(() => renderer.stop())

  for (const request of [
    new Request(new URL("/api/debug/binary?address=0", listener.url), {
      method: "PUT",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "text/plain" },
      body: "x",
    }),
    new Request(new URL("/api/debug/binary", listener.url), {
      method: "PUT",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from([1]),
    }),
    new Request(new URL("/api/debug/binary?address=65535", listener.url), {
      method: "PUT",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from([1, 2]),
    }),
    new Request(new URL("/api/debug/binary?address=49151", listener.url), {
      method: "PUT",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from([1, 2]),
    }),
    new Request(new URL("/api/debug/binary?address=0", listener.url), {
      method: "PUT",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(0),
    }),
  ]) {
    const response = await fetch(request)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, "BAD_REQUEST")
  }

  const uploadController = new AbortController()
  const uploadTimeout = setTimeout(() => uploadController.abort(), 1000)
  try {
    const streamedResponse = await fetch(new URL("/api/debug/binary?address=0", listener.url), {
      method: "PUT",
      headers: { Authorization: `Bearer ${controllerToken}`, "Content-Type": "application/octet-stream" },
      body: (async function* () {
        yield Buffer.alloc(40000)
        yield Buffer.alloc(40000)
        await new Promise((resolve) => uploadController.signal.addEventListener("abort", resolve, { once: true }))
      })(),
      duplex: "half",
      signal: uploadController.signal,
    })
    assert.equal(streamedResponse.status, 400)
    assert.equal((await streamedResponse.json()).error.code, "BAD_REQUEST")
  } finally {
    clearTimeout(uploadTimeout)
    uploadController.abort()
  }
})

test("non-private server routes preserve legacy access", async (t) => {
  const listener = await startApple2tsServer({ port: 0, logger: { log() {} } })
  t.after(stopApple2tsServer)

  const health = await fetch(new URL("/api/health", listener.url))
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: "ok" })
  const machine = await fetch(new URL("/api/machine", listener.url))
  assert.equal(machine.status, 503)
  const memory = await fetch(new URL("/api/debug/memory?start=0&length=1", listener.url))
  assert.equal(memory.status, 503)
  const binary = await fetch(new URL("/api/debug/binary?address=768", listener.url), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from([0x60]),
  })
  assert.equal(binary.status, 404)
})

test("server serves a selected Apple2TS build directory", async (t) => {
  const browserBuildDir = await mkdtemp(path.join(os.tmpdir(), "apple2ts-dist-test-"))
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "apple2ts-dist-outside-test-"))
  t.after(() => rm(browserBuildDir, { recursive: true, force: true }))
  t.after(() => rm(outsideDir, { recursive: true, force: true }))
  await writeFile(path.join(browserBuildDir, "index.html"), "selected build")
  await writeFile(path.join(browserBuildDir, "asset.txt"), "selected asset")
  await writeFile(path.join(outsideDir, "private.txt"), "outside build")
  await symlink(path.join(outsideDir, "private.txt"), path.join(browserBuildDir, "escape.txt"))

  const listener = await startApple2tsServer({
    port: 0,
    distDir: browserBuildDir,
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)

  assert.equal(await (await fetch(listener.url)).text(), "selected build")
  assert.equal(await (await fetch(new URL("/asset.txt", listener.url))).text(), "selected asset")
  assert.equal((await fetch(new URL("/escape.txt", listener.url))).status, 403)
  assert.throws(
    () => resolveBrowserBuildDir("relative/dist"),
    /APPLE2TS_DIST_DIR must be an absolute path/,
  )
})

test("mutations wait for prior callers and the mutation deadline", async (t) => {
  let activeRequests = 0
  let maxActiveRequests = 0
  const bridge = createServer(async (req, res) => {
    activeRequests += 1
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (body.speedMode === 4) await new Promise((resolve) => setTimeout(resolve, 2100))
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({
      ok: true,
      data: req.url === "/api/debug/cpu"
        ? {
            PC: body.PC,
            A: body.A ?? 0,
            X: body.X ?? 0,
            Y: body.Y ?? 0,
            S: body.S ?? 0xff,
            PStatus: body.PStatus,
          }
        : { runMode: "paused", speedMode: body.speedMode },
    }))
    activeRequests -= 1
  })
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => bridge.close(resolve)))
  const address = bridge.address()
  const core = new Apple2tsCore(
    `http://127.0.0.1:${address.port}`,
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )

  const [accelerated, cpu, normalized] = await Promise.all([
    core.setSpeed(4),
    core.setCpu({ PC: 0x6000, PStatus: 0x20 }),
    core.setSpeed(0),
  ])
  assert.equal(maxActiveRequests, 1)
  assert.equal(accelerated.state.speedMode, 4)
  assert.deepEqual(cpu.value, { PC: 0x6000, A: 0, X: 0, Y: 0, S: 0xff, PStatus: 0x20 })
  assert.equal(normalized.state.speedMode, 0)
})

test("a failed mutation prevents later mutations in the same session", async (t) => {
  let requests = 0
  const bridge = createServer((_req, res) => {
    requests += 1
    res.setHeader("Content-Type", "application/json")
    res.statusCode = 500
    res.end(JSON.stringify({ ok: false, error: "uncertain mutation" }))
  })
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => bridge.close(resolve)))
  const address = bridge.address()
  const core = new Apple2tsCore(
    `http://127.0.0.1:${address.port}`,
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )

  await assert.rejects(core.pause(), /uncertain mutation/)
  await assert.rejects(core.resume(), /restart this MCP session/)
  assert.equal(requests, 1)
})

test("keyboard cleanup releases a key whose press response failed", async () => {
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )
  core.request = async (_pathname, { body }) => {
    requests.push(body)
    if (body.isDown) throw new Error("response lost after key-down")
  }

  await assert.rejects(core.setKeyboardKey("j"), /response lost after key-down/)

  assert.deepEqual(requests, [
    { type: "keyState", key: "j", isDown: true, repeat: false },
    { type: "keyState", key: "j", isDown: false, repeat: false },
  ])
})

test("keyboard cleanup retries an uncertain old-key release", async () => {
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )
  core.request = async (_pathname, { body }) => {
    requests.push(body)
    if (requests.length === 2) throw new Error("response lost after key-up")
  }

  await core.setKeyboardKey("j")
  await assert.rejects(core.setKeyboardKey("l"), /response lost after key-up/)

  assert.deepEqual(requests, [
    { type: "keyState", key: "j", isDown: true, repeat: false },
    { type: "keyState", key: "j", isDown: false, repeat: false },
    { type: "keyState", key: "j", isDown: false, repeat: false },
  ])
})

test("a later mutation failure releases the held key", async () => {
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )
  core.request = async (pathname, options = {}) => {
    requests.push({ pathname, body: options.body })
    if (pathname === "/api/machine/pause") throw new Error("pause response lost")
    return { emulator: core.identity, state: {} }
  }

  await core.setKeyboardKey("j")
  await assert.rejects(core.pause(), /pause response lost/)

  assert.deepEqual(requests, [
    {
      pathname: "/api/input/keys",
      body: { type: "keyState", key: "j", isDown: true, repeat: false },
    },
    { pathname: "/api/machine/pause", body: undefined },
    {
      pathname: "/api/input/keys",
      body: { type: "keyState", key: "j", isDown: false, repeat: false },
    },
  ])
})

test("an aborted mutation releases the held key after completing", async () => {
  let finishPause
  let pauseStarted
  const pauseFinished = new Promise((resolve) => (finishPause = resolve))
  const started = new Promise((resolve) => (pauseStarted = resolve))
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )
  core.request = async (pathname, options = {}) => {
    requests.push({ pathname, body: options.body })
    if (pathname === "/api/machine/pause") {
      pauseStarted()
      await pauseFinished
    }
    return {
      emulator: core.identity,
      state: { runMode: "paused", speedMode: 0 },
    }
  }

  await core.setKeyboardKey("j")
  const cancellation = new AbortController()
  const pause = core.pause(cancellation.signal)
  await started
  cancellation.abort()
  finishPause()
  await pause

  assert.deepEqual(requests, [
    {
      pathname: "/api/input/keys",
      body: { type: "keyState", key: "j", isDown: true, repeat: false },
    },
    { pathname: "/api/machine/pause", body: undefined },
    {
      pathname: "/api/input/keys",
      body: { type: "keyState", key: "j", isDown: false, repeat: false },
    },
  ])
  await assert.rejects(core.resume(), /restart this MCP session/)
})

test("binary loading validates and serializes one byte block", async (t) => {
  const bytes = Buffer.from([0xA9, 0x42, 0x60])
  const requestPaths = []
  const bridge = createServer(async (req, res) => {
    requestPaths.push(req.url)
    assert.equal(req.headers.authorization, `Bearer ${controllerToken}`)
    if (req.url === "/api/machine/resume") {
      assert.equal(req.method, "POST")
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ ok: true, data: { runMode: "running", speedMode: 0 } }))
      return
    }
    assert.equal(req.method, "PUT")
    assert.equal(req.url, "/api/debug/binary?address=24576")
    assert.equal(req.headers["content-type"], "application/octet-stream")
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    assert.deepEqual(bytes, Buffer.from([0xA9, 0x42, 0x60]))
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({
      ok: true,
      data: {
        address: 0x6000,
        bytesWritten: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }))
  })
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => bridge.close(resolve)))
  const address = bridge.address()
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const core = new Apple2tsCore(
    `http://127.0.0.1:${address.port}`,
    controllerToken,
    identity,
    new AbortController().signal,
  )

  const [loaded, resumed] = await Promise.all([
    core.loadBinaryBytes({ address: 0x6000 }, bytes),
    core.resume(),
  ])
  assert.deepEqual(loaded, {
    emulator: identity,
    address: 0x6000,
    bytesWritten: 3,
    sha256: createHash("sha256").update(Buffer.from([0xA9, 0x42, 0x60])).digest("hex"),
  })
  assert.equal(resumed.state.runMode, "running")
  assert.deepEqual(requestPaths, ["/api/debug/binary?address=24576", "/api/machine/resume"])
  for (const address of [-1, 0xC000, 0xBFFE]) {
    await assert.rejects(core.loadBinaryBytes({ address }, bytes))
  }
  assert.equal(requestPaths.length, 2)
})

test("disk mounting serializes one byte block and eject", async () => {
  const bytes = Buffer.from("WOZ2\u00ff\n\r\n")

  const requests = []
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
  )
  core.request = async (pathname, options) => {
    requests.push({ pathname, options })
    const mounted = options.method !== "DELETE"
    return {
      emulator: identity,
      state: {
        driveId: "fd1",
        index: 0,
        kind: "floppy",
        mounted,
        filename: mounted ? "fixture.woz" : null,
        status: mounted ? "mounted" : "",
        writeProtected: false,
        dirty: false,
        motorRunning: false,
        byteLength: mounted ? bytes.length : 0,
      },
    }
  }

  const mounted = await core.mountDiskBytes({ driveId: "fd1", path: "fixture.woz" }, bytes)
  const ejected = await core.ejectDisk("fd1")

  assert.deepEqual(mounted.state, { driveId: "fd1", mounted: true })
  assert.deepEqual(ejected.state, { driveId: "fd1", mounted: false })
  assert.deepEqual(requests, [
    {
      pathname: "/api/drives/fd1/mount",
      options: {
        method: "POST",
        body: {
          sourceType: "base64",
          filename: "fixture.woz",
          dataBase64: bytes.toString("base64"),
        },
      },
    },
    { pathname: "/api/drives/fd1", options: { method: "DELETE" } },
  ])
})

test("disk mounting preflights known media compatibility without poisoning the session", async () => {
  const standardPo = Buffer.alloc(143360)
  const boundaryOverPo = Buffer.alloc(143361)
  const hardDrivePo = Buffer.alloc(800 * 1024)
  const media = {
    "standard.po": standardPo,
    "boundary-over.po": boundaryOverPo,
    "hard-drive.po": hardDrivePo,
    "disk.woz": Buffer.from("WOZ2"),
    "disk.dsk": Buffer.from("DSK"),
    "disk.do": Buffer.from("DO"),
    "unknown.img": Buffer.from("IMG"),
  }

  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
  )
  core.request = async (pathname, options) => {
    requests.push({ pathname, options })
    return { emulator: identity, state: { driveId: pathname.split("/")[3], mounted: true } }
  }

  const mount = (driveId, filePath) => core.mountDiskBytes(
    { driveId, path: filePath },
    media[filePath],
  )
  await assert.rejects(mount("fd1", "hard-drive.po"), /fd1 cannot mount a hard-drive image/)
  assert.equal(requests.length, 0)
  await assert.rejects(mount("hd1", "standard.po"), /hd1 cannot mount a floppy image/)
  await assert.rejects(mount("fd1", "boundary-over.po"), /fd1 cannot mount a hard-drive image/)
  await assert.rejects(mount("hd1", "disk.woz"), /hd1 cannot mount a floppy image/)
  await assert.rejects(mount("hd1", "disk.dsk"), /hd1 cannot mount a floppy image/)
  await assert.rejects(mount("hd1", "disk.do"), /hd1 cannot mount a floppy image/)
  assert.equal(requests.length, 0)

  const floppyPo = await mount("fd1", "standard.po")
  const hardDrive = await mount("hd1", "hard-drive.po")
  const unclassified = await mount("fd2", "unknown.img")
  assert.deepEqual(floppyPo.state, { driveId: "fd1", mounted: true })
  assert.deepEqual(hardDrive.state, { driveId: "hd1", mounted: true })
  assert.deepEqual(unclassified.state, { driveId: "fd2", mounted: true })
  assert.deepEqual(requests.map(({ pathname }) => pathname), [
    "/api/drives/fd1/mount",
    "/api/drives/hd1/mount",
    "/api/drives/fd2/mount",
  ])
})

test("disk mutations reject drive state that does not confirm the requested result", async () => {
  const bytes = Buffer.from("WOZ2\u00ff\n\r\n")
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const driveState = {
    driveId: "fd1",
    index: 0,
    kind: "floppy",
    mounted: true,
    filename: "fixture.woz",
    status: "mounted",
    writeProtected: false,
    dirty: false,
    motorRunning: false,
    byteLength: 9,
  }
  const createCore = (state) => {
    const core = new Apple2tsCore(
      "http://unused.test",
      controllerToken,
      identity,
      new AbortController().signal,
    )
    core.request = async () => ({ emulator: identity, state })
    return core
  }

  const invalidMountStates = [
    { ...driveState, driveId: "fd2" },
    { ...driveState, mounted: false },
  ]
  for (const state of invalidMountStates) {
    await assert.rejects(
      createCore(state).mountDiskBytes({ driveId: "fd1", path: "fixture.woz" }, bytes),
      /did not confirm disk mount for fd1/,
    )
  }
  await assert.rejects(
    createCore(driveState).ejectDisk("fd1"),
    /did not confirm disk eject for fd1/,
  )
})

test("confirmed invalid disk rejection leaves later eject usable", async () => {
  const bytes = Buffer.from("not a disk")
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const emptyDrive = {
    driveId: "fd2",
    index: 1,
    kind: "floppy",
    mounted: false,
    filename: null,
    status: "",
    writeProtected: false,
    dirty: false,
    motorRunning: false,
    byteLength: 0,
  }
  const requestPaths = []
  const requestTimeouts = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
  )
  core.request = async (pathname, options = {}, _signal, timeoutMs) => {
    requestPaths.push(pathname)
    requestTimeouts.push(timeoutMs)
    if (options.method === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const error = new Error("Apple2TS rejected invalid disk media")
      error.bridgeStatus = 400
      throw error
    }
    return { emulator: identity, state: emptyDrive }
  }

  await assert.rejects(
    core.mountDiskBytes({ driveId: "fd2", path: "invalid.woz" }, bytes),
    /rejected invalid disk media/,
  )
  const ejected = await core.ejectDisk("fd2")

  assert.equal(ejected.state.mounted, false)
  assert.deepEqual(requestPaths, [
    "/api/drives/fd2/mount",
    "/api/drives/fd2",
    "/api/drives/fd2",
  ])
  assert.equal(typeof requestTimeouts[0], "number")
  assert.equal(typeof requestTimeouts[1], "number")
  assert.ok(requestTimeouts[1] < requestTimeouts[0])
  assert.equal(requestTimeouts[2], undefined)
})

test("disk preflight failure preserves a held key", async () => {
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
  )
  core.request = async (pathname, options = {}) => {
    requests.push({ pathname, body: options.body })
    return { emulator: identity, state: {} }
  }

  await core.setKeyboardKey("j")
  await assert.rejects(
    core.mountDiskBytes({ driveId: "fd1", path: "hard-drive.po" }, Buffer.alloc(143361)),
    /fd1 cannot mount a hard-drive image/,
  )

  assert.equal(core.heldKey, "j")
  assert.deepEqual(requests, [{
    pathname: "/api/input/keys",
    body: { type: "keyState", key: "j", isDown: true, repeat: false },
  }])
})

test("aborted confirmed disk rejection releases a held key", async () => {
  const bytes = Buffer.from("not a disk")
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const emptyDrive = { driveId: "fd1", mounted: false }
  let finishMount
  let mountStarted
  const finish = new Promise((resolve) => (finishMount = resolve))
  const started = new Promise((resolve) => (mountStarted = resolve))
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
  )
  core.request = async (pathname, options = {}) => {
    requests.push({ pathname, body: options.body })
    if (pathname.endsWith("/mount")) {
      mountStarted()
      await finish
      const error = new Error("Apple2TS rejected invalid disk media")
      error.bridgeStatus = 400
      throw error
    }
    if (pathname === "/api/drives/fd1") return { emulator: identity, state: emptyDrive }
    return { emulator: identity, state: {} }
  }

  await core.setKeyboardKey("j")
  const cancellation = new AbortController()
  const mount = core.mountDiskBytes(
    { driveId: "fd1", path: "invalid.woz" },
    bytes,
    cancellation.signal,
  )
  await started
  cancellation.abort()
  finishMount()
  await assert.rejects(mount, /rejected invalid disk media/)

  assert.equal(core.heldKey, null)
  assert.equal(requests.at(-1).pathname, "/api/input/keys")
  assert.equal(requests.at(-1).body.isDown, false)
  await assert.rejects(core.ejectDisk("fd1"), /restart this MCP session/)
})

test("unconfirmed mount rejection still poisons later mutations", async () => {
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
    new AbortController().signal,
  )
  let requests = 0
  core.request = async () => {
    requests += 1
    if (requests === 1) {
      const error = new Error("Apple2TS rejected invalid disk media")
      error.bridgeStatus = 400
      throw error
    }
    throw new Error("drive readback unavailable")
  }

  await assert.rejects(
    core.mountDiskBytes({ driveId: "fd2", path: "invalid.woz" }, Buffer.from("not a disk")),
    /drive readback unavailable/,
  )
  await assert.rejects(core.ejectDisk("fd2"), /restart this MCP session/)
  assert.equal(requests, 2)
})

test("mount transport failure remains an uncertain mutation", async () => {
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
    new AbortController().signal,
  )
  let requests = 0
  core.request = async () => {
    requests += 1
    throw new Error("transport timed out")
  }

  await assert.rejects(
    core.mountDiskBytes(
      { driveId: "fd1", path: "fixture.woz" },
      Buffer.from("WOZ2\u00ff\n\r\n"),
    ),
    /transport timed out/,
  )
  await assert.rejects(core.ejectDisk("fd1"), /restart this MCP session/)
  assert.equal(requests, 1)
})

test("mount timeout covers delayed drive lookup and mount confirmation", async (t) => {
  const commandTimeoutMs = 2000
  const DelayedMountCore = await importCoreWithCommandTimeout(commandTimeoutMs)

  const listener = await startApple2tsServer({
    port: 0,
    commandTimeoutMs,
    privateRenderer: { remoteControlToken: token, rendererId, controllerToken },
    logger: { log() {} },
  })
  t.after(stopApple2tsServer)
  const renderer = await connectFakeRenderer(listener.url, { autoServe: false })
  t.after(() => renderer.stop())

  const emptyDrive = {
    index: 0,
    drive: 1,
    hardDrive: false,
    filename: "",
    status: "",
    isWriteProtected: false,
    diskHasChanges: false,
    motorRunning: false,
    byteLength: 0,
  }
  const mountedDrive = {
    ...emptyDrive,
    filename: "fixture.woz",
    status: "mounted",
    byteLength: 9,
  }
  const core = new DelayedMountCore(
    listener.url,
    controllerToken,
    { serverInstanceId: listener.serverInstanceId, rendererId, targetId: `${listener.serverInstanceId}:${rendererId}` },
    new AbortController().signal,
  )

  const mountOutcome = core.mountDiskBytes(
    { driveId: "fd1", path: "fixture.woz" },
    Buffer.from("WOZ2\u00ff\n\r\n"),
  )
    .then((value) => ({ value }), (error) => ({ error }))
  const statusCommand = await renderer.nextCommand()
  assert.equal(statusCommand.action, "getStatus")
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal((await renderer.reply(statusCommand, {
    result: { ...statusFixture, drives: [emptyDrive] },
  })).status, 200)

  const mountCommand = await renderer.nextCommand()
  assert.equal(mountCommand.action, "mountDisk")
  await new Promise((resolve) => setTimeout(resolve, 1000))
  assert.equal((await renderer.reply(mountCommand, {
    result: {
      mountedDrive: 0,
      status: { ...statusFixture, drives: [mountedDrive] },
    },
  })).status, 200)

  const outcome = await mountOutcome
  assert.ifError(outcome.error)
  assert.deepEqual(outcome.value.state, { driveId: "fd1", mounted: true })
})

test("mount timeout still poisons later mutations when its full budget is exceeded", async (t) => {
  const StalledMountCore = await importCoreWithCommandTimeout(100)

  let requests = 0
  const bridge = createServer(async (_req, res) => {
    requests += 1
    await new Promise((resolve) => setTimeout(resolve, 1500))
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: true, data: { driveId: "fd1", mounted: true } }))
  })
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => bridge.close(resolve)))
  const address = bridge.address()
  const core = new StalledMountCore(
    `http://127.0.0.1:${address.port}`,
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
    new AbortController().signal,
  )

  await assert.rejects(
    core.mountDiskBytes(
      { driveId: "fd1", path: "fixture.woz" },
      Buffer.from("WOZ2\u00ff\n\r\n"),
    ),
    /aborted due to timeout/,
  )
  await assert.rejects(core.ejectDisk("fd1"), /restart this MCP session/)
  assert.equal(requests, 1)
})

test("cancelling an active mutation prevents later mutations in the same session", async (t) => {
  let release
  let started
  const startedPromise = new Promise((resolve) => (started = resolve))
  const releasePromise = new Promise((resolve) => (release = resolve))
  const bridge = createServer(async (_req, res) => {
    started()
    await releasePromise
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: true, data: { runMode: "paused", speedMode: 0 } }))
  })
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => bridge.close(resolve)))
  const address = bridge.address()
  const core = new Apple2tsCore(
    `http://127.0.0.1:${address.port}`,
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )
  const cancellation = new AbortController()

  const pause = core.pause(cancellation.signal)
  await startedPromise
  cancellation.abort()
  release()
  await pause
  await assert.rejects(core.resume(), /restart this MCP session/)
})

const executionSnapshot = (sequence, state, overrides = {}) => ({
  executionSequence: sequence,
  state,
  pauseReason: state === "paused" ? "explicit" : null,
  breakpoint: null,
  PC: 0x6000,
  A: 1,
  X: 2,
  Y: 3,
  S: 0xFF,
  PStatus: 0x24,
  machineName: "APPLE2EE",
  memoryConfiguration: { slot3Card: "aux", ramWorksKb: 64 },
  ...overrides,
})

test("execution waiters are bounded, cancellable, nonblocking, and lost-wakeup safe", async () => {
  const core = new Apple2tsCore(
    "http://unused.invalid",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )
  core.observeExecution(executionSnapshot(4, "running"))

  const wait = core.waitForExecutionStop({
    timeoutMs: 1000,
    afterSequence: 4,
    expectedBreakpointAddress: 0x6004,
  })
  core.request = async (pathname) => ({ emulator: core.identity, state: { pathname } })
  assert.deepEqual((await core.readCpu()).state, { pathname: "/api/debug/cpu" })

  core.observeExecution(executionSnapshot(5, "paused", {
    pauseReason: "breakpoint",
    breakpoint: { breakpointId: "bp:24579", address: 0x6003 },
    PC: 0x6003,
  }))
  const stopped = await wait
  assert.equal(stopped.outcome, "stopped")
  assert.equal(stopped.expectationMatched, false)
  assert.equal(stopped.state.executionSequence, 5)
  assert.equal(stopped.state.breakpoint.breakpointId, "bp:24579")

  core.observeExecution(executionSnapshot(6, "running"))
  core.observeExecution(executionSnapshot(7, "paused"))
  const fastStop = await core.waitForExecutionStop({ timeoutMs: 1000, afterSequence: 6 })
  assert.equal(fastStop.outcome, "stopped")
  assert.equal(fastStop.state.executionSequence, 7)

  const alreadyPaused = await core.waitForExecutionStop({ timeoutMs: 1000 })
  assert.equal(alreadyPaused.outcome, "stopped")
  assert.equal(alreadyPaused.state.executionSequence, 7)

  core.observeExecution(executionSnapshot(8, "running"))
  const timedOut = await core.waitForExecutionStop({ timeoutMs: 5, afterSequence: 8 })
  assert.equal(timedOut.outcome, "timeout")
  assert.equal(timedOut.state.executionSequence, 8)

  const cancellation = new AbortController()
  const cancelled = core.waitForExecutionStop({ timeoutMs: 1000, afterSequence: 8 }, cancellation.signal)
  cancellation.abort(new Error("cancelled by caller"))
  await assert.rejects(cancelled, /cancelled by caller/)

  const closed = core.waitForExecutionStop({ timeoutMs: 1000, afterSequence: 8 })
  core.closeExecution()
  assert.equal((await closed).outcome, "session_closed")
})

test("execution state rejects inconsistent expectations and ignores stale observations", async () => {
  const core = new Apple2tsCore(
    "http://unused.invalid",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
  )
  core.observeExecution(executionSnapshot(3, "paused", { PC: 0x6003 }))
  const sameSequenceWait = core.waitForExecutionStop({ timeoutMs: 5, afterSequence: 3 })
  core.observeExecution(executionSnapshot(3, "paused", { PC: 0x6010, A: 0x41 }))
  assert.deepEqual(
    { PC: (await core.readExecution()).state.PC, A: (await core.readExecution()).state.A },
    { PC: 0x6010, A: 0x41 },
  )
  assert.equal((await sameSequenceWait).outcome, "timeout")
  core.observeExecution(executionSnapshot(2, "running", { PC: 0x1234 }))
  assert.equal((await core.readExecution()).state.PC, 0x6010)
  core.observeExecution({
    statusSequence: 12,
    machine: { execution: executionSnapshot(3, "paused", { PC: 0x6020 }) },
  })
  core.observeExecution({
    statusSequence: 11,
    machine: { execution: executionSnapshot(3, "paused", { PC: 0x6003 }) },
  })
  core.observeExecution({
    machine: { execution: executionSnapshot(3, "paused", { PC: 0x6004 }) },
  })
  assert.equal((await core.readExecution()).state.PC, 0x6020)
  await assert.rejects(core.waitForExecutionStop({
    timeoutMs: 10,
    expectedBreakpointId: "bp:24579",
    expectedBreakpointAddress: 0x6004,
  }), /must identify the same breakpoint/)
  await assert.rejects(core.waitForExecutionStop({
    timeoutMs: 10,
    expectedBreakpointId: "bp:65536",
  }), /address between 0 and 65535/)

  core.closeExecution()
  assert.equal((await core.waitForExecutionStop({ timeoutMs: 10 })).outcome, "session_closed")
})

test("stdio reads and controls one renderer and EOF cleans up", async (t) => {
  const processState = await launchMcp()
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready for session requests"))
  await assert.rejects(processState.readReceipt())

  await initializeMcp(processState, 1)
  const inactiveRead = await sendMcpRequest(processState, "inactive-read", "tools/call", {
    name: "read_memory",
    arguments: { address: 0, length: 1 },
  })
  assert.equal(inactiveRead.result.isError, true)
  assert.match(inactiveRead.result.content[0].text, /Call start_session first/)

  const started = await startMcpSession(processState, "start-session")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const startedAgain = await startMcpSession(processState, "start-session-again")
  assert.deepEqual(startedAgain.result.structuredContent, started.result.structuredContent)
  const bridgeLine = await processState.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const receipt = await processState.readReceipt()
  const launchUrl = new URL(receipt.launchUrl)
  assert.equal(launchUrl.origin, bridgeUrl)
  assert.equal(launchUrl.searchParams.get("remoteControl"), "1")
  assert.equal(launchUrl.searchParams.get("remoteControlToken"), token)
  assert.equal(launchUrl.searchParams.get("rendererId"), rendererId)
  assert.equal(launchUrl.searchParams.get("controllerToken"), null)
  assert.equal(receipt.headless, true)
  assert.doesNotThrow(() => process.kill(receipt.pid, 0))
  await access(receipt.profilePath)

  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" })}\n`)
  const listed = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 2))
  assert.deepEqual(listed.result.resources.map((resource) => resource.uri), [
    "apple2ts://session/lifecycle",
    "apple2ts://machine",
    "apple2ts://session/execution",
    "apple2ts://cpu",
    "apple2ts://debugger/breakpoints",
    "apple2ts://disks/current",
    "apple2ts://system/softswitches",
    "apple2ts://video/text",
  ])

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: "apple2ts://cpu" },
  })}\n`)
  const read = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 3))
  const payload = JSON.parse(read.result.contents[0].text)
  assert.equal(payload.emulator.rendererId, rendererId)
  assert.equal(payload.state.PC, 768)

  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" })}\n`)
  const tools = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 4))
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    [
      "start_session",
      "stop_session",
      "read_memory",
      "wait_for_execution_stop",
      "capture_screen",
      "prepare_mount_disk",
      "prepare_load_binary",
      "set_keyboard_key",
      "eject_disk",
      "boot",
      "reset",
      "pause",
      "resume",
      "set_speed",
      "set_breakpoint",
      "clear_breakpoint",
      "clear_all_breakpoints",
      "set_cpu",
    ],
  )
  const startSessionTool = tools.result.tools.find((tool) => tool.name === "start_session")
  assert.deepEqual(startSessionTool.inputSchema, {
    type: "object",
    properties: {
      visibility: { type: "string", enum: ["headless", "visible"] },
    },
    additionalProperties: false,
  })
  const readMemoryTool = tools.result.tools.find((tool) => tool.name === "read_memory")
  assert.match(readMemoryTool.description, /Request the smallest useful range/)
  assert.deepEqual(readMemoryTool.inputSchema, {
    type: "object",
    properties: {
      address: { type: "integer", minimum: 0, maximum: 65535 },
      length: { type: "integer", minimum: 1, maximum: 4096 },
      space: { type: "string", enum: ["active", "main", "aux"], default: "active" },
      auxBank: { type: "integer", minimum: 0, maximum: 127 },
    },
    required: ["address", "length"],
    additionalProperties: false,
  })
  assert.equal(readMemoryTool.outputSchema.type, "object")
  assert.deepEqual(readMemoryTool.outputSchema.properties.value.properties.bytes, {
    type: "array",
    items: { type: "integer", minimum: 0, maximum: 255 },
    minItems: 1,
    maxItems: 4096,
  })
  assert.equal(
    readMemoryTool.outputSchema.properties.value.properties.requestedAuxBank.type,
    "integer",
  )
  assert.equal(
    readMemoryTool.outputSchema.properties.value.properties.effectiveAuxBank.type,
    "integer",
  )
  assert.equal(
    readMemoryTool.outputSchema.properties.value.required.includes("requestedAuxBank"),
    false,
  )
  assert.equal(
    readMemoryTool.outputSchema.properties.value.required.includes("effectiveAuxBank"),
    false,
  )
  assert.deepEqual(readMemoryTool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  const keyboardTool = tools.result.tools.find((tool) => tool.name === "set_keyboard_key")
  assert.deepEqual(keyboardTool.inputSchema.properties.key.type, ["string", "null"])
  assert.equal(keyboardTool.inputSchema.properties.key.minLength, 1)
  assert.equal(keyboardTool.inputSchema.properties.key.maxLength, 1)
  assert.equal(keyboardTool.inputSchema.properties.key.pattern, "^[\\u0001-\\u00FF]$")
  assert.equal(keyboardTool.annotations.idempotentHint, false)
  assert.match(keyboardTool.description, /null to release/)
  const clearBreakpointTool = tools.result.tools.find((tool) => tool.name === "clear_breakpoint")
  assert.deepEqual(clearBreakpointTool.inputSchema, {
    type: "object",
    properties: { address: { type: "integer", minimum: 0, maximum: 65535 } },
    required: ["address"],
    additionalProperties: false,
  })
  assert.equal(clearBreakpointTool.outputSchema.properties.value.properties.cleared.type, "boolean")
  assert.equal(clearBreakpointTool.annotations.destructiveHint, true)
  assert.equal(clearBreakpointTool.annotations.idempotentHint, true)
  const setCpuTool = tools.result.tools.find((tool) => tool.name === "set_cpu")
  assert.deepEqual(setCpuTool.inputSchema, {
    type: "object",
    properties: {
      PC: { type: "integer", minimum: 0, maximum: 65535 },
      A: { type: "integer", minimum: 0, maximum: 255 },
      X: { type: "integer", minimum: 0, maximum: 255 },
      Y: { type: "integer", minimum: 0, maximum: 255 },
      S: { type: "integer", minimum: 0, maximum: 255 },
      PStatus: { type: "integer", minimum: 0, maximum: 255 },
    },
    anyOf: ["PC", "A", "X", "Y", "S", "PStatus"].map((field) => ({ required: [field] })),
    additionalProperties: false,
  })

  const running = await sendMcpRequest(processState, "memory-running", "tools/call", {
    name: "resume",
    arguments: {},
  })
  assert.equal(running.result.isError, undefined, JSON.stringify(running))
  for (const [id, args, message] of [
    [
      "memory-running-omitted",
      {address: 0, length: 1},
      "Memory dump unavailable for the requested range. Pause the emulator first.",
    ],
    [
      "memory-running-active",
      {address: 0, length: 1, space: "active"},
      "Memory dump unavailable for the requested range. Pause the emulator first.",
    ],
    [
      "memory-running-main",
      {address: 0, length: 1, space: "main"},
      "Memory is available only while the emulator is paused",
    ],
  ]) {
    const rejected = await sendMcpRequest(processState, id, "tools/call", {
      name: "read_memory",
      arguments: args,
    })
    assert.equal(rejected.result.isError, true)
    assert.equal(rejected.result.structuredContent, undefined)
    assert.equal(rejected.result.content[0].text.includes(message), true)
  }
  const repaused = await sendMcpRequest(processState, "memory-repause", "tools/call", {
    name: "pause",
    arguments: {},
  })
  assert.equal(repaused.result.isError, undefined, JSON.stringify(repaused))

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "read_memory", arguments: { address: 65534, length: 2 } },
  })}\n`)
  const memory = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 5))
  assert.equal(memory.result.isError, undefined)
  assert.deepEqual(memory.result.structuredContent, {
    emulator: payload.emulator,
    value: {
      address: 65534,
      length: 2,
      bytes: [171, 205],
      requestedSpace: "active",
      effectiveSegments: [{address: 65534, length: 2, space: "system"}],
      mapping: {
        RAMRD: false,
        RAMWRT: false,
        ALTZP: false,
        "80STORE": false,
        PAGE2: false,
        HIRES: false,
      },
    },
  })
  assert.equal(memory.result.content[0].text, "Read 2 bytes from active memory at $FFFE.")

  const physical = await sendMcpRequest(processState, "physical-memory", "tools/call", {
    name: "read_memory",
    arguments: {address: 0x03A4, length: 1, space: "aux"},
  })
  assert.equal(physical.result.isError, undefined, JSON.stringify(physical))
  assert.deepEqual(physical.result.structuredContent.value, {
    address: 0x03A4,
    length: 1,
    bytes: [0x22],
    requestedSpace: "aux",
    effectiveAuxBank: 0,
    effectiveSegments: [{address: 0x03A4, length: 1, space: "aux", auxBank: 0}],
    mapping: {
      RAMRD: false,
      RAMWRT: false,
      ALTZP: false,
      "80STORE": false,
      PAGE2: false,
      HIRES: false,
    },
  })
  assert.equal(physical.result.content[0].text, "Read 1 byte from auxiliary RAM at $03A4.")

  const selectedPhysical = await sendMcpRequest(processState, "selected-physical-memory", "tools/call", {
    name: "read_memory",
    arguments: {address: 0x03A4, length: 1, space: "aux", auxBank: 0},
  })
  assert.equal(selectedPhysical.result.isError, undefined, JSON.stringify(selectedPhysical))
  assert.equal(selectedPhysical.result.structuredContent.value.requestedAuxBank, 0)
  assert.equal(selectedPhysical.result.structuredContent.value.effectiveAuxBank, 0)

  for (const args of [
    {address: 0xC000, length: 1, space: "main"},
    {address: 0xBFFF, length: 2, space: "aux"},
    {address: 0, length: 1, space: "main", auxBank: 0},
  ]) {
    const rejected = await sendMcpRequest(processState, `physical-reject-${JSON.stringify(args)}`, "tools/call", {
      name: "read_memory",
      arguments: args,
    })
    assert.equal(rejected.result.isError, true)
  }

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "read_memory", arguments: { address: 65535, length: 2 } },
  })}\n`)
  const invalidRange = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 6),
  )
  assert.equal(invalidRange.result.isError, true)
  assert.notEqual(invalidRange.result.content[0].text, "")

  const requestTool = async (id, name, args = {}) => {
    processState.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })}\n`)
    return JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === id))
  }
  const callTool = async (id, name, args = {}) => {
    const response = await requestTool(id, name, args)
    assert.equal(response.result.isError, undefined, JSON.stringify(response))
    return response.result.structuredContent
  }

  const screen = await requestTool(50, "capture_screen")
  assert.equal(screen.result.isError, undefined)
  assert.deepEqual(screen.result.content[0], {
    type: "image",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    mimeType: "image/png",
  })
  assert.deepEqual(screen.result.structuredContent, {
    emulator: payload.emulator,
    image: { mimeType: "image/png", width: 1, height: 1 },
  })
  assert.deepEqual(JSON.parse(screen.result.content[1].text), screen.result.structuredContent)

  const booted = await callTool(7, "boot")
  assert.equal(booted.state.runMode, "running")

  const paused = await callTool(8, "pause")
  assert.equal(paused.emulator.rendererId, rendererId)
  assert.equal(paused.state.runMode, "paused")

  const accelerated = await callTool(9, "set_speed", { speed: 4 })
  assert.equal(accelerated.state.runMode, "paused")
  assert.equal(accelerated.state.speedMode, 4)

  const emptyCpu = await requestTool(10, "set_cpu")
  assert.equal(emptyCpu.result.isError, true)
  assert.match(emptyCpu.result.content[0].text, /Input validation error/)

  const pcOnly = await callTool(11, "set_cpu", { PC: 0x6000 })
  assert.deepEqual(pcOnly, {
    emulator: payload.emulator,
    value: { PC: 0x6000, A: 0x41, X: 1, Y: 2, S: 0xff, PStatus: 0x20 },
  })

  const registers = await callTool(12, "set_cpu", { A: 0x11, X: 0x22, Y: 0x33, S: 0xf0 })
  assert.deepEqual(registers, {
    emulator: payload.emulator,
    value: { PC: 0x6000, A: 0x11, X: 0x22, Y: 0x33, S: 0xf0, PStatus: 0x20 },
  })

  const statusOnly = await callTool(13, "set_cpu", { PStatus: 0x24 })
  assert.deepEqual(statusOnly, {
    emulator: payload.emulator,
    value: { PC: 0x6000, A: 0x11, X: 0x22, Y: 0x33, S: 0xf0, PStatus: 0x24 },
  })

  const cpu = await callTool(14, "set_cpu", {
    PC: 0x6001,
    A: 0x44,
    X: 0x55,
    Y: 0x66,
    S: 0xef,
    PStatus: 0x20,
  })
  assert.deepEqual(cpu, {
    emulator: payload.emulator,
    value: { PC: 0x6001, A: 0x44, X: 0x55, Y: 0x66, S: 0xef, PStatus: 0x20 },
  })

  const breakpoint = await callTool(15, "set_breakpoint", { address: 0x6003 })
  assert.deepEqual(breakpoint, {
    emulator: payload.emulator,
    value: { address: 0x6003, breakpointId: "bp:24579" },
  })
  const occupied = await callTool(16, "set_breakpoint", { address: 0x6003 })
  assert.deepEqual(occupied, breakpoint)

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 150,
    method: "resources/read",
    params: { uri: "apple2ts://debugger/breakpoints" },
  })}\n`)
  const breakpointsRead = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 150),
  )
  const breakpointsPayload = JSON.parse(breakpointsRead.result.contents[0].text)
  assert.equal(breakpointsPayload.emulator.rendererId, rendererId)
  assert.deepEqual(breakpointsPayload.state.map(({ breakpointId, address }) => ({ breakpointId, address })), [
    { breakpointId: "bp:24579", address: 0x6003 },
  ])

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 151,
    method: "resources/read",
    params: { uri: "apple2ts://disks/current" },
  })}\n`)
  const drivesRead = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 151),
  )
  const drivesPayload = JSON.parse(drivesRead.result.contents[0].text)
  assert.equal(drivesPayload.emulator.rendererId, rendererId)
  assert.deepEqual(drivesPayload.state, [{
    driveId: "fd1",
    index: 0,
    kind: "floppy",
    mounted: true,
    filename: "fixture.woz",
    status: "mounted",
    writeProtected: true,
    dirty: false,
    motorRunning: false,
    byteLength: 143360,
  }])

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 152,
    method: "resources/read",
    params: { uri: "apple2ts://system/softswitches" },
  })}\n`)
  const softSwitchesRead = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 152),
  )
  const softSwitchesPayload = JSON.parse(softSwitchesRead.result.contents[0].text)
  assert.deepEqual(softSwitchesPayload, {
    emulator: payload.emulator,
    softswitches: {
      TEXT: false,
      MIXED: false,
      PAGE2: false,
      HIRES: true,
    },
  })

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 153,
    method: "resources/read",
    params: { uri: "apple2ts://video/text" },
  })}\n`)
  const textRead = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 153),
  )
  const textPayload = JSON.parse(textRead.result.contents[0].text)
  assert.deepEqual(textPayload, {
    emulator: payload.emulator,
    state: { textPage: "READY" },
  })
  await callTool(16, "set_breakpoint", { address: 0x6006 })
  const cleared = await callTool(17, "clear_breakpoint", { address: 0x6003 })
  assert.deepEqual(cleared.value, {
    address: 0x6003,
    breakpointId: "bp:24579",
    cleared: true,
  })
  const absent = await callTool(18, "clear_breakpoint", { address: 0x6003 })
  assert.equal(absent.value.cleared, false)
  const clearedAll = await callTool(19, "clear_all_breakpoints")
  assert.equal(clearedAll.value.count, 1)
  const clearedEmpty = await callTool(20, "clear_all_breakpoints")
  assert.equal(clearedEmpty.value.count, 0)

  const invalidBreakpoint = await requestTool(21, "set_breakpoint", { address: 65536 })
  assert.equal(invalidBreakpoint.result.isError, true)
  assert.match(invalidBreakpoint.result.content[0].text, /Input validation error/)

  const resumed = await callTool(22, "resume")
  assert.equal(resumed.state.runMode, "running")
  assert.equal(resumed.state.speedMode, 4)

  const reset = await callTool(23, "reset")
  assert.equal(reset.state.runMode, "running")
  assert.equal(reset.state.speedMode, 4)

  assert.equal((await callTool(24, "set_keyboard_key", { key: "j" })).value.heldKey, "j")
  assert.equal((await callTool(25, "set_keyboard_key", { key: "j", repeat: true })).value.heldKey, "j")
  assert.equal((await callTool(26, "set_keyboard_key", { key: "l" })).value.heldKey, "l")
  assert.equal((await callTool(27, "set_keyboard_key", { key: null })).value.heldKey, null)
  assert.equal((await callTool(28, "set_keyboard_key", { key: " " })).value.heldKey, " ")

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 29, method: "tools/call", params: { name: "stop_session", arguments: {} },
  })}\n`)
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "start_session", arguments: {} },
  })}\n`)
  const concurrentStop = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 29),
  )
  const concurrentStart = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 30),
  )
  assert.deepEqual(concurrentStop.result.structuredContent, { stopped: true })
  assert.equal(concurrentStart.result.isError, undefined, JSON.stringify(concurrentStart))
  assert.notEqual(
    concurrentStart.result.structuredContent.emulator.serverInstanceId,
    started.result.structuredContent.emulator.serverInstanceId,
  )
  const restartedReceipt = await processState.readReceipt()
  assert.notEqual(restartedReceipt.pid, receipt.pid)
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await waitForAbsent(receipt.profilePath)
  await assertClosed(bridgeUrl)

  const stopped = await callTool(31, "stop_session")
  assert.deepEqual(stopped, { stopped: true })
  assert.throws(() => process.kill(restartedReceipt.pid, 0), { code: "ESRCH" })
  await waitForAbsent(restartedReceipt.profilePath)

  processState.child.stdin.end()
  const processExit = await processState.waitForExit()
  assert.equal(processExit.error, null)
  assert.equal(processExit.code, 0, processState.getStderr())
  for (const line of processState.getStdout().trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line))
})

test("stdio exposes coherent execution state and waits for worker-confirmed stops", async (t) => {
  const processState = await launchMcp({
    APPLE2TS_FAKE_CHROMIUM_MODE: "execution-stop",
    APPLE2TS_FAKE_EXECUTION_STOP_DELAY_MS: "100",
  })
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready for session requests"))
  await initializeMcp(processState)
  const started = await startMcpSession(processState)
  assert.equal(started.result.isError, undefined, JSON.stringify(started))

  const call = (id, name, args = {}) => sendMcpRequest(processState, id, "tools/call", {
    name,
    arguments: args,
  })
  const readResource = async (id, uri) => {
    const response = await sendMcpRequest(processState, id, "resources/read", { uri })
    return JSON.parse(response.result.contents[0].text)
  }

  const initialExecution = await readResource("execution-initial", "apple2ts://session/execution")
  const setCpu = await call("execution-set-cpu", "set_cpu", { PC: 0x6010, PStatus: 0x20 })
  assert.equal(setCpu.result.isError, undefined, JSON.stringify(setCpu))
  const afterSetCpu = await readResource("execution-after-set-cpu", "apple2ts://session/execution")
  assert.equal(afterSetCpu.state.executionSequence, initialExecution.state.executionSequence)
  assert.equal(afterSetCpu.state.PC, 0x6010)
  assert.equal(afterSetCpu.state.PStatus, 0x20)

  assert.equal((await call("execution-breakpoint", "set_breakpoint", { address: 0x6003 })).result.isError, undefined)
  const before = await readResource("execution-before", "apple2ts://session/execution")
  assert.equal(before.state.state, "paused")

  const resumed = await call("execution-resume", "resume")
  assert.equal(resumed.result.structuredContent.state.runMode, "running")
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "execution-wait",
    method: "tools/call",
    params: {
      name: "wait_for_execution_stop",
      arguments: {
        timeoutMs: 1000,
        afterSequence: before.state.executionSequence,
        expectedBreakpointAddress: 0x6004,
      },
    },
  })}\n`)
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "execution-concurrent-read",
    method: "resources/read",
    params: { uri: "apple2ts://cpu" },
  })}\n`)
  const concurrentRead = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === "execution-concurrent-read"),
  )
  assert.equal(JSON.parse(concurrentRead.result.contents[0].text).state.PC, 0x6010)

  const waitedResponse = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === "execution-wait"),
  )
  assert.equal(waitedResponse.result.isError, undefined, JSON.stringify(waitedResponse))
  const waited = waitedResponse.result.structuredContent
  assert.equal(waited.outcome, "stopped")
  assert.equal(waited.expectationMatched, false)
  assert.ok(waited.state.executionSequence > before.state.executionSequence)
  assert.deepEqual(waited.state.breakpoint, { breakpointId: "bp:24579", address: 0x6003 })
  assert.equal(waited.state.PC, 0x6003)

  const after = await readResource("execution-after", "apple2ts://session/execution")
  assert.deepEqual(after, { emulator: waited.emulator, state: waited.state })
  const alreadyPaused = await call("execution-already-paused", "wait_for_execution_stop", { timeoutMs: 50 })
  assert.equal(alreadyPaused.result.structuredContent.outcome, "stopped")

  await call("execution-clear", "clear_all_breakpoints")
  await call("execution-resume-timeout", "resume")
  const running = await readResource("execution-running", "apple2ts://session/execution")
  const timedOut = await call("execution-timeout", "wait_for_execution_stop", {
    timeoutMs: 10,
    afterSequence: running.state.executionSequence,
  })
  assert.equal(timedOut.result.structuredContent.outcome, "timeout")
  assert.equal(timedOut.result.structuredContent.state.executionSequence, running.state.executionSequence)

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "execution-close-wait",
    method: "tools/call",
    params: {
      name: "wait_for_execution_stop",
      arguments: { timeoutMs: 1000, afterSequence: running.state.executionSequence },
    },
  })}\n`)
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: "execution-stop", method: "tools/call",
    params: { name: "stop_session", arguments: {} },
  })}\n`)
  const closedWait = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === "execution-close-wait"),
  )
  const stoppedSession = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === "execution-stop"),
  )
  assert.equal(closedWait.result.structuredContent.outcome, "session_closed")
  assert.deepEqual(stoppedSession.result.structuredContent, { stopped: true })
  assert.deepEqual((await call("execution-stop-again", "stop_session")).result.structuredContent, { stopped: false })
})

test("stdio cancellation aborts an execution wait without poisoning the session", async (t) => {
  const processState = await launchMcp()
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready for session requests"))
  await initializeMcp(processState)
  assert.equal((await startMcpSession(processState)).result.isError, undefined)
  const resumed = await sendMcpRequest(processState, "cancel-resume", "tools/call", {
    name: "resume",
    arguments: {},
  })
  assert.equal(resumed.result.isError, undefined)
  const running = await sendMcpRequest(processState, "cancel-read", "resources/read", {
    uri: "apple2ts://session/execution",
  })
  const sequence = JSON.parse(running.result.contents[0].text).state.executionSequence

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "cancel-wait",
    method: "tools/call",
    params: {
      name: "wait_for_execution_stop",
      arguments: {timeoutMs: 1000, afterSequence: sequence},
    },
  })}\n`)
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: {requestId: "cancel-wait", reason: "test cancellation"},
  })}\n`)

  const usable = await sendMcpRequest(processState, "cancel-usable", "resources/read", {
    uri: "apple2ts://session/execution",
  })
  assert.ok(Number.isInteger(JSON.parse(usable.result.contents[0].text).state.executionSequence))
  const stopped = await sendMcpRequest(processState, "cancel-stop", "tools/call", {
    name: "stop_session",
    arguments: {},
  })
  assert.deepEqual(stopped.result.structuredContent, {stopped: true})
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(
    processState.getStdout().split("\n").filter(Boolean)
      .some((line) => JSON.parse(line).id === "cancel-wait"),
    false,
  )
  assert.equal((await startMcpSession(processState, "cancel-restart")).result.isError, undefined)
})

test("real renderer reports the finite program stop atomically", {
  skip: !process.env.APPLE2TS_REAL_CHROMIUM_EXECUTABLE || !process.env.APPLE2TS_REAL_DIST_DIR,
}, async (t) => {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-execution-acceptance-"))
  const sourceRoot = path.join(taskRoot, "source")
  const chromiumTempRoot = path.join(taskRoot, "chromium")
  await Promise.all([
    mkdir(sourceRoot),
    mkdir(chromiumTempRoot),
  ])
  await writeFile(path.join(sourceRoot, "finite.bin"), Buffer.from([
    0xA2, 0xF0, 0x9A, // LDX #$F0; TXS
    0xA9, 0x41,       // LDA #$41
    0xA2, 0x42,       // LDX #$42
    0xA0, 0x43,       // LDY #$43
    0xEA, 0x00,       // success NOP; failure BRK
  ]))

  const processState = await launchMcp({
    APPLE2TS_CHROMIUM_EXECUTABLE: process.env.APPLE2TS_REAL_CHROMIUM_EXECUTABLE,
    APPLE2TS_DIST_DIR: process.env.APPLE2TS_REAL_DIST_DIR,
    APPLE2TS_STARTUP_TIMEOUT_MS: "10000",
    TMPDIR: chromiumTempRoot,
  })
  t.after(async () => {
    await processState.cleanup()
    await rm(taskRoot, { recursive: true, force: true })
  })
  await processState.waitForStderr((line) => line.includes("MCP ready for session requests"))
  await initializeMcp(processState)
  assert.equal((await startMcpSession(processState)).result.isError, undefined)
  const call = (id, name, args = {}) => sendMcpRequest(processState, id, "tools/call", {
    name,
    arguments: args,
  })
  const readExecution = async (id) => {
    const response = await sendMcpRequest(processState, id, "resources/read", {
      uri: "apple2ts://session/execution",
    })
    return JSON.parse(response.result.contents[0].text)
  }

  const prepared = (await call("real-prepare", "prepare_load_binary", {
    path: path.join(sourceRoot, "finite.bin"),
    address: 0x6000,
  })).result.structuredContent
  await runUpload(prepared.ticket)
  const beforeCpuPatch = await readExecution("real-before-cpu")
  await call("real-cpu", "set_cpu", { PC: 0x6000, PStatus: 0x24 })
  const afterCpuPatch = await readExecution("real-after-cpu")
  assert.equal(afterCpuPatch.state.executionSequence, beforeCpuPatch.state.executionSequence)
  assert.equal(afterCpuPatch.state.PC, 0x6000)
  assert.equal(afterCpuPatch.state.PStatus, 0x24)
  await call("real-success", "set_breakpoint", { address: 0x6009 })
  await call("real-failure", "set_breakpoint", { address: 0x600A })
  const before = await readExecution("real-before")
  await call("real-resume", "resume")
  const stopped = (await call("real-wait", "wait_for_execution_stop", {
    timeoutMs: 2000,
    afterSequence: before.state.executionSequence,
    expectedBreakpointAddress: 0x6009,
  })).result.structuredContent

  assert.equal(stopped.outcome, "stopped")
  assert.equal(stopped.expectationMatched, true)
  assert.ok(stopped.state.executionSequence > before.state.executionSequence)
  assert.equal(stopped.state.pauseReason, "breakpoint")
  assert.deepEqual(stopped.state.breakpoint, { breakpointId: "bp:24585", address: 0x6009 })
  assert.deepEqual(
    { A: stopped.state.A, X: stopped.state.X, Y: stopped.state.Y, S: stopped.state.S },
    { A: 0x41, X: 0x42, Y: 0x43, S: 0xF0 },
  )
  assert.deepEqual(await readExecution("real-after"), {
    emulator: stopped.emulator,
    state: stopped.state,
  })

  processState.child.stdin.end()
  assert.deepEqual(await processState.waitForExit(), { code: 0, signal: null, error: null })
  assert.deepEqual(await readdir(chromiumTempRoot), [])
})

test("EOF rejects a start queued behind session cleanup", async (t) => {
  const processState = await launchMcp()
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(processState, "shutdown-race-initialize")
  const started = await startMcpSession(processState, "shutdown-race-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const receipt = await processState.readReceipt()

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: "shutdown-race-stop", method: "tools/call", params: { name: "stop_session", arguments: {} },
  })}\n`)
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: "shutdown-race-restart", method: "tools/call", params: { name: "start_session", arguments: {} },
  })}\n`)
  processState.child.stdin.end()

  const exited = await processState.waitForExit()
  assert.equal(exited.code, 0, processState.getStderr())
  assert.equal((await processState.readReceipt()).pid, receipt.pid)
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await waitForAbsent(receipt.profilePath)
})

test("stdio rejects an invalid rendered screen", async (t) => {
  const processState = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "invalid-screen" })
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(processState, 1)
  const started = await startMcpSession(processState, "start-invalid-screen")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "capture_screen", arguments: {} },
  })}\n`)
  const response = JSON.parse(
    await processState.waitForStdout((line) => JSON.parse(line).id === 2),
  )
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /Rendered screen was not available/)

  processState.child.stdin.end()
  assert.equal((await processState.waitForExit()).code, 0)
})

test("EOF cancels a stalled mutation before releasing its held key", async (t) => {
  const processState = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "stall-run-mode" })
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(processState, 30)
  const started = await startMcpSession(processState, "start-stalled")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const bridgeLine = await processState.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const receipt = await processState.readReceipt()
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "set_keyboard_key", arguments: { key: "j" } },
  })}\n`)
  await processState.waitForStdout((line) => JSON.parse(line).id === 31)
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "pause", arguments: {} },
  })}\n`)

  const stallDeadline = Date.now() + 1000
  while (!(await processState.readReceipt()).stalledRunMode) {
    if (Date.now() >= stallDeadline) throw new Error("Timed out waiting for stalled mutation")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  processState.child.stdin.end()
  const outcome = await Promise.race([
    processState.waitForExit(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("EOF cleanup was not prompt")), 1000)),
  ])
  assert.equal(outcome.code, 0, processState.getStderr())
  assert.deepEqual((await processState.readReceipt()).keyboardStates, [
    { key: "j", isDown: true, repeat: false },
    { key: "j", isDown: false, repeat: false },
  ])
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(receipt.profilePath))
  await assertClosed(bridgeUrl)
})

test("stdio test cleanup escalates when its child ignores EOF", async (t) => {
  const wedged = await launchMcp({}, wedgedRunner)
  t.after(wedged.cleanup)
  await wedged.waitForStderr((line) => line === "test runner wedged")
  const childPid = wedged.child.pid
  const testRoot = path.dirname(wedged.receiptPath)

  await wedged.cleanup()

  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" })
  await assert.rejects(access(testRoot))
  await wedged.cleanup()
})

test("stdio advertises upload-ticket file tools and completes uploads", async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-mcp-disk-source-"))
  await writeFile(path.join(sourceRoot, "fixture.bin"), Buffer.from([0xA9, 0x42, 0x60]))
  await writeFile(path.join(sourceRoot, "eamon.hdv"), Buffer.from("ProDOS test disk"))
  const processState = await launchMcp({
    APPLE2TS_FAKE_CHROMIUM_HARD_DRIVE: "1",
  })
  t.after(processState.cleanup)
  try {
    await processState.waitForStderr((line) => line.includes("MCP ready"))
    await initializeMcp(processState, 1)
    const started = await startMcpSession(processState, "start-file-tools")
    assert.equal(started.result.isError, undefined, JSON.stringify(started))
    processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
    const tools = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 2))
    const loadTool = tools.result.tools.find((tool) => tool.name === "prepare_load_binary")
    assert.deepEqual(loadTool.inputSchema.properties.expectedSha256, {
      type: "string",
      pattern: "^[0-9A-Fa-f]{64}$",
    })
    assert.equal(
      loadTool.inputSchema.properties.path.description,
      "Absolute source file path read by apple2ts-upload.",
    )
    const mountTool = tools.result.tools.find((tool) => tool.name === "prepare_mount_disk")
    assert.deepEqual(mountTool.inputSchema, {
      type: "object",
      properties: {
        driveId: { type: "string", enum: ["hd1", "hd2", "fd1", "fd2"] },
        path: {
          type: "string",
          minLength: 1,
          description: "Absolute source file path read by apple2ts-upload.",
        },
        expectedSha256: { type: "string", pattern: "^[0-9A-Fa-f]{64}$" },
      },
      required: ["driveId", "path"],
      additionalProperties: false,
    })
    assert.equal(mountTool.annotations.destructiveHint, false)
    assert.equal(mountTool.annotations.idempotentHint, false)
    assert.match(mountTool.description, /Floppy images may be up to 2 MiB/)
    assert.match(mountTool.description, /hard-drive images may be up to 32 MiB/)
    assert.deepEqual(mountTool.outputSchema, {
      type: "object",
      properties: {
        ticket: { type: "string", minLength: 1 },
      },
      required: ["ticket"],
      additionalProperties: false,
    })

    const fixtureSha256 = createHash("sha256").update(Buffer.from([0xA9, 0x42, 0x60])).digest("hex")
    const prepareLoad = await sendMcpRequest(processState, "prepare-load", "tools/call", {
      name: "prepare_load_binary",
      arguments: {
        path: path.join(sourceRoot, "fixture.bin"),
        address: 0x6000,
        expectedSha256: fixtureSha256.toUpperCase(),
      },
    })
    assert.equal(prepareLoad.result.isError, undefined)
    const uploadedLoad = await runUpload(prepareLoad.result.structuredContent.ticket)
    assert.deepEqual(
      {
        address: JSON.parse(uploadedLoad.stdout).address,
        bytesWritten: JSON.parse(uploadedLoad.stdout).bytesWritten,
      },
      { address: 0x6000, bytesWritten: 3 },
    )

    const invalidDigest = await sendMcpRequest(processState, "invalid-digest", "tools/call", {
      name: "prepare_load_binary",
      arguments: {
        path: path.join(sourceRoot, "fixture.bin"),
        address: 0x6000,
        expectedSha256: "not-a-digest",
      },
    })
    assert.equal(invalidDigest.result.isError, true)

    const relativePath = await sendMcpRequest(processState, "relative-path", "tools/call", {
      name: "prepare_load_binary",
      arguments: { path: "fixture.bin", address: 0x6000 },
    })
    assert.equal(relativePath.result.isError, true)
    assert.match(relativePath.result.content[0].text, /absolute source file path/)

    const prepareMount = await sendMcpRequest(processState, "prepare-mount", "tools/call", {
      name: "prepare_mount_disk",
      arguments: { path: path.join(sourceRoot, "eamon.hdv"), driveId: "hd1" },
    })
    assert.equal(prepareMount.result.isError, undefined)
    const uploadedMount = await runUpload(prepareMount.result.structuredContent.ticket)
    assert.deepEqual(JSON.parse(uploadedMount.stdout).state, { driveId: "hd1", mounted: true })

    const ejectTool = tools.result.tools.find((tool) => tool.name === "eject_disk")
    assert.deepEqual(ejectTool.inputSchema, {
      type: "object",
      properties: {
        driveId: { type: "string", enum: ["hd1", "hd2", "fd1", "fd2"] },
      },
      required: ["driveId"],
      additionalProperties: false,
    })
    assert.equal(ejectTool.outputSchema.properties.state.type, "object")

    processState.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "eject_disk", arguments: { driveId: "hd1" } },
    })}\n`)
    const ejected = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 7))
    assert.equal(ejected.result.isError, undefined)
    assert.deepEqual(ejected.result.structuredContent.state, {
      driveId: "hd1",
      mounted: false,
    })

    processState.child.stdin.end()
    const outcome = await processState.waitForExit()
    assert.equal(outcome.code, 0, processState.getStderr())
  } finally {
    if (processState.child.exitCode === null) processState.child.kill("SIGTERM")
    await processState.waitForExit()
    await Promise.all([
      processState.cleanup(),
      rm(sourceRoot, { recursive: true, force: true }),
    ])
  }
})

test("visible Chromium uses the same owned session and cleanup", async (t) => {
  const visible = await launchMcp({ APPLE2TS_CHROMIUM_MODE: "visible" })
  t.after(visible.cleanup)
  await visible.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(visible, "visible-initialize")
  const started = await startMcpSession(visible, "visible-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const bridgeLine = await visible.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const receipt = await visible.readReceipt()

  assert.equal(receipt.headless, false)
  assert.doesNotThrow(() => process.kill(receipt.pid, 0))
  await access(receipt.profilePath)

  visible.child.stdin.end()
  const outcome = await visible.waitForExit()
  assert.equal(outcome.error, null)
  assert.equal(outcome.code, 0, visible.getStderr())
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(receipt.profilePath))
  await assertClosed(bridgeUrl)
  await visible.cleanup()
})

test("start_session selects visibility for each new owned session", async (t) => {
  const processState = await launchMcp()
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(processState, "visibility-initialize")

  const visible = await startMcpSession(processState, "visibility-visible", {
    visibility: "visible",
  })
  assert.equal(visible.result.isError, undefined, JSON.stringify(visible))
  assert.equal((await processState.readReceipt()).headless, false)

  const same = await startMcpSession(processState, "visibility-same")
  assert.deepEqual(same.result.structuredContent, visible.result.structuredContent)
  const mismatch = await startMcpSession(processState, "visibility-mismatch", {
    visibility: "headless",
  })
  assert.equal(mismatch.result.isError, true)
  assert.match(mismatch.result.content[0].text, /Stop the active visible session/)

  const stopped = await sendMcpRequest(processState, "visibility-stop", "tools/call", {
    name: "stop_session",
    arguments: {},
  })
  assert.deepEqual(stopped.result.structuredContent, { stopped: true })
  await rm(processState.receiptPath, { force: true })

  const headless = await startMcpSession(processState, "visibility-headless", {
    visibility: "headless",
  })
  assert.equal(headless.result.isError, undefined, JSON.stringify(headless))
  assert.equal((await processState.readReceipt()).headless, true)
})

test("start_session rejects conflicting visibility while a session starts", async (t) => {
  const processState = await launchMcp({
    APPLE2TS_FAKE_CHROMIUM_MODE: "disconnect-before-ready",
    APPLE2TS_TEST_RENDERER_DISCONNECT_GRACE_MS: "100",
  })
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(processState, "starting-visibility-initialize")

  const bridgeLine = processState.waitForStderr((line) => line.includes("private bridge listening"))
  const starting = startMcpSession(processState, "starting-visibility-visible", {
    visibility: "visible",
  })
  await bridgeLine
  const mismatch = await startMcpSession(processState, "starting-visibility-headless", {
    visibility: "headless",
  })
  assert.equal(mismatch.result.isError, true)
  assert.match(mismatch.result.content[0].text, /starting visible session/)
  assert.equal((await starting).result.isError, true)

  processState.child.stdin.end()
  assert.equal((await processState.waitForExit()).code, 0)
})

test("closing an owned visible renderer preserves its launcher receipt until exit", async (t) => {
  const eventRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-visible-close-event-"))
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-visible-close-source-"))
  const eventFile = path.join(eventRoot, "launcher-event.json")
  await writeFile(path.join(sourceRoot, "fixture.bin"), Buffer.from([0xA9, 0x42, 0x60]))
  const visible = await launchMcp({
    APPLE2TS_CHROMIUM_MODE: "visible",
    APPLE2TS_FAKE_CHROMIUM_MODE: "disconnect-after-load",
    APPLE2TS_TEST_RENDERER_DISCONNECT_GRACE_MS: "50",
    APPLE2TS_TEST_SESSION_EVENT_FILE: eventFile,
  })
  t.after(visible.cleanup)
  t.after(() => rm(eventRoot, { recursive: true, force: true }))
  t.after(() => rm(sourceRoot, { recursive: true, force: true }))

  await visible.waitForStderr((line) => line.includes("MCP ready"))
  const initialized = await initializeMcp(visible, "visible-close-initialize")
  assert.equal(initialized.result.capabilities.resources.subscribe, true)
  const started = await startMcpSession(visible, "visible-close-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const subscribed = await sendMcpRequest(visible, "visible-close-subscribe", "resources/subscribe", {
    uri: "apple2ts://session/lifecycle",
  })
  assert.deepEqual(subscribed.result, {})
  const bridgeLine = await visible.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const receipt = await visible.readReceipt()
  assert.equal(receipt.headless, false)

  const prepared = await sendMcpRequest(visible, "visible-close-prepare", "tools/call", {
    name: "prepare_load_binary",
    arguments: { path: path.join(sourceRoot, "fixture.bin"), address: 0x6000 },
  })
  assert.equal(prepared.result.isError, undefined, JSON.stringify(prepared))
  await runUpload(prepared.result.structuredContent.ticket)

  await visible.waitForStderr((line) => line.includes("renderer disconnected; stopping owned session"))
    .catch((error) => {
      throw new Error(`${error.message}\n${visible.getStderr()}`)
    })
  const lifecycleNotification = JSON.parse(await visible.waitForStdout((line) => {
    const message = JSON.parse(line)
    return message.method === "notifications/resources/updated"
      && message.params?.uri === "apple2ts://session/lifecycle"
  }).catch((error) => {
    throw new Error(`${error.message}\n${visible.getStderr()}\n${visible.getStdout()}`)
  }))
  assert.deepEqual(lifecycleNotification.params, { uri: "apple2ts://session/lifecycle" })
  await waitForAbsent(receipt.profilePath)
  await assertClosed(bridgeUrl)
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })

  const lifecycle = await sendMcpRequest(visible, "visible-close-lifecycle", "resources/read", {
    uri: "apple2ts://session/lifecycle",
  })
  assert.deepEqual(JSON.parse(lifecycle.result.contents[0].text), {
    sequence: 1,
    state: "closed",
    reason: "renderer_closed",
    cleanup: "complete",
    emulator: started.result.structuredContent.emulator,
  })
  await waitForPresent(eventFile)
  assert.deepEqual(JSON.parse(await readFile(eventFile, "utf8")), {
    version: 1,
    event: "browser-closed",
    sequence: 1,
    cleanup: "complete",
    reporting: "complete",
    emulator: started.result.structuredContent.emulator,
  })

  const alreadyStopped = await sendMcpRequest(visible, "visible-close-stop", "tools/call", {
    name: "stop_session",
    arguments: {},
  })
  assert.deepEqual(alreadyStopped.result.structuredContent, { stopped: false })

  const restarted = await startMcpSession(visible, "visible-close-restart")
  assert.equal(restarted.result.isError, true)
  assert.match(restarted.result.content[0].text, /unconsumed session event/)

  visible.child.stdin.end()
  const outcome = await visible.waitForExit()
  assert.equal(outcome.code, 0, visible.getStderr())
})

test("closing a visible renderer during startup releases its private resources", async (t) => {
  const interrupted = await launchMcp({
    APPLE2TS_CHROMIUM_MODE: "visible",
    APPLE2TS_FAKE_CHROMIUM_MODE: "disconnect-before-ready",
    APPLE2TS_TEST_RENDERER_DISCONNECT_GRACE_MS: "50",
  })
  t.after(interrupted.cleanup)
  await interrupted.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(interrupted, "visible-startup-close-initialize")
  const bridgeLinePromise = interrupted.waitForStderr((line) => line.includes("private bridge listening"))
  const startPromise = startMcpSession(interrupted, "visible-startup-close-start")
  const bridgeUrl = parseBridgeUrl(await bridgeLinePromise)
  const receipt = await interrupted.readReceipt()
  const started = await startPromise
  assert.equal(started.result.isError, true)
  assert.match(started.result.content[0].text, /Owned renderer disconnected during startup/)
  await waitForAbsent(receipt.profilePath)
  await assertClosed(bridgeUrl)
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })

  const stopped = await sendMcpRequest(interrupted, "visible-startup-close-stop", "tools/call", {
    name: "stop_session",
    arguments: {},
  })
  assert.deepEqual(stopped.result.structuredContent, { stopped: false })
  interrupted.child.stdin.end()
  const outcome = await interrupted.waitForExit()
  assert.equal(outcome.code, 0, interrupted.getStderr())
})

test("renderer disconnect reports a startup cleanup failure", async (t) => {
  const interrupted = await launchMcp({
    APPLE2TS_CHROMIUM_MODE: "visible",
    APPLE2TS_FAKE_CHROMIUM_MODE: "disconnect-before-ready-cleanup-failure",
    APPLE2TS_TEST_RENDERER_DISCONNECT_GRACE_MS: "50",
  })
  t.after(interrupted.cleanup)
  await interrupted.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(interrupted, "visible-cleanup-failure-initialize")
  const bridgeLinePromise = interrupted.waitForStderr((line) => line.includes("private bridge listening"))
  const startPromise = startMcpSession(interrupted, "visible-cleanup-failure-start")
  const bridgeUrl = parseBridgeUrl(await bridgeLinePromise)
  const receipt = await interrupted.readReceipt()
  const removeRetainedProfile = async () => {
    await chmod(receipt.profilePath, 0o700).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
    await rm(receipt.profilePath, { recursive: true, force: true })
  }
  t.after(removeRetainedProfile)
  const started = await startPromise
  assert.equal(started.result.isError, true)
  assert.match(started.result.content[0].text, /session cleanup failed/)
  await assertClosed(bridgeUrl)
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await access(receipt.profilePath)
  await removeRetainedProfile()

  interrupted.child.stdin.end()
  const outcome = await interrupted.waitForExit()
  assert.equal(outcome.code, 0, interrupted.getStderr())
})

test("invalid Chromium mode fails session start before launch", async (t) => {
  const invalid = await launchMcp({ APPLE2TS_CHROMIUM_MODE: "sideways" })
  t.after(invalid.cleanup)
  await invalid.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(invalid, "invalid-mode-initialize")
  const response = await startMcpSession(invalid, "invalid-mode-start")
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /APPLE2TS_CHROMIUM_MODE must be 'headless' or 'visible'/)
  await assert.rejects(access(invalid.receiptPath))
  invalid.child.stdin.end()
  assert.equal((await invalid.waitForExit()).code, 0)
  await invalid.cleanup()
})

test("missing browser build fails session start before private resources start", async (t) => {
  const missing = await launchMcp({ APPLE2TS_TEST_MISSING_BROWSER_BUILD: "1" })
  t.after(missing.cleanup)
  await missing.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(missing, "missing-build-initialize")
  const response = await startMcpSession(missing, "missing-build-start")
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /missing .*dist\/index\.html/)
  assert.match(response.result.content[0].text, /Build Apple2TS in its source repository/)
  assert.doesNotMatch(missing.getStderr(), /private bridge listening/)
  await assert.rejects(access(missing.receiptPath))
  missing.child.stdin.end()
  assert.equal((await missing.waitForExit()).code, 0)
  await missing.cleanup()
})

test("stdio launches from a selected Apple2TS build directory", async (t) => {
  const browserBuildDir = await mkdtemp(path.join(os.tmpdir(), "apple2ts-stdio-dist-test-"))
  t.after(() => rm(browserBuildDir, { recursive: true, force: true }))
  await writeFile(path.join(browserBuildDir, "index.html"), "selected build")

  const processState = await launchMcp({
    APPLE2TS_DIST_DIR: browserBuildDir,
    APPLE2TS_TEST_REQUIRE_BROWSER_BUILD: "1",
  })
  t.after(processState.cleanup)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(processState, "selected-build-initialize")
  const started = await startMcpSession(processState, "selected-build-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const receipt = await processState.readReceipt()
  assert.doesNotThrow(() => process.kill(receipt.pid, 0))

  processState.child.stdin.end()
  assert.equal((await processState.waitForExit()).code, 0, processState.getStderr())
  await assert.rejects(access(receipt.profilePath))
})

test("unexpected renderer exit publishes its receipt without file ingress", async (t) => {
  const eventRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-browser-failure-event-"))
  const eventFile = path.join(eventRoot, "launcher-event.json")
  const crashed = await launchMcp({
    APPLE2TS_FAKE_CHROMIUM_MODE: "crash-after-ready",
    APPLE2TS_TEST_SESSION_EVENT_FILE: eventFile,
  })
  t.after(crashed.cleanup)
  t.after(() => rm(eventRoot, { recursive: true, force: true }))
  await crashed.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(crashed, "crash-initialize")
  const started = await startMcpSession(crashed, "crash-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const bridgeLine = await crashed.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const receipt = await crashed.readReceipt()
  await crashed.waitForStderr((line) => line.includes("renderer exited unexpectedly"))
  assert.match(crashed.getStderr(), /renderer exited unexpectedly \(exit code 43\)/)
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await waitForAbsent(receipt.profilePath)
  await assertClosed(bridgeUrl)
  assert.deepEqual(JSON.parse(await readFile(eventFile, "utf8")), {
    version: 1,
    event: "browser-failed",
    sequence: 1,
    cleanup: "complete",
    reporting: "complete",
    emulator: started.result.structuredContent.emulator,
  })
  crashed.child.stdin.end()
  assert.equal((await crashed.waitForExit()).code, 0, crashed.getStderr())
  await crashed.cleanup()
})

test("clean visible browser exit reports an intentional renderer closure", async (t) => {
  const eventRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-browser-close-event-"))
  const eventFile = path.join(eventRoot, "launcher-event.json")
  const closed = await launchMcp({
    APPLE2TS_CHROMIUM_MODE: "visible",
    APPLE2TS_FAKE_CHROMIUM_MODE: "close-after-ready",
    APPLE2TS_TEST_SESSION_EVENT_FILE: eventFile,
  })
  t.after(closed.cleanup)
  t.after(() => rm(eventRoot, { recursive: true, force: true }))
  await closed.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(closed, "clean-close-initialize")
  const started = await startMcpSession(closed, "clean-close-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const bridgeLine = await closed.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const receipt = await closed.readReceipt()
  await closed.waitForStderr((line) => line.includes("visible browser closed"))
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await waitForAbsent(receipt.profilePath)
  await assertClosed(bridgeUrl)
  assert.deepEqual(JSON.parse(await readFile(eventFile, "utf8")), {
    version: 1,
    event: "browser-closed",
    sequence: 1,
    cleanup: "complete",
    reporting: "complete",
    emulator: started.result.structuredContent.emulator,
  })
  const lifecycle = await sendMcpRequest(closed, "clean-close-lifecycle", "resources/read", {
    uri: "apple2ts://session/lifecycle",
  })
  assert.deepEqual(JSON.parse(lifecycle.result.contents[0].text), {
    sequence: 1,
    state: "closed",
    reason: "renderer_closed",
    cleanup: "complete",
    emulator: started.result.structuredContent.emulator,
  })
  closed.child.stdin.end()
  assert.equal((await closed.waitForExit()).code, 0, closed.getStderr())
  await closed.cleanup()
})

test("renderer exit does not replace a receipt created after session start", async (t) => {
  const eventRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-browser-event-collision-"))
  const eventFile = path.join(eventRoot, "launcher-event.json")
  const existing = '{"owner":"launcher"}\n'
  const crashed = await launchMcp({
    APPLE2TS_FAKE_CHROMIUM_MODE: "crash-after-ready",
    APPLE2TS_TEST_SESSION_EVENT_FILE: eventFile,
  })
  t.after(crashed.cleanup)
  t.after(() => rm(eventRoot, { recursive: true, force: true }))
  await crashed.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(crashed, "event-collision-initialize")
  const started = await startMcpSession(crashed, "event-collision-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  await writeFile(eventFile, existing, { flag: "wx" })
  await crashed.waitForStderr((line) => line.includes("renderer exited unexpectedly"))
  await crashed.waitForStderr((line) => line.includes("MCP cleanup failed"))
  assert.equal(await readFile(eventFile, "utf8"), existing)

  crashed.child.stdin.end()
  assert.equal((await crashed.waitForExit()).code, 1, crashed.getStderr())
  await crashed.cleanup()
})

test("SIGTERM and startup timeout release the private listener", async (t) => {
  const running = await launchMcp()
  t.after(running.cleanup)
  await running.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(running, "signal-initialize")
  const started = await startMcpSession(running, "signal-start")
  assert.equal(started.result.isError, undefined, JSON.stringify(started))
  const bridgeLine = await running.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const runningReceipt = await running.readReceipt()
  running.child.kill("SIGTERM")
  const signalExit = await running.waitForExit()
  assert.equal(signalExit.error, null)
  assert.equal(signalExit.code, 0, running.getStderr())
  assert.throws(() => process.kill(runningReceipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(runningReceipt.profilePath))
  await assertClosed(bridgeUrl)
  await running.cleanup()

  const escalated = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "ignore-term" })
  t.after(escalated.cleanup)
  await escalated.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(escalated, "escalated-initialize")
  const escalatedStarted = await startMcpSession(escalated, "escalated-start")
  assert.equal(escalatedStarted.result.isError, undefined, JSON.stringify(escalatedStarted))
  const escalatedBridgeLine = await escalated.waitForStderr((line) => line.includes("private bridge listening"))
  const escalatedUrl = parseBridgeUrl(escalatedBridgeLine)
  const escalatedReceipt = await escalated.readReceipt()
  escalated.child.stdin.end()
  const escalatedExit = await escalated.waitForExit()
  assert.equal(escalatedExit.error, null)
  assert.equal(escalatedExit.code, 0, escalated.getStderr())
  assert.equal((await escalated.readReceipt()).sigtermSeen, true)
  assert.throws(() => process.kill(escalatedReceipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(escalatedReceipt.profilePath))
  await assertClosed(escalatedUrl)
  await escalated.cleanup()

  const failing = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "exit" })
  t.after(failing.cleanup)
  await failing.waitForStderr((line) => line.includes("MCP ready"))
  await initializeMcp(failing, "failing-initialize")
  const failedStart = await startMcpSession(failing, "failing-start")
  assert.equal(failedStart.result.isError, true)
  const failingReceipt = await failing.readReceipt()
  assert.match(failedStart.result.content[0].text, /Owned Chromium exited before readiness/)
  assert.throws(() => process.kill(failingReceipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(failingReceipt.profilePath))
  failing.child.stdin.end()
  assert.equal((await failing.waitForExit()).code, 0)
  await failing.cleanup()
})
