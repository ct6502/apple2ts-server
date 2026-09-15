import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readInstalledBuild } from "../server/runtime_provenance.mjs"

test("installed provenance requires the resolved server and browser from one manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apple2ts-info-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const build = path.join(root, "builds", "candidate-1")
  const entry = path.join(build, "server", "server", "mcp_stdio.mjs")
  const browser = path.join(build, "browser")
  const manifestPath = path.join(build, "manifest.json")
  await mkdir(path.dirname(entry), { recursive: true })
  await mkdir(browser)
  await writeFile(entry, "// fixture only\n")
  const manifest = {
    format: 1, id: "candidate-1", serverCommit: "a".repeat(40),
    browserCommit: "b".repeat(40), files: [],
    privatePath: root, controllerToken: "secret-controller-token",
  }
  assert.equal(await readInstalledBuild(entry, browser), null)
  await writeFile(manifestPath, JSON.stringify(manifest))
  const expected = {
    source: "installer-manifest", id: manifest.id,
    serverCommit: manifest.serverCommit, browserCommit: manifest.browserCommit,
    contentVerified: false,
  }
  assert.deepEqual(await readInstalledBuild(entry, browser), expected)
  // A current link resolves to the pinned build; unrelated browser assets do not.
  await symlink(build, path.join(root, "current"))
  assert.deepEqual(await readInstalledBuild(
    path.join(root, "current", "server", "server", "mcp_stdio.mjs"),
    path.join(root, "current", "browser"),
  ), expected)
  const otherBrowser = path.join(root, "other-browser")
  await mkdir(otherBrowser)
  assert.equal(await readInstalledBuild(entry, otherBrowser), null)
  assert.equal(await readInstalledBuild(entry, path.join(root, "missing")), null)
  assert.equal(await readInstalledBuild(path.join(root, "absent.mjs"), browser), null)
  for (const bad of ["{", "null", "[]", ...[
    { format: 2 }, { id: "other" }, { serverCommit: root },
    { browserCommit: "secret-controller-token" }, { serverCommit: null },
    { files: null },
  ].map((patch) => JSON.stringify({ ...manifest, ...patch }))]) {
    await writeFile(manifestPath, bad)
    assert.equal(await readInstalledBuild(entry, browser), null)
  }
})
