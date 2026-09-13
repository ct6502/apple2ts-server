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
        "APPLE2TS_DIST_DIR": "/path/to/apple2ts/dist"
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

The `prepare_mount_disk` and `prepare_load_binary` tools bind an absolute local
source path and destination to a short-lived upload ticket without
reading or changing the source file. A caller may also supply the file's
expected SHA-256 digest. Write the returned ticket as one line to the installed
`apple2ts-upload` command. From a repository checkout, run:

```bash
npm --prefix /path/to/apple2ts-server run --silent upload
```

The helper opens the bound path and sends its bytes to the private loopback
server. The MCP call does not change the emulator; the helper prints the final
confirmed mount or load receipt. A binary can be up to 49,152 bytes and must
fit in main RAM at `$0000-$BFFF`. A floppy image can be up to 2 MiB; a
hard-drive image can be up to 32 MiB.

Tickets expire after 30 seconds. One helper may claim a pending ticket; the
ticket then retains its confirmed result or failure until expiry so a retry can
recover a response lost after the emulator operation. A ticket is a temporary
bearer URL; its holder can retrieve the bound source path until upload begins.
Passing it on standard input keeps it out of the helper's process arguments.

Read `apple2ts://session/execution` for one worker-confirmed execution snapshot,
including the stop reason, breakpoint, CPU registers, machine model, and memory
configuration. `wait_for_execution_stop` waits for a newer stop without
changing execution. Pass the last observed `executionSequence` as
`afterSequence` to avoid missing a fast stop; an unexpected breakpoint is
returned immediately with `expectationMatched: false`.

`save_session_snapshot` records one private paused baseline inside the current
emulator. A later `restore_session_snapshot` call uses its opaque ID to restore
the CPU, memory, soft switches, slot-card state, and media state captured by the
worker. Saving again replaces the earlier baseline. The configured speed and
caller-owned debugger entries remain unchanged, and session shutdown removes
the baseline. Large hard-drive bytes are retained from the current mounted
media rather than copied into the snapshot.

`run_input_sequence` keeps execution continuous while it waits for up to 16
ordered memory conditions and sends each phase's discrete keys. A phase may
omit `when` to send its keys immediately. Conditions compare 1-32 active,
main, or auxiliary bytes and may supply a same-length mask. A required final
condition ends the sequence; completion, timeout, cancellation, or another
execution stop pauses the emulator and returns the final execution state. Set
`startExecution` to arm the sequence before resuming a paused emulator.

Use `{all: [predicate, ...]}` to require up to eight non-nested predicates at
the same instruction boundary. Each delivery reports `predicateMatchCycle`
(`null` for an immediate phase), `matchedBytes` in predicate order, and
`keyConsumptionCycles` in key order. These are absolute emulated cycles at
instruction boundaries, not wall-clock times. Timeout receipts distinguish
`condition` from `key_consumption` and include the pending condition's actual
bytes. Key consumption does not mean action completion; choose a final
condition that establishes the intended result.

### Install a matched runtime

Use a versioned local installation when MCP clients should not depend on a
development checkout. The installer is independent of the MCP host and model.
It requires Node.js 24+, npm 11+, and Git. Installation and activation target
macOS and Linux. On Windows, commands exit with an unsupported-platform error
before making changes; `--help` remains available.

For a source pair already known to be compatible, install and activate it in
one command:

```bash
npm run --silent runtime -- install --server /path/to/apple2ts-server \
  --browser /path/to/apple2ts --id release-1
```

This assembles, verifies the files, and activates the build. It does not run
emulator acceptance automatically. If activation fails, the completed build
remains available for a later `activate` command; the previous selection is
unchanged.

To test a new candidate before activation, keep the steps separate:

```bash
npm run --silent runtime -- assemble --server /path/to/apple2ts-server \
  --browser /path/to/apple2ts --id candidate-1 --install-dir /path/to/install
npm run --silent runtime -- verify --id candidate-1 --install-dir /path/to/install
```

Assembly exports both HEAD commits without changing the source checkouts,
installs locked dependencies, and runs the browser's build script. Use trusted
source: that build script executes with the installer's permissions. The
result contains its own server dependencies and browser assets, plus a
`manifest.json` recording both commits and file hashes. Verification detects
accidental changes; the manifest is not a signature or an authorization boundary.
The default installation directory is `~/Library/Application Support/Apple2TS` on macOS.
On Linux it is `$XDG_DATA_HOME/apple2ts`, falling back to
`~/.local/share/apple2ts` when that variable is empty or not absolute.
Use `--install-dir` to choose another location; use the same directory for later commands.

Before activation, test `builds/candidate-1/bin/apple2ts-mcp.mjs` directly with
your MCP client and Chrome configuration. Verify the tools your workflow needs
and an isolated emulator's normal shutdown. The `verify` command checks file
integrity, not compatibility between arbitrary server and browser revisions.
The repository's opt-in synthetic acceptance can exercise the installed entry
points without private media:

```bash
APPLE2TS_REAL_CHROMIUM_EXECUTABLE=/path/to/chrome \
APPLE2TS_REAL_DIST_DIR=/path/to/install/builds/candidate-1/browser \
APPLE2TS_REAL_MCP_ENTRY=/path/to/install/builds/candidate-1/bin/apple2ts-mcp.mjs \
APPLE2TS_REAL_UPLOAD_ENTRY=/path/to/install/builds/candidate-1/bin/apple2ts-upload.mjs \
node --test --test-name-pattern='real renderer exercises' test/mcp_stdio.test.mjs
```

After acceptance:

```bash
npm run --silent runtime -- activate --id candidate-1 --install-dir /path/to/install
```

Configure any stdio MCP host once with command `node`, argument
`/path/to/install/current/bin/apple2ts-mcp.mjs`, and the existing
`APPLE2TS_CHROMIUM_EXECUTABLE` environment setting. Do not configure a separate
`APPLE2TS_DIST_DIR`: the launcher pins it to the selected installation.
The matching upload helper is `node /path/to/install/current/bin/apple2ts-upload.mjs`.
Keep private session data outside the installation, using the MCP server's
existing temporary storage defaults.

Activation atomically replaces `current`; existing MCP processes retain both
their server and browser version. New processes use the selected build. Hosts
may need to reconnect their MCP client to see an update. Run `activate` with
the previous ID to roll back. Existing checkout-based commands remain valid.

Installations are retained and must not be edited in place. Run one installer
at a time. Failed assembly removes its private intermediate directory, and
SIGINT/SIGTERM stop its build processes before cleanup. SIGKILL or power loss
can leave a `.assemble-*` directory; inspect ownership before removing it.
The installer never prunes builds, stops emulator sessions, or edits host
configuration. Retain old builds until their MCP processes have exited.

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
