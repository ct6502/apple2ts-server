import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"

// Read only the installer's recorded source pair. This is neither a content
// verification nor an attestation from the running browser.
export const readInstalledBuild = async (serverEntry, browserDir) => {
  try {
    const entry = await realpath(serverEntry)
    const build = path.resolve(path.dirname(entry), "../..")
    const id = path.basename(build)
    if (path.basename(path.dirname(build)) !== "builds"
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)
      || entry !== path.join(build, "server", "server", "mcp_stdio.mjs")
      || await realpath(browserDir) !== path.join(build, "browser")) return null
    const manifestPath = path.join(build, "manifest.json")
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return null
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    if (manifest?.format !== 1 || manifest.id !== id
      || typeof manifest.serverCommit !== "string"
      || typeof manifest.browserCommit !== "string"
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.serverCommit)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.browserCommit)
      || !Array.isArray(manifest.files)) return null
    return {
      source: "installer-manifest",
      id,
      serverCommit: manifest.serverCommit,
      browserCommit: manifest.browserCommit,
      contentVerified: false,
    }
  } catch {
    return null
  }
}
