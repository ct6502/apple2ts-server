import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

import { Apple2tsCore } from "../server/mcp_stdio.mjs"
import { startApple2tsServer, stopApple2tsServer } from "../server/server.mjs"
import { statusFixture } from "./fixtures/status_fixture.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const fakeChromium = path.join(__dirname, "fixtures", "fake_chromium.mjs")
const mcpTestRunner = path.join(__dirname, "fixtures", "mcp_stdio_runner.mjs")
const wedgedRunner = path.join(__dirname, "fixtures", "wedged_runner.mjs")
const token = "test-private-token"
const controllerToken = "test-controller-token"
const rendererId = "test-renderer"
const cleanupGraceTimeoutMs = 5000
const cleanupKillTimeoutMs = 1000
const execFileAsync = promisify(execFile)

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
      APPLE2TS_BINARY_ROOT: "",
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
        ? { PC: body.PC, PStatus: body.PStatus }
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
  assert.deepEqual(cpu.value, { PC: 0x6000, PStatus: 0x20 })
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

test("configured binary loading validates and serializes one local file", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-binary-root-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  await writeFile(path.join(binaryRoot, "valid.bin"), Buffer.from([0xA9, 0x42, 0x60]))
  await writeFile(path.join(binaryRoot, "empty.bin"), Buffer.alloc(0))
  await writeFile(path.join(binaryRoot, "large.bin"), Buffer.alloc(0xC001))
  await mkdir(path.join(binaryRoot, "directory"))
  await symlink(path.join(binaryRoot, "valid.bin"), path.join(binaryRoot, "link.bin"))
  if (process.platform !== "win32") {
    await execFileAsync("mkfifo", [path.join(binaryRoot, "pipe.bin")])
  }

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
    await realpath(binaryRoot),
  )

  const [loaded, resumed] = await Promise.all([
    core.loadBinary({ path: "valid.bin", address: 0x6000 }),
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
  const invalidInputs = [
    { path: "", address: 0 },
    { path: path.join(binaryRoot, "valid.bin"), address: 0 },
    { path: "../valid.bin", address: 0 },
    { path: "link.bin", address: 0 },
    { path: "directory", address: 0 },
    { path: "empty.bin", address: 0 },
    { path: "large.bin", address: 0 },
    { path: "valid.bin", address: 0xBFFE },
    { path: "missing.bin", address: 0 },
  ]
  if (process.platform !== "win32") invalidInputs.push({ path: "pipe.bin", address: 0 })
  for (const input of invalidInputs) {
    await assert.rejects(core.loadBinary(input))
  }
  assert.equal(requestPaths.length, 2)
})

test("configured disk mounting reads a file added after root selection and serializes eject", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-disk-root-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  const bytes = Buffer.from("WOZ2\u00ff\n\r\n")

  const requests = []
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
    await realpath(binaryRoot),
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

  await assert.rejects(core.mountDisk({ driveId: "fd1", path: "fixture.woz" }))
  await writeFile(path.join(binaryRoot, "fixture.woz"), bytes)
  const mounted = await core.mountDisk({ driveId: "fd1", path: "fixture.woz" })
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

test("disk mutations reject drive state that does not confirm the requested result", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-disk-confirmation-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  await writeFile(path.join(binaryRoot, "fixture.woz"), Buffer.from("WOZ2\u00ff\n\r\n"))
  const resolvedRoot = await realpath(binaryRoot)
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
      resolvedRoot,
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
      createCore(state).mountDisk({ driveId: "fd1", path: "fixture.woz" }),
      /did not confirm disk mount for fd1/,
    )
  }
  await assert.rejects(
    createCore(driveState).ejectDisk("fd1"),
    /did not confirm disk eject for fd1/,
  )
})

test("confirmed invalid disk rejection leaves later eject usable", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-disk-rejection-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  await writeFile(path.join(binaryRoot, "invalid.woz"), Buffer.from("not a disk"))
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
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
    await realpath(binaryRoot),
  )
  core.request = async (pathname, options = {}) => {
    requestPaths.push(pathname)
    if (options.method === "POST") {
      const error = new Error("Apple2TS rejected invalid disk media")
      error.bridgeStatus = 400
      throw error
    }
    return { emulator: identity, state: emptyDrive }
  }

  await assert.rejects(
    core.mountDisk({ driveId: "fd2", path: "invalid.woz" }),
    /rejected invalid disk media/,
  )
  const ejected = await core.ejectDisk("fd2")

  assert.equal(ejected.state.mounted, false)
  assert.deepEqual(requestPaths, [
    "/api/drives/fd2/mount",
    "/api/drives/fd2",
    "/api/drives/fd2",
  ])
})

