#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

import { startApple2tsServer, stopApple2tsServer } from "./server.mjs"

const SERVER_NAME = "apple2ts"
const SERVER_VERSION = "0.1.0"
const DEFAULT_STARTUP_TIMEOUT_MS = 10000
const BROWSER_EXIT_TIMEOUT_MS = 2000
const CHILD_STDERR_LIMIT = 8192

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

const fetchEnvelope = async (baseUrl, pathname, controllerToken, signal) => {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { Authorization: `Bearer ${controllerToken}` },
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
  constructor(baseUrl, controllerToken, identity, signal = new AbortController().signal) {
    this.baseUrl = baseUrl
    this.controllerToken = controllerToken
    this.identity = identity
    this.signal = signal
  }

  async read(pathname) {
    const state = await fetchEnvelope(this.baseUrl, pathname, this.controllerToken, this.signal)
    return { emulator: this.identity, state }
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

const waitFor = (promise, timeoutMs) =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    promise.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })

const launchChromium = async ({ executable, bridgeUrl, remoteControlToken, rendererId, mode }) => {
  if (!executable) throw new Error("APPLE2TS_CHROMIUM_EXECUTABLE is required")
  await access(executable, fsConstants.X_OK)

  const profilePath = await mkdtemp(path.join(os.tmpdir(), "apple2ts-mcp-chromium-"))
  const launchUrl = new URL("/", bridgeUrl)
  launchUrl.searchParams.set("remoteControl", "1")
  launchUrl.searchParams.set("remoteControlToken", remoteControlToken)
  launchUrl.searchParams.set("rendererId", rendererId)

  let child
  try {
    const modeArguments = mode === "headless" ? ["--headless=new"] : []
    child = spawn(
      executable,
      [
        ...modeArguments,
        "--disable-background-networking",
        "--no-default-browser-check",
        "--no-first-run",
        `--user-data-dir=${profilePath}`,
        launchUrl.href,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
  } catch (error) {
    await rm(profilePath, { recursive: true, force: true })
    throw error
  }

  let childStderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => {
    if (childStderr.length >= CHILD_STDERR_LIMIT) return
    childStderr += chunk.slice(0, CHILD_STDERR_LIMIT - childStderr.length)
  })

  let childError = null
  child.once("error", (error) => {
    childError = error
  })
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ error: childError, code, signal }))
  })
  let exitOutcome = null
  void exited.then((outcome) => {
    exitOutcome = outcome
  })
  let stopped = false

  return {
    profilePath,
    exited,
    async stop() {
      if (stopped) return
      stopped = true
      let failure = null
      let exitConfirmed = exitOutcome !== null
      try {
        if (!exitConfirmed && (child.exitCode !== null || child.signalCode !== null)) {
          exitConfirmed = await waitFor(exited, BROWSER_EXIT_TIMEOUT_MS)
        }
        if (!exitConfirmed && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM")
          exitConfirmed = await waitFor(exited, BROWSER_EXIT_TIMEOUT_MS)
          if (!exitConfirmed) {
            child.kill("SIGKILL")
            exitConfirmed = await waitFor(exited, BROWSER_EXIT_TIMEOUT_MS)
            if (!exitConfirmed) {
              failure = new Error(
                `Owned Chromium did not exit after SIGTERM and SIGKILL; retained profile ${profilePath}`,
              )
            }
          }
        }
        if (exitConfirmed) {
          const outcome = exitOutcome || await exited
          if (outcome.error && !failure) failure = outcome.error
        } else {
          child.stderr.destroy()
          child.unref()
        }
      } finally {
        if (exitConfirmed) {
          try {
            await rm(profilePath, { recursive: true, force: true })
          } catch (error) {
            if (!failure) failure = error
          }
        }
      }
      if (failure) throw failure
    },
    describeExit(outcome) {
      const detail = outcome.error
        ? outcome.error.message
        : outcome.signal
          ? `signal ${outcome.signal}`
          : `exit code ${outcome.code}`
      const stderrDetail = childStderr.trim() ? `: ${childStderr.trim()}` : ""
      return `${detail}${stderrDetail}`
    },
  }
}

