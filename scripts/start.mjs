import { access } from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")
const distIndex = path.join(repoRoot, "dist", "index.html")
const host = "127.0.0.1"
const port = Number(process.env.PORT || 6502)
const allowMissingDist = process.argv.includes("--allow-missing-dist")

const printMissingDistHelp = () => {
  process.stderr.write("Cannot start emulator UI: missing dist/index.html\n")
  process.stderr.write("This repo does not define a build script for the browser client.\n")
  process.stderr.write("\n")
  process.stderr.write("To run the full app:\n")
  process.stderr.write("1. Build the Apple2TS web client in its source repo.\n")
  process.stderr.write("2. Copy its build output into this repo at dist/.\n")
  process.stderr.write("3. Re-run: npm run start\n")
}

const printPortConflictHelp = () => {
  process.stderr.write(`Cannot start integrated server: port ${port} is already in use by another service.\n`)
  process.stderr.write("\n")
  process.stderr.write("Fix options:\n")
  process.stderr.write("1. Stop the other service using that port.\n")
  process.stderr.write("2. Or run with a different port, e.g. PORT=6503 npm run start\n")
}

const printAlreadyRunningHelp = () => {
  process.stderr.write(`Integrated server already running at http://${host}:${port}.\n`)
  process.stderr.write("Use the existing process, or stop it before starting a new one.\n")
}

const probePort = async () => {
  const healthUrl = `http://${host}:${port}/api/health`

  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(1000),
    })

    const contentType = String(response.headers.get("content-type") || "")
    if (!response.ok || !contentType.includes("application/json")) {
      return "occupied-other"
    }

    const payload = await response.json().catch(() => null)
    if (payload && typeof payload === "object" && payload.status === "ok") {
      return "integrated-running"
    }

    return "occupied-other"
  } catch (error) {
    const code = error?.cause?.code
    if (code === "ECONNREFUSED") {
      return "free"
    }

    if (error?.name === "AbortError") {
      return "occupied-other"
    }

    return "free"
  }
}

const run = async () => {
  const portState = await probePort()
  if (portState === "integrated-running") {
    printAlreadyRunningHelp()
    process.exit(1)
  }
  if (portState === "occupied-other") {
    printPortConflictHelp()
    process.exit(1)
  }

  if (!allowMissingDist) {
    try {
      await access(distIndex)
    } catch {
      printMissingDistHelp()
      process.exit(1)
    }
  }

  const child = spawn(process.execPath, ["server/server.mjs"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  })

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

run().catch((error) => {
  process.stderr.write(`Failed to start server: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
