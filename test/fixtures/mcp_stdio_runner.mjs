import { runStdio } from "../../server/mcp_stdio.mjs"

const missingBrowserBuild = process.env.APPLE2TS_TEST_MISSING_BROWSER_BUILD === "1"

void runStdio({
  port: process.env.APPLE2TS_PRIVATE_PORT,
  remoteControlToken: process.env.APPLE2TS_REMOTE_CONTROL_TOKEN,
  rendererId: process.env.APPLE2TS_RENDERER_ID,
  startupTimeoutMs: process.env.APPLE2TS_STARTUP_TIMEOUT_MS,
  chromiumExecutable: process.env.APPLE2TS_CHROMIUM_EXECUTABLE,
  chromiumMode: process.env.APPLE2TS_CHROMIUM_MODE,
  binaryRoot: process.env.APPLE2TS_BINARY_ROOT,
  requireBrowserBuild: missingBrowserBuild,
  hasBrowserBuild: missingBrowserBuild ? async () => false : undefined,
})
