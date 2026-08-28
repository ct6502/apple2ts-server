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

If `dist/index.html` is missing, `npm run start` prints setup steps and exits.
Use `npm run start:force` only when you intentionally want the API server without the built client UI.
Both commands also refuse to start when the target port is already occupied by a different service.

## Server Overview

- localhost-only by design (`127.0.0.1`)
- serves the browser app from `dist/`
- provides a resource-oriented HTTP API
- bridges commands to the browser client via SSE

The emulator does not run on the server. It runs in the browser client.

Use `?remoteControl=1` so the browser client auto-registers with the integrated API bridge.

## MCP over stdio

The stdio server needs an Apple2TS browser build. Build it in an Apple2TS
checkout, then copy it into this repository:

```bash
cd /path/to/apple2ts
npm ci --ignore-scripts
npm run build

cd /path/to/apple2ts-server
npm ci
rm -rf ./dist
cp -R /path/to/apple2ts/dist ./dist
```

`npm run mcp:stdio` starts one private Apple2TS browser session owned by the
MCP process. A host whose configuration uses an `mcpServers` object can start
it with an entry like this:

```json
{
  "mcpServers": {
    "apple2ts": {
      "command": "npm",
      "args": ["--prefix", "/path/to/apple2ts-server", "run", "mcp:stdio"],
      "env": {
        "APPLE2TS_CHROMIUM_EXECUTABLE": "/path/to/chrome"
      }
    }
  }
}
```

Replace the paths for your installation. To open the browser window, add
`"APPLE2TS_CHROMIUM_MODE": "visible"` to `env`. When the host closes the stdio
connection, the server stops the browser and removes its private profile.

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
