#!/usr/bin/env node
import {execFileSync, spawn} from "node:child_process"
import {createHash, randomUUID} from "node:crypto"
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"

const help = `Apple2TS local runtime installation (macOS/Linux, Node 24+, npm, Git)
  assemble --server CHECKOUT --browser CHECKOUT --id NAME [--root DIRECTORY]
  verify --id NAME [--root DIRECTORY]
  activate --id NAME [--root DIRECTORY]

Default root: ~/.local/share/apple2ts
Assemble builds committed HEADs, installs locked dependencies, and does not activate.
Verify checks recorded contents, not emulator compatibility. Run private MCP acceptance
before activation. Activate also verifies; use it with an older ID to roll back.
No command edits MCP configuration, stops sessions, or removes previous builds.
Success prints a JSON receipt to stdout; build output and errors go to stderr.
`

const interrupted = new AbortController()
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  interrupted.signal.throwIfAborted()
  const child = spawn(command, args, {cwd, stdio: ["ignore", 2, 2], detached: true})
  let stopped = false
  let killTimer
  const kill = (signal) => {
    try { process.kill(-child.pid, signal) }
    catch (error) { if (error.code !== "ESRCH") reject(error) }
  }
  const stop = () => {
    stopped = true
    kill("SIGTERM")
    killTimer ||= setTimeout(() => kill("SIGKILL"), 2000)
  }
  const timer = setTimeout(stop, 300_000)
  interrupted.signal.addEventListener("abort", stop, {once: true})
  child.once("error", reject)
  child.once("close", (code) => {
    clearTimeout(timer)
    clearTimeout(killTimer)
    interrupted.signal.removeEventListener("abort", stop)
    if (stopped) kill("SIGKILL") // Include descendants that outlive npm.
    if (code === 0 && !stopped) resolve()
    else reject(new Error(`${command} failed${stopped ? " or was interrupted" : ` (${code})`}`))
  })
})
const git = (cwd, ...args) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim()
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`)
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

async function inventory(root, relative = "") {
  const entries = []
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    if (!relative && name === "manifest.json") continue
    const rel = path.join(relative, name)
    const filename = path.join(root, rel)
    const info = await lstat(filename)
    if (info.isDirectory()) entries.push(...await inventory(root, rel))
    else if (info.isSymbolicLink()) {
      const target = await readlink(filename)
      if (path.isAbsolute(target) || !inside(root, await realpath(filename))) {
        throw new Error(`External installation link: ${rel}`)
      }
      entries.push({path: rel, link: target})
    } else if (info.isFile()) {
      entries.push({path: rel, mode: info.mode & 0o777, sha256: digest(await readFile(filename))})
    } else throw new Error(`Unsupported installation entry: ${rel}`)
  }
  return entries
}

async function exportHead(source, destination) {
  const commit = git(source, "rev-parse", "HEAD")
  if (git(source, "status", "--porcelain")) throw new Error(`Source must be clean: ${source}`)
  await run("git", ["clone", "--shared", "--no-checkout", "--", source, destination])
  await run("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit], destination)
  await rm(path.join(destination, ".git"), {recursive: true})
  return commit
}

// Import into this process, preserving the server's own EOF and signal handling.
// Resolve once so neither server nor browser retains the mutable current path.
function launcher(entry, browser = false) {
  return `#!/usr/bin/env node