test("disk preflight failure preserves a held key", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-disk-preflight-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  const identity = { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" }
  const requests = []
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    identity,
    new AbortController().signal,
    await realpath(binaryRoot),
  )
  core.request = async (pathname, options = {}) => {
    requests.push({ pathname, body: options.body })
    return { emulator: identity, state: {} }
  }

  await core.setKeyboardKey("j")
  await assert.rejects(
    core.mountDisk({ driveId: "fd1", path: "missing.woz" }),
    /unavailable or unreadable/,
  )

  assert.equal(core.heldKey, "j")
  assert.deepEqual(requests, [{
    pathname: "/api/input/keys",
    body: { type: "keyState", key: "j", isDown: true, repeat: false },
  }])
})

test("aborted confirmed disk rejection releases a held key", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-disk-abort-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  await writeFile(path.join(binaryRoot, "invalid.woz"), Buffer.from("not a disk"))
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
    await realpath(binaryRoot),
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
  const mount = core.mountDisk({ driveId: "fd1", path: "invalid.woz" }, cancellation.signal)
  await started
  cancellation.abort()
  finishMount()
  await assert.rejects(mount, /rejected invalid disk media/)

  assert.equal(core.heldKey, null)
  assert.equal(requests.at(-1).pathname, "/api/input/keys")
  assert.equal(requests.at(-1).body.isDown, false)
  await assert.rejects(core.ejectDisk("fd1"), /restart this MCP session/)
})

test("unconfirmed mount rejection still poisons later mutations", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-disk-uncertain-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  await writeFile(path.join(binaryRoot, "invalid.woz"), Buffer.from("not a disk"))
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
    new AbortController().signal,
    await realpath(binaryRoot),
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
    core.mountDisk({ driveId: "fd2", path: "invalid.woz" }),
    /drive readback unavailable/,
  )
  await assert.rejects(core.ejectDisk("fd2"), /restart this MCP session/)
  assert.equal(requests, 2)
})

test("mount transport failure remains an uncertain mutation", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-disk-transport-"))
  t.after(() => rm(binaryRoot, { recursive: true, force: true }))
  await writeFile(path.join(binaryRoot, "fixture.woz"), Buffer.from("WOZ2\u00ff\n\r\n"))
  const core = new Apple2tsCore(
    "http://unused.test",
    controllerToken,
    { serverInstanceId: "server", rendererId, targetId: "server:test-renderer" },
    new AbortController().signal,
    await realpath(binaryRoot),
  )
  let requests = 0
  core.request = async () => {
    requests += 1
    throw new Error("transport timed out")
  }

  await assert.rejects(
    core.mountDisk({ driveId: "fd1", path: "fixture.woz" }),
    /transport timed out/,
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

test("stdio reads and controls one renderer and EOF cleans up", async (t) => {
  const processState = await launchMcp()
  t.after(processState.cleanup)
  const bridgeLine = await processState.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
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

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  })}\n`)
  await processState.waitForStdout((line) => JSON.parse(line).id === 1)
  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" })}\n`)
  const listed = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 2))
  assert.deepEqual(listed.result.resources.map((resource) => resource.uri), [
    "apple2ts://machine",
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
      "read_memory",
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
  assert.deepEqual(tools.result.tools[0].inputSchema, {
    type: "object",
    properties: {
      address: { type: "integer", minimum: 0, maximum: 65535 },
      length: { type: "integer", minimum: 1, maximum: 4096 },
    },
    required: ["address", "length"],
    additionalProperties: false,
  })
  assert.equal(tools.result.tools[0].outputSchema.type, "object")
  assert.deepEqual(tools.result.tools[0].outputSchema.properties.value.properties.bytes, {
    type: "array",
    items: { type: "integer", minimum: 0, maximum: 255 },
    minItems: 1,
    maxItems: 4096,
  })
  assert.deepEqual(tools.result.tools[0].annotations, {
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
      PStatus: { type: "integer", minimum: 0, maximum: 255 },
    },
    anyOf: [{ required: ["PC"] }, { required: ["PStatus"] }],
    additionalProperties: false,
  })

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
    value: { address: 65534, length: 2, bytes: [171, 205] },
  })
  assert.deepEqual(JSON.parse(memory.result.content[0].text), memory.result.structuredContent)

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
    assert.equal(response.result.isError, undefined)
    return response.result.structuredContent
  }

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
    value: { PC: 0x6000, PStatus: 0x20 },
  })

  const statusOnly = await callTool(12, "set_cpu", { PStatus: 0x24 })
  assert.deepEqual(statusOnly, {
    emulator: payload.emulator,
    value: { PC: 0x6000, PStatus: 0x24 },
  })

  const cpu = await callTool(13, "set_cpu", { PC: 0x6001, PStatus: 0x20 })
  assert.deepEqual(cpu, {
    emulator: payload.emulator,
    value: { PC: 0x6001, PStatus: 0x20 },
  })

  const breakpoint = await callTool(14, "set_breakpoint", { address: 0x6003 })
  assert.deepEqual(breakpoint, {
    emulator: payload.emulator,
    value: { address: 0x6003, breakpointId: "bp:24579" },
  })
  const occupied = await callTool(15, "set_breakpoint", { address: 0x6003 })
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

  processState.child.stdin.end()
  const processExit = await processState.waitForExit()
  assert.equal(processExit.error, null)
  assert.equal(processExit.code, 0, processState.getStderr())
  for (const line of processState.getStdout().trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line))
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  assert.deepEqual((await processState.readReceipt()).keyboardStates, [
    { key: "j", isDown: true, repeat: false },
    { key: "j", isDown: true, repeat: true },
    { key: "j", isDown: false, repeat: false },
    { key: "l", isDown: true, repeat: false },
    { key: "l", isDown: false, repeat: false },
    { key: " ", isDown: true, repeat: false },
    { key: " ", isDown: false, repeat: false },
  ])
  await assert.rejects(access(receipt.profilePath))
  await assertClosed(bridgeUrl)
})