export const runStdio = async (options = {}) => {
  const shutdownController = new AbortController()
  const remoteControlToken = options.remoteControlToken || randomBytes(32).toString("base64url")
  const controllerToken = options.controllerToken || randomBytes(32).toString("base64url")
  const rendererId = options.rendererId || randomUUID()
  const startupTimeoutMs = Number(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
  let stdioHandle = null
  let listenerPromise = Promise.resolve()
  let rendererPromise = Promise.resolve(null)
  let ownedRenderer = null
  let stopping = null

  const shutdown = (reason) => {
    if (stopping) return stopping
    stopping = (async () => {
      const failures = []
      shutdownController.abort(new Error(reason))
      await listenerPromise.catch(() => {})
      ownedRenderer ||= await rendererPromise.catch(() => null)
      await stdioHandle?.close().catch((error) => failures.push(error))
      await ownedRenderer?.stop().catch((error) => failures.push(error))
      await stopApple2tsServer().catch((error) => failures.push(error))
      process.stdin.off("end", onStdinEnd)
      process.stdin.off("close", onStdinEnd)
      process.stdin.pause()
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      if (failures.length) throw new AggregateError(failures, "Apple2TS MCP cleanup failed")
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
    if (!options.chromiumExecutable) throw new Error("APPLE2TS_CHROMIUM_EXECUTABLE is required")
    const chromiumMode = options.chromiumMode ?? "headless"
    if (chromiumMode !== "headless" && chromiumMode !== "visible") {
      throw new Error("APPLE2TS_CHROMIUM_MODE must be 'headless' or 'visible'")
    }
    listenerPromise = startApple2tsServer({
      host: "127.0.0.1",
      port: Number(options.port ?? 0),
      privateRenderer: { remoteControlToken, rendererId, controllerToken },
      logger: { log: (message) => process.stderr.write(`${message}\n`) },
    })
    const listener = await listenerPromise
    const core = new Apple2tsObservationCore(
      listener.url,
      controllerToken,
      {
        serverInstanceId: listener.serverInstanceId,
        rendererId,
        targetId: `${listener.serverInstanceId}:${rendererId}`,
      },
      shutdownController.signal,
    )
    rendererPromise = launchChromium({
      executable: options.chromiumExecutable,
      bridgeUrl: listener.url,
      remoteControlToken,
      rendererId,
      mode: chromiumMode,
    })
    ownedRenderer = await rendererPromise

    process.stderr.write(`Apple2TS MCP private bridge listening at ${listener.url}; waiting for renderer ${rendererId}.\n`)
    const startup = await Promise.race([
      waitForRenderer(core, startupTimeoutMs, shutdownController.signal).then(() => ({ ready: true })),
      ownedRenderer.exited.then((outcome) => ({ ready: false, outcome })),
    ])
    if (!startup.ready) {
      throw new Error(`Owned Chromium exited before readiness (${ownedRenderer.describeExit(startup.outcome)})`)
    }
    if (shutdownController.signal.aborted) return

    void ownedRenderer.exited.then((outcome) => {
      if (stopping) return
      process.stderr.write(`Apple2TS MCP renderer exited unexpectedly (${ownedRenderer.describeExit(outcome)}).\n`)
      process.exitCode = 1
      void shutdown("Owned Chromium exited unexpectedly").catch(reportFatal)
    })

    stdioHandle = serveStdio(() => createMcpServer(core), {
      onerror: (error) => process.stderr.write(`Apple2TS MCP protocol error: ${error.message}\n`),
    })
    process.stderr.write(`Apple2TS MCP ready for renderer ${rendererId}.\n`)
  } catch (error) {
    if (!shutdownController.signal.aborted) {
      process.stderr.write(`Apple2TS MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
    await shutdown("Startup ended").catch(reportFatal)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  void runStdio({
    port: process.env.APPLE2TS_PRIVATE_PORT,
    remoteControlToken: process.env.APPLE2TS_REMOTE_CONTROL_TOKEN,
    rendererId: process.env.APPLE2TS_RENDERER_ID,
    startupTimeoutMs: process.env.APPLE2TS_STARTUP_TIMEOUT_MS,
    chromiumExecutable: process.env.APPLE2TS_CHROMIUM_EXECUTABLE,
    chromiumMode: process.env.APPLE2TS_CHROMIUM_MODE,
  })
}
