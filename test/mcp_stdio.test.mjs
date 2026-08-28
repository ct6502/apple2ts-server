import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { Apple2tsCore } from "../server/mcp_stdio.mjs"
import { startApple2tsServer, stopApple2tsServer } from "../server/server.mjs"
import { statusFixture } from "./fixtures/status_fixture.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const fakeChromium = path.join(__dirname, "fixtures", "fake_chromium.mjs")
const mcpTestRunner = path.join(__dirname, "fixtures", "mcp_stdio_runner.mjs")
const token = "test-private-token"
const controllerToken = "test-controller-token"
const rendererId = "test-renderer"

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

const launchMcp = async (overrides = {}) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "apple2ts-mcp-test-"))
  const receiptPath = path.join(testRoot, "chromium.json")
  const child = spawn(process.execPath, [mcpTestRunner], {
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
    cleanup: () => rm(testRoot, { recursive: true, force: true }),
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

test("machine changes wait for prior callers and the mutation deadline", async (t) => {
  let activeRequests = 0
  let maxActiveRequests = 0
  const bridge = createServer(async (req, res) => {
    activeRequests += 1
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { speedMode } = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (speedMode === 4) await new Promise((resolve) => setTimeout(resolve, 2100))
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: true, data: { runMode: "paused", speedMode } }))
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

  const [accelerated, normalized] = await Promise.all([core.setSpeed(4), core.setSpeed(0)])
  assert.equal(maxActiveRequests, 1)
  assert.equal(accelerated.state.speedMode, 4)
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

test("stdio reads and controls one renderer and EOF cleans up", async () => {
  const processState = await launchMcp()
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
  assert.deepEqual(listed.result.resources.map((resource) => resource.uri), ["apple2ts://machine", "apple2ts://cpu"])

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
    ["read_memory", "boot", "reset", "pause", "resume", "set_speed"],
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

  const callTool = async (id, name, args = {}) => {
    processState.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })}\n`)
    const response = JSON.parse(await processState.waitForStdout((line) => JSON.parse(line).id === id))
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

  const resumed = await callTool(10, "resume")
  assert.equal(resumed.state.runMode, "running")
  assert.equal(resumed.state.speedMode, 4)

  const reset = await callTool(11, "reset")
  assert.equal(reset.state.runMode, "running")
  assert.equal(reset.state.speedMode, 4)

  processState.child.stdin.end()
  const processExit = await processState.waitForExit()
  assert.equal(processExit.error, null)
  assert.equal(processExit.code, 0, processState.getStderr())
  for (const line of processState.getStdout().trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line))
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" })
  await assert.rejects(access(receipt.profilePath))
  await assertClosed(bridgeUrl)
  await processState.cleanup()
})

test("visible Chromium uses the same owned session and cleanup", async () => {
  const visible = await launchMcp({ APPLE2TS_CHROMIUM_MODE: "visible" })
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

test("invalid Chromium mode fails before launch", async () => {
  const invalid = await launchMcp({ APPLE2TS_CHROMIUM_MODE: "sideways" })
  const outcome = await invalid.waitForExit()

  assert.equal(outcome.error, null)
  assert.equal(outcome.code, 1)
  assert.match(invalid.getStderr(), /APPLE2TS_CHROMIUM_MODE must be 'headless' or 'visible'/)
  assert.equal(invalid.getStdout(), "")
  await invalid.cleanup()
})

test("missing browser build fails before private resources start", async () => {
  const missing = await launchMcp({ APPLE2TS_TEST_MISSING_BROWSER_BUILD: "1" })
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

test("unexpected renderer exit closes stdio and owned resources", async () => {
  const crashed = await launchMcp({ APPLE2TS_FAKE_CHROMIUM_MODE: "crash-after-ready" })
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

test("SIGTERM and startup timeout release the private listener", async () => {
  const running = await launchMcp()
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