test("EOF cancels a stalled mutation before releasing its held key", async (t) => {
  const processState = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "stall-run-mode" })
  t.after(processState.cleanup)
  const bridgeLine = await processState.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  await processState.waitForStderr((line) => line.includes("MCP ready"))
  const receipt = await processState.readReceipt()
  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 30,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  })}\n`)
  await processState.waitForStdout((line) => JSON.parse(line).id === 30)
  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
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

test("configured stdio advertises and loads a local binary", async (t) => {
  const binaryRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-mcp-binaries-"))
  await writeFile(path.join(binaryRoot, "fixture.bin"), Buffer.from([0xA9, 0x42, 0x60]))
  await writeFile(path.join(binaryRoot, "fixture.woz"), Buffer.from("WOZ2\u00ff\n\r\n"))
  const processState = await launchMcp({ APPLE2TS_BINARY_ROOT: binaryRoot })
  t.after(processState.cleanup)
  try {
    await processState.waitForStderr((line) => line.includes("MCP ready"))
    processState.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    })}\n`)
    await processState.waitForStdout((line) => JSON.parse(line).id === 1)
    processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`)
    const tools = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 2))
    assert.ok(tools.result.tools.some((tool) => tool.name === "load_binary"))
    const mountTool = tools.result.tools.find((tool) => tool.name === "mount_disk")
    assert.deepEqual(mountTool.inputSchema, {
      type: "object",
      properties: {
        driveId: { type: "string", enum: ["fd1", "fd2"] },
        path: { type: "string", minLength: 1 },
      },
      required: ["driveId", "path"],
      additionalProperties: false,
    })
    assert.equal(mountTool.annotations.destructiveHint, true)
    assert.equal(mountTool.annotations.idempotentHint, false)
    assert.deepEqual(mountTool.outputSchema.properties.state, {
      type: "object",
      properties: {
        driveId: { type: "string", enum: ["fd1", "fd2"] },
        mounted: { type: "boolean" },
      },
      required: ["driveId", "mounted"],
      additionalProperties: false,
    })

    processState.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "load_binary", arguments: { path: "fixture.bin", address: 0x6000 } },
    })}\n`)
    const loaded = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 3))
    assert.equal(loaded.result.isError, undefined)
    assert.equal(loaded.result.structuredContent.emulator.rendererId, rendererId)
    assert.equal(loaded.result.structuredContent.address, 0x6000)
    assert.equal(loaded.result.structuredContent.bytesWritten, 3)
    assert.equal(loaded.result.structuredContent.sha256.length, 64)

    processState.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "mount_disk", arguments: { driveId: "fd1", path: "fixture.woz" } },
    })}\n`)
    const mounted = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 4))
    assert.equal(mounted.result.isError, undefined)
    assert.deepEqual(mounted.result.structuredContent.state, {
      driveId: "fd1",
      mounted: true,
    })

    processState.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "eject_disk", arguments: { driveId: "fd1" } },
    })}\n`)
    const ejected = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === 5))
    assert.equal(ejected.result.isError, undefined)
    assert.deepEqual(ejected.result.structuredContent.state, {
      driveId: "fd1",
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
      rm(binaryRoot, { recursive: true, force: true }),
    ])
  }
})

