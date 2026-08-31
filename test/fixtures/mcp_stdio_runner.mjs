import { runStdio } from "../../server/mcp_stdio.mjs"

const missingBrowserBuild = process.env.APPLE2TS_TEST_MISSING_BROWSER_BUILD === "1"
const requireBrowserBuild = missingBrowserBuild
  || process.env.APPLE2TS_TEST_REQUIRE_BROWSER_BUILD === "1"

void runStdio({
  port: process.env.APPLE2TS_PRIVATE_PORT,
  remoteControlToken: process.env.APPLE2TS_REMOTE_CONTROL_TOKEN,
  rendererId: process.env.APPLE2TS_RENDERER_ID,
  startupTimeoutMs: process.env.APPLE2TS_STARTUP_TIMEOUT_MS,
  chromiumExecutable: process.env.APPLE2TS_CHROMIUM_EXECUTABLE,
  chromiumMode: process.env.APPLE2TS_CHROMIUM_MODE,
  fileSourceRoot: process.env.APPLE2TS_FILE_SOURCE_ROOT,
  fileStagingRoot: process.env.APPLE2TS_FILE_STAGING_ROOT,
  distDir: process.env.APPLE2TS_DIST_DIR,
  requireBrowserBuild,
  hasBrowserBuild: missingBrowserBuild ? async () => false : undefined,
})
