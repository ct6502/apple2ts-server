import assert from "node:assert/strict"
import {execFileSync, spawn} from "node:child_process"
import {once} from "node:events"
import {mkdtemp, mkdir, readdir, rm, symlink, writeFile} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import test from "node:test"

const installer = fileURLToPath(new URL("../scripts/runtime-install.mjs", import.meta.url))
const invoke = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [installer, ...args])
  let stdout = "", stderr = ""
  child.stdout.on("data", (chunk) => stdout += chunk)
  child.stderr.on("data", (chunk) => stderr += chunk)
  child.on("close", (code) => resolve({code, stdout, stderr}))
})
const git = (cwd, ...args) => execFileSync("git", args, {cwd, stdio: "pipe"})

async function source(directory, files, scripts = {}) {
  await mkdir(directory)
  const pkg = {name: "install-fixture", version: "1.0.0", type: "module", scripts}
  files["package.json"] = JSON.stringify(pkg)
  files["package-lock.json"] = JSON.stringify({name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {"": {name: pkg.name, version: pkg.version}}})
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), {recursive: true})
    await writeFile(path.join(directory, name), content)
  }
  git(directory, "init", "-q")
  git(directory, "add", ".")
  git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
}

test("runtime installation: assembly, verification, activation, pinning and rollback", {timeout: 60_000}, async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "apple2ts-install-test-"))
  t.after(() => rm(scratch, {recursive: true, force: true}))
  const root = path.join(scratch, "installation with spaces")
  const server = path.join(scratch, "server")
  const browser = path.join(scratch, "browser")
  await source(server, {
    "server/mcp_stdio.mjs": `import fs from "node:fs";
process.stdin.on("data", () => process.stdout.write(fs.readFileSync(process.env.APPLE2TS_DIST_DIR + "/index.html", "utf8") + "\\n"));`,
    "cli/apple2ts-upload.mjs": 'process.stdout.write("upload help\\n")',
  })
  await source(browser, {"build.mjs": 'import fs from "node:fs"; fs.mkdirSync("dist"); fs.writeFileSync("dist/index.html", "A");'}, {build: "node build.mjs"})
  const command = (verb, id, extra = []) => invoke([verb, "--root", root, "--id", id, ...extra])
  const assemble = (id) => command("assemble", id, ["--server", server, "--browser", browser])
  const first = await assemble("A")
  assert.equal(first.code, 0, first.stderr)
  assert.deepEqual(await readdir(root), ["builds"], "assembly must not activate")
  const firstReceipt = JSON.parse(first.stdout)
  assert.equal(firstReceipt.serverCommit, git(server, "rev-parse", "HEAD").toString().trim())
  assert.equal(firstReceipt.browserCommit, git(browser, "rev-parse", "HEAD").toString().trim())
  assert.equal((await command("verify", "A")).code, 0)
  assert.notEqual((await assemble("A")).code, 0, "must not replace an installation")
  assert.equal((await command("activate", "A")).code, 0)

  const launcher = path.join(root, "current/bin/apple2ts-mcp.mjs")
  const running = spawn(process.execPath, [launcher], {env: {...process.env, APPLE2TS_DIST_DIR: "/wrong/inherited/path"}})
  const exit = once(running, "exit")
  t.after(() => { if (running.exitCode === null) running.kill("SIGKILL") })
  running.stdout.setEncoding("utf8")
  const probe = async () => {
    const output = once(running.stdout, "data")
    running.stdin.write("probe\n")
    return (await output)[0].trim()
  }
  assert.equal(await probe(), "A")
  await writeFile(path.join(browser, "build.mjs"), 'import fs from "node:fs"; fs.mkdirSync("dist"); fs.writeFileSync("dist/index.html", "B");')
  assert.notEqual((await assemble("dirty")).code, 0)
  git(browser, "add", "build.mjs")
  git(browser, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "second build")
  const second = await assemble("B")
  assert.equal(second.code, 0, second.stderr)
  const activation = await command("activate", "B")
  assert.equal(activation.code, 0, activation.stderr)
  assert.equal(JSON.parse(activation.stdout).previous, "builds/A")
  assert.equal(await probe(), "A", "live process must retain its old browser")
  assert.equal(execFileSync(process.execPath, [launcher], {input: "probe\n", encoding: "utf8"}).trim(), "B")
  assert.equal((await command("activate", "A")).code, 0)
  assert.equal(execFileSync(process.execPath, [launcher], {input: "probe\n", encoding: "utf8"}).trim(), "A")
  running.stdin.end()
  assert.equal((await exit)[0], 0, "EOF reaches the original process")
  assert.equal(execFileSync(process.execPath, [path.join(root, "current/bin/apple2ts-upload.mjs"), "--help"], {encoding: "utf8"}), "upload help\n")

  await writeFile(path.join(root, "builds/B/browser/index.html"), "corrupt")
  assert.notEqual((await command("verify", "B")).code, 0)
  assert.notEqual((await command("activate", "B")).code, 0)
  assert.equal(execFileSync(process.execPath, [launcher], {input: "probe\n", encoding: "utf8"}).trim(), "A")
  for (const id of ["../escape", "", "/absolute"]) assert.notEqual((await command("verify", id)).code, 0)
  assert.notEqual((await command("verify", "absent")).code, 0)
  assert.deepEqual(await readdir(path.join(root, "builds")), ["A", "B"])
  assert.equal(git(server, "status", "--porcelain").length, 0)
  assert.equal(git(browser, "status", "--porcelain").length, 0)
  await rm(path.join(root, "current"))
  await mkdir(path.join(root, "current"))
  assert.notEqual((await command("activate", "A")).code, 0, "must preserve unrelated current directory")
  await rm(path.join(root, "current"), {recursive: true})
  await symlink("../unrelated", path.join(root, "current"))
  assert.notEqual((await command("activate", "A")).code, 0, "must preserve unrelated current link")
})

test("failed and interrupted assembly leave no candidate or activation", {timeout: 30_000}, async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "apple2ts-install-failure-"))
  t.after(() => rm(scratch, {recursive: true, force: true}))
  const server = path.join(scratch, "server")
  const browser = path.join(scratch, "browser")
  const root = path.join(scratch, "install")
  await source(server, {})
  await source(browser, {"build.mjs": 'console.error("BUILD_WAITING"); setInterval(() => {}, 1000)'}, {build: "node build.mjs"})
  const args = ["assemble", "--root", root, "--id", "broken", "--server", server, "--browser", browser]
  const child = spawn(process.execPath, [installer, ...args])
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  let errors = ""
  child.stderr.on("data", (chunk) => {
    errors += chunk
    if (errors.includes("BUILD_WAITING")) child.kill("SIGTERM")
  })
  const [code] = await once(child, "exit")
  assert.equal(code, 1, errors)
  assert.deepEqual(await readdir(path.join(root, "builds")), [])
  assert.deepEqual(await readdir(root), ["builds"])
  await writeFile(path.join(browser, "build.mjs"), "process.exit(7)")
  git(browser, "add", ".")
  git(browser, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "failed build")
  const failure = await invoke(args)
  assert.equal(failure.code, 1)
  assert.match(failure.stderr, /npm failed/)
  assert.deepEqual(await readdir(path.join(root, "builds")), [])
})

test("help and malformed command discovery", async () => {
  assert.match((await invoke(["--help"])).stdout, /assemble.*--server/)
  assert.equal((await invoke(["delete", "--id", "A"])).code, 1)
  assert.equal((await invoke(["activate", "--id", "A", "--id", "B"])).code, 1)
})