import {realpathSync} from "node:fs"
import path from "node:path"
import {fileURLToPath, pathToFileURL} from "node:url"
const runtime = path.dirname(path.dirname(realpathSync(fileURLToPath(import.meta.url))))
${browser ? 'process.env.APPLE2TS_DIST_DIR = path.join(runtime, "browser")\n' : ""}process.argv[1] = path.join(runtime, "server", ${JSON.stringify(entry)})
await import(pathToFileURL(process.argv[1]).href)
`
}

export async function verify(root, id) {
  if ((await lstat(path.join(root, "builds"))).isSymbolicLink()) throw new Error("builds must not be a symlink")
  const directory = path.join(root, "builds", id)
  return verifyDirectory(directory, id)
}

async function verifyDirectory(directory, id) {
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Build must not be a symlink")
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"))
  if (manifest.format !== 1 || manifest.id !== id ||
      JSON.stringify(manifest.files) !== JSON.stringify(await inventory(directory))) {
    throw new Error("Installation does not match its manifest")
  }
  for (const required of ["browser/index.html", "server/server/mcp_stdio.mjs", "server/cli/apple2ts-upload.mjs", "bin/apple2ts-mcp.mjs", "bin/apple2ts-upload.mjs"]) {
    if (!(await lstat(path.join(directory, required))).isFile()) throw new Error(`Missing runtime file: ${required}`)
  }
  return {id, directory, serverCommit: manifest.serverCommit, browserCommit: manifest.browserCommit}
}

async function assemble(root, id, server, browser) {
  const builds = path.join(root, "builds")
  await mkdir(builds, {recursive: true})
  if ((await lstat(builds)).isSymbolicLink()) throw new Error("builds must not be a symlink")
  const destination = path.join(builds, id)
  const work = await mkdtemp(path.join(builds, ".assemble-"))
  try {
    // Reserve nothing at the final name until the complete build is available.
    try { await lstat(destination); throw new Error("Build ID already exists") }
    catch (error) { if (error.code !== "ENOENT") throw error }
    const serverCommit = await exportHead(server, path.join(work, "server"))
    const browserCommit = await exportHead(browser, path.join(work, "browser-source"))
    await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(work, "server"))
    await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(work, "browser-source"))
    await run("npm", ["run", "build"], path.join(work, "browser-source"))
    await cp(path.join(work, "browser-source", "dist"), path.join(work, "browser"), {recursive: true})
    await rm(path.join(work, "browser-source"), {recursive: true})
    await mkdir(path.join(work, "bin"))
    await writeFile(path.join(work, "bin", "apple2ts-mcp.mjs"), launcher("server/mcp_stdio.mjs", true), {mode: 0o755})
    await writeFile(path.join(work, "bin", "apple2ts-upload.mjs"), launcher("cli/apple2ts-upload.mjs"), {mode: 0o755})
    await writeFile(path.join(work, "manifest.json"), JSON.stringify({
      format: 1, id, serverCommit, browserCommit, files: await inventory(work),
    }, null, 2) + "\n")
    await verifyDirectory(work, id)
    interrupted.signal.throwIfAborted()
    // rename refuses a concurrent complete (nonempty) installation with this ID.
    await rename(work, destination)
    return await verify(root, id)
  } finally {
    await rm(work, {recursive: true, force: true})
  }
}

async function activate(root, id) {
  const receipt = await verify(root, id)
  const current = path.join(root, "current")
  let previous = null
  try {
    previous = await readlink(current)
    if (!/^builds\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(previous)) throw new Error("Unrecognized current target")
  }
  catch (error) { if (error.code !== "ENOENT") throw new Error("current must be absent or a symbolic link") }
  const temporary = path.join(root, `.activate-${randomUUID()}`)
  try {
    await symlink(path.join("builds", id), temporary)
    interrupted.signal.throwIfAborted()
    await rename(temporary, current)
  } finally { await rm(temporary, {force: true}) }
  return {...receipt, previous, launcher: path.join(current, "bin", "apple2ts-mcp.mjs")}
}

export async function main(args) {
  if (!args.length || args.includes("--help")) { process.stdout.write(help); return }
  if (process.platform === "win32") throw new Error("Installation activation and cleanup are not yet validated on Windows")
  const [command, ...rest] = args
  if (!["assemble", "verify", "activate"].includes(command)) throw new Error("Unknown command; use --help")
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    if (!["--root", "--id", ...(command === "assemble" ? ["--server", "--browser"] : [])].includes(key) ||
        !rest[i + 1] || rest[i + 1].startsWith("--") || key in options) throw new Error("Invalid options; use --help")
    options[key] = rest[i + 1]
  }
  const id = options["--id"]
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Invalid or missing build ID")
  const requestedRoot = path.resolve(options["--root"] || path.join(os.homedir(), ".local/share/apple2ts"))
  if (command === "assemble" && (!options["--server"] || !options["--browser"])) throw new Error("Both source checkouts are required")
  if (command === "assemble") await mkdir(requestedRoot, {recursive: true})
  const root = await realpath(requestedRoot)
  const result = command === "assemble"
    ? await assemble(root, id, path.resolve(options["--server"]), path.resolve(options["--browser"]))
    : command === "verify" ? await verify(root, id) : await activate(root, id)
  process.stdout.write(JSON.stringify({operation: command, ...result}) + "\n")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => interrupted.abort(new Error(`Installation interrupted by ${signal}`)))
  }
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
