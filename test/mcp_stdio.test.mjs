import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { startApple2tsServer, stopApple2tsServer } from "../server/server.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")
const token = "test-private-token"
const rendererId = "test-renderer"

const statusFixture = {
  machine: {
    runMode: -2,
    speedMode: 1,
    machineName: "APPLE2EE",
    ramWorksKb: 64,
    isDebugging: true,
    showDebugTab: false,
    textPage: "READY",
    machineState: {
      PC: 768,
      Accum: 65,
      XReg: 1,
      YReg: 2,
      StackPtr: 255,
      flagIRQ: 0,
      flagNMI: false,
      PStatus: 32,
      cycleCount: 1234,
    },
  },
  drives: [],
}

const postJson = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

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

const waitForLine = (stream, predicate, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    let buffer = ""
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for process output")), timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString("utf8")
      const lines = buffer.split("\n")
      buffer = lines.pop()
      for (const line of lines) {
        if (predicate(line)) {
          finish(null, line)
          return
        }
      }
    }
    const finish = (error, value) => {
      clearTimeout(timeout)
      stream.off("data", onData)
      if (error) reject(error)
      else resolve(value)
    }
    stream.on("data", onData)
  })

const launchMcp = (overrides = {}) => {
  const child = spawn(process.execPath, ["server/mcp_stdio.mjs"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      APPLE2TS_PRIVATE_PORT: "0",
      APPLE2TS_REMOTE_CONTROL_TOKEN: token,
      APPLE2TS_RENDERER_ID: rendererId,
      APPLE2TS_STARTUP_TIMEOUT_MS: "3000",
      ...overrides,
    },
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")))
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")))
  return { child, getStdout: () => stdout, getStderr: () => stderr }
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
    privateRenderer: { remoteControlToken: token, rendererId },
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

  const machineRequest = fetch(new URL("/api/machine", listener.url))
  const command = await renderer.nextCommand()
  const forged = await renderer.reply(command, { remoteControlToken: "wrong" })
  assert.equal(forged.status, 403)
  const accepted = await renderer.reply(command)
  assert.equal(accepted.status, 200)
  const machine = await machineRequest.then((response) => response.json())
  assert.equal(machine.data.machineName, "APPLE2EE")
})

test("stdio discovery and reads use one renderer and EOF cleans up", async () => {
  const processState = launchMcp()
  const bridgeLine = await waitForLine(processState.child.stderr, (line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const renderer = await connectFakeRenderer(bridgeUrl)
  await waitForLine(processState.child.stderr, (line) => line.includes("MCP ready"))

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
  await waitForLine(processState.child.stdout, (line) => JSON.parse(line).id === 1)
  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  processState.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" })}\n`)
  const listed = JSON.parse(await waitForLine(processState.child.stdout, (line) => JSON.parse(line).id === 2))
  assert.deepEqual(listed.result.resources.map((resource) => resource.uri), ["apple2ts://machine", "apple2ts://cpu"])

  processState.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: "apple2ts://cpu" },
  })}\n`)
  const read = JSON.parse(await waitForLine(processState.child.stdout, (line) => JSON.parse(line).id === 3))
  const payload = JSON.parse(read.result.contents[0].text)
  assert.equal(payload.emulator.rendererId, rendererId)
  assert.equal(payload.state.PC, 768)

  processState.child.stdin.end()
  const [exitCode] = await once(processState.child, "exit")
  assert.equal(exitCode, 0, processState.getStderr())
  for (const line of processState.getStdout().trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line))
  await renderer.stop()
  await assertClosed(bridgeUrl)
})

test("SIGTERM and startup timeout release the private listener", async () => {
  const running = launchMcp()
  const bridgeLine = await waitForLine(running.child.stderr, (line) => line.includes("private bridge listening"))
  const bridgeUrl = parseBridgeUrl(bridgeLine)
  const renderer = await connectFakeRenderer(bridgeUrl)
  await waitForLine(running.child.stderr, (line) => line.includes("MCP ready"))
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
    await waitForLine(running.child.stdout, (line) => JSON.parse(line).id === "discover-1"),
  )
  assert.deepEqual(discovery.result.supportedVersions, ["2026-07-28"])
  assert.ok(discovery.result.capabilities.resources)
  running.child.kill("SIGTERM")
  const [signalExitCode] = await once(running.child, "exit")
  assert.equal(signalExitCode, 0, running.getStderr())
  await renderer.stop()
  await assertClosed(bridgeUrl)

  const failing = launchMcp({ APPLE2TS_STARTUP_TIMEOUT_MS: "100" })
  const failingBridgeLine = await waitForLine(failing.child.stderr, (line) => line.includes("private bridge listening"))
  const failingUrl = parseBridgeUrl(failingBridgeLine)
  const [failureExitCode] = await once(failing.child, "exit")
  assert.equal(failureExitCode, 1)
  assert.match(failing.getStderr(), /startup failed: Timed out/)
  assert.equal(failing.getStdout(), "")
  await assertClosed(failingUrl)
})