test("visible Chromium uses the same owned session and cleanup", async (t) => {
  const visible = await launchMcp({ APPLE2TS_CHROMIUM_MODE: "visible" })
  t.after(visible.cleanup)
  const bridgeLine = await visible.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  await visible.waitForStderr((line) => line.includes("MCP ready"))
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

test("invalid Chromium mode fails before launch", async (t) => {
  const invalid = await launchMcp({ APPLE2TS_CHROMIUM_MODE: "sideways" })
  t.after(invalid.cleanup)
  const outcome = await invalid.waitForExit()

  assert.equal(outcome.error, null)
  assert.equal(outcome.code, 1)
  assert.match(invalid.getStderr(), /APPLE2TS_CHROMIUM_MODE must be 'headless' or 'visible'/)
  assert.equal(invalid.getStdout(), "")
  await invalid.cleanup()
})

test("missing browser build fails before private resources start", async (t) => {
  const missing = await launchMcp({ APPLE2TS_TEST_MISSING_BROWSER_BUILD: "1" })
  t.after(missing.cleanup)
  const outcome = await missing.waitForExit()

  assert.equal(outcome.error, null)
  assert.equal(outcome.code, 1)
  assert.match(missing.getStderr(), /missing dist\/index\.html/)
  assert.match(missing.getStderr(), /Build Apple2TS in its source repository/)
  assert.doesNotMatch(missing.getStderr(), /private bridge listening/)
  assert.equal(missing.getStdout(), "")
  await assert.rejects(access(missing.receiptPath))
  await missing.cleanup()
})

test("invalid binary root fails before private resources start", async (t) => {
  const missingRoot = path.join(os.tmpdir(), `apple2ts-missing-binary-root-${process.pid}`)
  const invalid = await launchMcp({ APPLE2TS_BINARY_ROOT: missingRoot })
  t.after(invalid.cleanup)
  const outcome = await invalid.waitForExit()

  assert.equal(outcome.error, null)
  assert.equal(outcome.code, 1)
  assert.match(invalid.getStderr(), /APPLE2TS_BINARY_ROOT must name a readable directory/)
  assert.doesNotMatch(invalid.getStderr(), /private bridge listening/)
  assert.equal(invalid.getStdout(), "")
  await invalid.cleanup()
})

test("unexpected renderer exit closes stdio and owned resources", async (t) => {
  const crashed = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "crash-after-ready" })
  t.after(crashed.cleanup)
  const bridgeLine = await crashed.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  await crashed.waitForStderr((line) => line.includes("MCP ready"))
  const receipt = await crashed.readReceipt()
  const outcome = await crashed.waitForExit()

  assert.equal(outcome.error, null)
  assert.equal(outcome.code, 1)
  assert.match(crashed.getStderr(), /renderer exited unexpectedly \(exit code 43\)/)
  assert.equal(crashed.getStdout(), "")
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(receipt.profilePath))
  await assertClosed(bridgeUrl)
  await crashed.cleanup()
})

test("SIGTERM and startup timeout release the private listener", async (t) => {
  const running = await launchMcp()
  t.after(running.cleanup)
  const bridgeLine = await running.waitForStderr((line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  await running.waitForStderr((line) => line.includes("MCP ready"))
  const runningReceipt = await running.readReceipt()
  running.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "discover-1",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  })}\n`)
  const discovery = JSON.parse(
    await running.waitForStdout((line) => JSON.parse(line).id === "discover-1"),
  )
  assert.deepEqual(discovery.result.supportedVersions, ["2026-07-28"])
  assert.ok(discovery.result.capabilities.resources)
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
  const escalatedBridgeLine = await escalated.waitForStderr((line) => line.includes("private bridge listening"))
  const escalatedUrl = parseBridgeUrl(escalatedBridgeLine)
  await escalated.waitForStderr((line) => line.includes("MCP ready"))
  const escalatedReceipt = await escalated.readReceipt()
  escalated.child.stdin.end()
  const escalatedExit = await escalated.waitForExit()
  assert.equal(escalatedExit.error, null)
  assert.equal(escalatedExit.code, 0, escalated.getStderr())
  assert.equal((await escalated.readReceipt()).sigtermSeen, true)
  assert.equal(escalated.getStdout(), "")
  assert.throws(() => process.kill(escalatedReceipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(escalatedReceipt.profilePath))
  await assertClosed(escalatedUrl)
  await escalated.cleanup()

  const failing = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "exit" })
  t.after(failing.cleanup)
  const failingBridgeLine = await failing.waitForStderr((line) => line.includes("private bridge listening"))
  const failingUrl = parseBridgeUrl(failingBridgeLine)
  const failingReceipt = await failing.readReceipt()
  const failureExit = await failing.waitForExit()
  assert.equal(failureExit.error, null)
  assert.equal(failureExit.code, 1)
  assert.match(failing.getStderr(), /startup failed: Owned Chromium exited before readiness/)
  assert.equal(failing.getStdout(), "")
  assert.throws(() => process.kill(failingReceipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(failingReceipt.profilePath))
  await assertClosed(failingUrl)
  await failing.cleanup()
})
