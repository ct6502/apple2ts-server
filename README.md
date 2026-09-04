# apple2ts-server

Standalone home for the Apple2TS integrated server and CLI.

## Layout

- `server/`: integrated HTTP server and API docs
- `cli/`: command-line tool that talks to the server API

## Requirements

- Node.js 24+
- npm 11+

## Quick Start

Start the integrated server:

```bash
nvm use
npm run start
```

Open the emulator in a browser:

```text
http://127.0.0.1:6502/?remoteControl=1
```

Use CLI commands in another terminal:

```bash
npm run cli -- machine get
npm run cli -- machine boot
npm run cli -- machine reset
```

The server uses `dist/` by default. Set `APPLE2TS_DIST_DIR` to an existing
Apple2TS build directory when the build lives elsewhere. If its `index.html`
is missing, `npm run start` prints setup steps and exits.
Use `npm run start:force` only when you intentionally want the API server without the built client UI.
Both commands also refuse to start when the target port is already occupied by a different service.

## Server Overview

- localhost-only by design (`127.0.0.1`)
- serves the browser app from the configured Apple2TS build directory
- provides a resource-oriented HTTP API
- bridges commands to the browser client via SSE

The emulator does not run on the server. It runs in the browser client.

Use `?remoteControl=1` so the browser client auto-registers with the integrated API bridge.

## MCP over stdio

The stdio server needs an Apple2TS browser build. Build it in an Apple2TS
checkout, then give the server its `dist/` path:

```bash
cd /path/to/apple2ts
npm ci --ignore-scripts
npm run build

cd /path/to/apple2ts-server
npm ci
APPLE2TS_CHROMIUM_EXECUTABLE=/path/to/chrome \
  APPLE2TS_DIST_DIR=/path/to/apple2ts/dist \
  npm run mcp:stdio
```

`npm run mcp:stdio` starts a lightweight MCP process. It does not start a
browser until the client calls `start_session`. Call `stop_session` when that
private emulator is no longer needed. A host whose configuration uses an
`mcpServers` object can start it with an entry like this:

```json
{
  "mcpServers": {
    "apple2ts": {
      "command": "npm",
      "args": ["--prefix", "/path/to/apple2ts-server", "run", "mcp:stdio"],
      "env": {
        "APPLE2TS_CHROMIUM_EXECUTABLE": "/path/to/chrome",
        "APPLE2TS_DIST_DIR": "/path/to/apple2ts/dist",
        "APPLE2TS_FILE_SOURCE_ROOT": "/path/to/project-test-artifacts",
        "APPLE2TS_FILE_STAGING_ROOT": "/path/to/private-mcp-staging"
      }
    }
  }
}
```

Replace the paths for your installation. `start_session` accepts an optional
`visibility` of `headless` or `visible`; omitting it uses
`APPLE2TS_CHROMIUM_MODE`, or `headless` when that setting is absent. When the
host closes the stdio connection, the server stops any active browser and
removes its private profile.
Closing the owned visible window also ends that emulator session. A direct MCP
consumer may then call `start_session` again.
Consumers can subscribe to `apple2ts://session/lifecycle`, then await its
`notifications/resources/updated` notification instead of polling emulator
state. The server sends this notification only after the renderer has failed
to reconnect and session cleanup has finished. Reading the resource reports
whether cleanup completed.
An outer launcher can set `APPLE2TS_SESSION_EVENT_FILE` to an exact path in a
task-owned directory that the monitored child cannot write. The launcher owns
that directory and its cleanup; the server writes only the configured receipt
and a neighboring temporary file.
After session cleanup, the server atomically publishes a versioned
`browser-closed` or `browser-failed` receipt. It refuses to replace an existing
receipt, which remains until the launcher consumes it and removes its task
directory. File ingress does not need to be configured for lifecycle receipts.

To enable `stage_file`, `load_binary`, and `mount_disk`, set both
`APPLE2TS_FILE_SOURCE_ROOT` and `APPLE2TS_FILE_STAGING_ROOT` before startup.
The source root is one allowed project or test-artifact directory. The staging
root is writable private storage for this MCP process. First call `stage_file`
with a path relative to the source root, then use its returned path with
`mount_disk` or `load_binary`. The server removes staged files when the MCP
session ends. A binary can be up to 49,152 bytes and must fit in main RAM at
`$0000-$BFFF`. A floppy image can be up to 2 MiB; a hard-drive image can be up
to 32 MiB.

### Server Docs URLs

- OpenAPI: `/openapi.json`
- Swagger UI: `/docs`

### Core API Resources

- machine: `GET /api/machine`, `PATCH /api/machine`, lifecycle routes
- cpu: `GET /api/debug/cpu`, `PATCH /api/debug/cpu`
- debug stepping: `POST /api/debug/step-into|step-over|step-out`
- breakpoints: list/create/update/delete/clear
- snapshots: list/create/activate/step-back/step-forward
- memory: get/range/full/set
- soft switches: get/set
- drives: list/get/patch/delete/mount
- input: keys/apple-keys/mouse
- save states: export/import

## CLI Usage

Show help:

```bash
npm run cli -- --help
```

Use a custom server URL:

```bash
npm run cli -- --server http://127.0.0.1:6502 machine get
```

By default, CLI runs a health preflight against `/api/health` to ensure the URL points to the integrated server.
Bypass preflight only when intentional:

```bash
npm run cli -- --skip-health-check machine get
```

### Command Groups

- `machine`
- `cpu`
- `debug`
- `breakpoints`
- `memory`
- `soft-switches`
- `drives`
- `input`
- `snapshots`
- `save-state`

### Common CLI Examples

```bash
npm run cli -- machine get
npm run cli -- machine set --speed-mode 3 --debug-enabled true
npm run cli -- cpu get
npm run cli -- breakpoints list
npm run cli -- memory get --start 0x300 --length 16 --format hex
npm run cli -- drives list
npm run cli -- snapshots list
```

## Notes

- The server remains localhost-oriented by default (`127.0.0.1:6502`).
- The browser client still executes emulator actions; the server bridges API calls to the browser session.
- If you see `HTTP 503: NO_CONNECTED_CLIENT`, open `http://127.0.0.1:6502/?remoteControl=1` and retry the CLI command.
