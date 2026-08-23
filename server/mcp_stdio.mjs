#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

import { startApple2tsServer, stopApple2tsServer } from "./server.mjs"

const SERVER_NAME = "apple2ts"
const SERVER_VERSION = "0.1.0"
const DEFAULT_STARTUP_TIMEOUT_MS = 10000

const sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error("Startup cancelled"))
      return
    }
    const finish = (callback) => {
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const timeout = setTimeout(() => finish(resolve), milliseconds)
    const onAbort = () => {
      clearTimeout(timeout)
      finish(() => reject(signal.reason || new Error("Startup cancelled")))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

const fetchEnvelope = async (baseUrl, pathname, signal) => {
  const response = await fetch(new URL(pathname, baseUrl), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    const detail = payload?.error?.code || payload?.error || `HTTP ${response.status}`
    throw new Error(`Apple2TS bridge request ${pathname} failed: ${detail}`)
  }
  return payload.data
}

export class Apple2tsObservationCore {
  constructor(baseUrl, signal = new AbortController().signal) {
    this.baseUrl = baseUrl
    this.signal = signal
  }

  async read(pathname) {
    const [identity, state] = await Promise.all([
      fetchEnvelope(this.baseUrl, "/api/control/identity", this.signal),
      fetchEnvelope(this.baseUrl, pathname, this.signal),
    ])
    return { emulator: identity, state }
  }

  readMachine() {
    return this.read("/api/machine")
  }

  readCpu() {
    return this.read("/api/debug/cpu")
  }
}

export const createMcpServer = (core) => {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  server.registerResource(
    "machine",
    "apple2ts://machine",
    {
      title: "Apple2TS machine state",
      description: "Current state of the emulator bound to this process.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await core.readMachine()) }],
    }),
  )

  server.registerResource(
    "cpu",
    "apple2ts://cpu",
    {
      title: "Apple2TS CPU state",
      description: "Current CPU state of the emulator bound to this process.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await core.readCpu()) }],
    }),
  )

  return server
}

const waitForRenderer = async (core, timeoutMs, signal) => {
  const deadline = Date.now() + timeoutMs
  let lastError = new Error("Renderer has not connected")

  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason
    try {
      await Promise.all([core.readMachine(), core.readCpu()])
      return
    } catch (error) {
      lastError = error
      await sleep(50, signal)
    }
  }

  throw new Error(`Timed out waiting for the private renderer: ${lastError.message}`)
}

export const runStdio = async (options = {}) => {
  const shutdownController = new AbortController()
  const remoteControlToken = options.remoteControlToken || randomBytes(32).toString("base64url")
  const rendererId = options.rendererId || randomUUID()
  const startupTimeoutMs = Number(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
  let stdioHandle = null
  let listenerPromise = Promise.resolve()
  let stopping = null

  const shutdown = (reason) => {
    if (stopping) return stopping
    stopping = (async () => {
      shutdownController.abort(new Error(reason))
      await listenerPromise.catch(() => {})
      await stdioHandle?.close()
      await stopApple2tsServer()
    })()
    return stopping
  }

  const onStdinEnd = () => void shutdown("MCP stdin closed").catch(reportFatal)
  const onSigint = () => void shutdown("Received SIGINT").catch(reportFatal)
  const onSigterm = () => void shutdown("Received SIGTERM").catch(reportFatal)
  const reportFatal = (error) => {
    process.stderr.write(`Apple2TS MCP cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }

  process.stdin.once("end", onStdinEnd)
  process.stdin.once("close", onStdinEnd)
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  try {
    listenerPromise = startApple2tsServer({
      host: "127.0.0.1",
      port: Number(options.port ?? 0),
      privateRenderer: { remoteControlToken, rendererId },
      logger: { log: (message) => process.stderr.write(`${message}\n`) },
    })
    const listener = await listenerPromise
    const core = new Apple2tsObservationCore(listener.url, shutdownController.signal)

    process.stderr.write(`Apple2TS MCP private bridge listening at ${listener.url}; waiting for renderer ${rendererId}.\n`)
    await waitForRenderer(core, startupTimeoutMs, shutdownController.signal)
    if (shutdownController.signal.aborted) return

    stdioHandle = serveStdio(() => createMcpServer(core), {
      onerror: (error) => process.stderr.write(`Apple2TS MCP protocol error: ${error.message}\n`),
    })
    process.stderr.write(`Apple2TS MCP ready for renderer ${rendererId}.\n`)
  } catch (error) {
    if (!shutdownController.signal.aborted) {
      process.stderr.write(`Apple2TS MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
    await shutdown("Startup ended")
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  void runStdio({
    port: process.env.APPLE2TS_PRIVATE_PORT,
    remoteControlToken: process.env.APPLE2TS_REMOTE_CONTROL_TOKEN,
    rendererId: process.env.APPLE2TS_RENDERER_ID,
    startupTimeoutMs: process.env.APPLE2TS_STARTUP_TIMEOUT_MS,
  })
}
