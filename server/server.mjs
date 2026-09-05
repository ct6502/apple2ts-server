import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")
const defaultDistDir = path.join(repoRoot, "dist")
let distDir = defaultDistDir
const serverDir = __dirname
let host = "127.0.0.1"
let port = Number(process.env.PORT || 6502)
let commandTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS || 10000)
let serverInstanceId = randomUUID()
let privateRenderer = null
let logger = console
let clientStateObserver = null

const clients = new Map()
const pendingCommands = new Map()
const MAX_BINARY_BYTES = 0xC000

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
}

const setCorsHeaders = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
}

const writeJson = (res, statusCode, payload) => {
  setCorsHeaders(res)
  res.statusCode = statusCode
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(payload))
}

const readJsonBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw.length ? JSON.parse(raw) : {}
}

const readBinaryBody = async (req) => {
  const chunks = []
  let length = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length
    if (length > MAX_BINARY_BYTES) {
      req.resume()
      throw new Error(`Binary input cannot exceed ${MAX_BINARY_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const writeEnvelope = (res, statusCode, data) => {
  writeJson(res, statusCode, { ok: true, data })
}

const writeErrorEnvelope = (res, statusCode, code, message) => {
  writeJson(res, statusCode, {
    ok: false,
    error: {
      code,
      message,
    },
  })
}

const writeNoConnectedClientError = (res) => {
  writeErrorEnvelope(
    res,
    503,
    "NO_CONNECTED_CLIENT",
    "No browser emulator client is connected. Open /?remoteControl=1 and connect a session, then retry.",
  )
}

const getConnectedClient = () => {
  if (privateRenderer) {
    const client = clients.get(privateRenderer.clientId)
    return client?.eventStream ? client : null
  }

  let client = null
  for (const candidate of clients.values()) {
    if (!candidate.eventStream) continue
    if (!client || candidate.lastSeenAt > client.lastSeenAt) {
      client = candidate
    }
  }
  if (!client || !client.eventStream) {
    return null
  }
  return client
}

const cancelPrivateRendererDisconnect = () => {
  if (!privateRenderer?.disconnectTimer) return
  clearTimeout(privateRenderer.disconnectTimer)
  privateRenderer.disconnectTimer = null
}

const schedulePrivateRendererDisconnect = () => {
  const renderer = privateRenderer
  if (!renderer?.onDisconnect || renderer.disconnectTimer) return
  renderer.disconnectTimer = setTimeout(() => {
    renderer.disconnectTimer = null
    if (privateRenderer !== renderer) return
    const client = clients.get(renderer.clientId)
    if (client?.eventStream) return
    renderer.onDisconnect()
  }, renderer.disconnectGraceMs)
}

const rendererCredentialsMatch = (value) =>
  !privateRenderer ||
  (value?.remoteControlToken === privateRenderer.remoteControlToken &&
    value?.rendererId === privateRenderer.rendererId)

const rendererRequestMatches = (url, client) =>
  !privateRenderer ||
  (client?.rendererId === privateRenderer.rendererId &&
    url.searchParams.get("remoteControlToken") === privateRenderer.remoteControlToken &&
    url.searchParams.get("rendererId") === privateRenderer.rendererId)

const writePrivateRendererError = (res, statusCode, message) => {
  writeErrorEnvelope(res, statusCode, "RENDERER_BINDING_REJECTED", message)
}

const rendererApiPaths = new Set([
  "/api/client/connect",
  "/api/client/events",
  "/api/client/state",
  "/api/client/reply",
])

const isPrivateControllerPath = (pathname) =>
  privateRenderer &&
  ((pathname.startsWith("/api/") && !rendererApiPaths.has(pathname)) ||
    pathname === "/openapi.json" ||
    pathname === "/docs" ||
    pathname === "/docs/")

const controllerRequestMatches = (req) =>
  !privateRenderer || req.headers.authorization === `Bearer ${privateRenderer.controllerToken}`

const writePrivateControllerError = (res) => {
  writeErrorEnvelope(
    res,
    401,
    "CONTROLLER_AUTH_REQUIRED",
    "This private controller route requires the process-scoped controller token.",
  )
}

const runModeToApiName = (runMode) => {
  switch (runMode) {
    case 0:
      return "idle"
    case -1:
      return "running"
    case -2:
      return "paused"
    case -3:
      return "booting"
    case -4:
      return "resetting"
    default:
      return "idle"
  }
}

const getDriveId = (drive) => {
  if (drive.hardDrive) {
    return drive.drive === 1 ? "hd1" : "hd2"
  }
  return drive.drive === 1 ? "fd1" : "fd2"
}

const getDriveResource = (drive) => ({
  driveId: getDriveId(drive),
  index: Number(drive.index ?? 0),
  kind: drive.hardDrive ? "hard-drive" : "floppy",
  mounted: Boolean(drive.filename),
  filename: drive.filename || null,
  status: String(drive.status || ""),
  writeProtected: Boolean(drive.isWriteProtected),
  dirty: Boolean(drive.diskHasChanges),
  motorRunning: Boolean(drive.motorRunning),
  byteLength: Number(drive.byteLength ?? 0),
})

const getDriveResources = (status) => {
  const drives = Array.isArray(status?.drives) ? status.drives : []
  return drives.map(getDriveResource)
}

const findDriveResourceById = (drives, driveId) => drives.find((drive) => drive.driveId === driveId) || null

const findDriveResourceByIndex = (drives, index) =>
  drives.find((drive) => Number(drive.index) === Number(index)) || null

const getSoftSwitchResource = (status) => ({
  switches:
    status?.machine?.softSwitches && typeof status.machine.softSwitches === "object"
      ? status.machine.softSwitches
      : {},
})

const getMachineResource = (status) => {
  const machine = status?.machine || {}
  return {
    runMode: runModeToApiName(Number(machine.runMode)),
    speedMode: Number(machine.speedMode ?? 0),
    machineName: machine.machineName || "APPLE2EE",
    ramWorksKb: Number(machine.ramWorksKb ?? 64),
    debugEnabled: Boolean(machine.isDebugging),
    showDebugPanel: Boolean(machine.showDebugTab),
    textPage: machine.textPage || "",
    drives: getDriveResources(status).map(({ driveId, kind, mounted, filename, writeProtected, dirty }) => ({
      driveId,
      kind,
      mounted,
      filename,
      writeProtected,
      dirty,
    })),
  }
}

const getCpuResource = (status) => {
  const machineState = status?.machine?.machineState || {}
  const pStatus = Number(machineState.PStatus ?? 0)
  return {
    PC: Number(machineState.PC ?? 0),
    A: Number(machineState.Accum ?? 0),
    X: Number(machineState.XReg ?? 0),
    Y: Number(machineState.YReg ?? 0),
    S: Number(machineState.StackPtr ?? 0),
    IRQ: Number(machineState.flagIRQ ?? 0),
    PStatus: pStatus,
    cycleCount: Number(machineState.cycleCount ?? 0),
    flags: {
      N: Boolean(pStatus & (1 << 7)),
      V: Boolean(pStatus & (1 << 6)),
      B: Boolean(pStatus & (1 << 4)),
      D: Boolean(pStatus & (1 << 3)),
      I: Boolean(pStatus & (1 << 2)),
      Z: Boolean(pStatus & (1 << 1)),
      C: Boolean(pStatus & (1 << 0)),
      NMI: Boolean(machineState.flagNMI),
    },
  }
}

const buildCpuStateFromResource = (resource) => {
  const flags = resource?.flags || {}
  let pStatus
  if ("PStatus" in resource) {
    pStatus = Number(resource.PStatus)
  } else {
    pStatus = 0
    if (flags.N) pStatus |= 1 << 7
    if (flags.V) pStatus |= 1 << 6
    if (flags.B) pStatus |= 1 << 4
    if (flags.D) pStatus |= 1 << 3
    if (flags.I) pStatus |= 1 << 2
    if (flags.Z) pStatus |= 1 << 1
    if (flags.C) pStatus |= 1 << 0
  }

  return {
    PC: Number(resource.PC ?? 0),
    Accum: Number(resource.A ?? 0),
    XReg: Number(resource.X ?? 0),
    YReg: Number(resource.Y ?? 0),
    StackPtr: Number(resource.S ?? 0),
    flagIRQ: Number(resource.IRQ ?? 0),
    flagNMI: Boolean(flags.NMI),
    PStatus: pStatus,
    cycleCount: Number(resource.cycleCount ?? 0),
  }
}

const mergeCpuPatch = (current, patch) => {
  const next = {
    ...current,
    flags: {
      ...current.flags,
    },
  }

  if ("PC" in patch) next.PC = Number(patch.PC)
  if ("A" in patch) next.A = Number(patch.A)
  if ("X" in patch) next.X = Number(patch.X)
  if ("Y" in patch) next.Y = Number(patch.Y)
  if ("S" in patch) next.S = Number(patch.S)
  if ("IRQ" in patch) next.IRQ = Number(patch.IRQ)
  if ("cycleCount" in patch) next.cycleCount = Number(patch.cycleCount)
  if ("PStatus" in patch) next.PStatus = Number(patch.PStatus)
  if ("flags" in patch && patch.flags && typeof patch.flags === "object") {
    next.flags = {
      ...next.flags,
      ...patch.flags,
    }
  }

  return next
}

const allowedCpuPatchFields = new Set([
  "PC",
  "A",
  "X",
  "Y",
  "S",
  "IRQ",
  "PStatus",
  "cycleCount",
  "flags",
])

const getBreakpointsFromReply = async (client) => {
  const reply = await dispatchCommand(client, "getBreakpoints", {}, true)
  return Array.isArray(reply.result?.breakpoints) ? reply.result.breakpoints : []
}

const breakpointIdFromAddress = (address) => `bp:${Number(address)}`

const getBreakpointResource = (breakpoint) => ({
  breakpointId: breakpointIdFromAddress(breakpoint.address),
  address: Number(breakpoint.address),
  disabled: Boolean(breakpoint.disabled),
  watchpoint: Boolean(breakpoint.watchpoint),
  instruction: Boolean(breakpoint.instruction),
  hidden: Boolean(breakpoint.hidden),
  once: Boolean(breakpoint.once),
  memget: Boolean(breakpoint.memget),
  memset: Boolean(breakpoint.memset),
  expression1: breakpoint.expression1,
  expression2: breakpoint.expression2,
  expressionOperator: breakpoint.expressionOperator || "",
  hexvalue: Number(breakpoint.hexvalue ?? -1),
  hitcount: Number(breakpoint.hitcount ?? 1),
  nhits: Number(breakpoint.nhits ?? 0),
  memoryBank: breakpoint.memoryBank || "",
  action1: breakpoint.action1,
  action2: breakpoint.action2,
  halt: Boolean(breakpoint.halt),
})

const getBreakpointListResource = (breakpoints) => breakpoints.map(getBreakpointResource)

const parseBreakpointId = (breakpointId) => {
  if (!/^bp:-?\d+$/.test(String(breakpointId))) {
    return null
  }
  return Number(String(breakpointId).slice(3))
}

const setBreakpointsAndReadBack = async (client, breakpoints) => {
  const reply = await dispatchCommand(client, "setBreakpoints", { breakpoints }, true)
  const resultBreakpoints = Array.isArray(reply.result?.breakpoints) ? reply.result.breakpoints : breakpoints
  client.lastSeenAt = Date.now()
  return getBreakpointListResource(resultBreakpoints)
}

const findBreakpointResourceByAddress = (breakpoints, address) =>
  breakpoints.find((breakpoint) => Number(breakpoint.address) === Number(address)) || null

const getSnapshotResources = (snapshots) =>
  (Array.isArray(snapshots) ? snapshots : []).map((snapshot) => ({
    snapshotId: String(snapshot.snapshotId),
    index: Number(snapshot.index ?? 0),
    cycleCount: Number(snapshot.cycleCount ?? 0),
    label: snapshot.label ?? null,
    thumbnail: snapshot.thumbnail ?? null,
    active: Boolean(snapshot.active),
  }))

const getStatusFromCommandResult = (result) => {
  if (!result || typeof result !== "object") {
    return null
  }
  if (result.machine || result.drives) {
    return result
  }
  if (result.status && typeof result.status === "object") {
    return result.status
  }
  return null
}

const updateClientStatusFromCommandResult = (client, result) => {
  const status = getStatusFromCommandResult(result)
  if (status) {
    client.latestState = status
    clientStateObserver?.(status)
  }
  client.lastSeenAt = Date.now()
  return status
}

const getStatusFromReply = async (client, action, payload) => {
  const reply = await dispatchCommand(client, action, payload, true)
  return updateClientStatusFromCommandResult(client, reply.result) ?? reply.result
}

const getFreshMachineResource = async (client) => {
  const status = await getStatusFromReply(client, "getStatus", {})
  client.latestState = status
  client.lastSeenAt = Date.now()
  return getMachineResource(status)
}

const getFreshStatus = async (client) => {
  const status = await getStatusFromReply(client, "getStatus", {})
  client.latestState = status
  client.lastSeenAt = Date.now()
  return status
}

const allowedMachinePatchFields = new Set([
  "runMode",
  "speedMode",
  "machineName",
  "ramWorksKb",
  "debugEnabled",
  "showDebugPanel",
])

const applyMachinePatch = async (client, patch) => {
  let lastStatus = client.latestState

  if ("runMode" in patch) {
    if (patch.runMode !== "running" && patch.runMode !== "paused") {
      throw new Error("runMode must be 'running' or 'paused'")
    }
    lastStatus = await getStatusFromReply(client, "setRunMode", {
      runMode: patch.runMode === "running" ? -1 : -2,
    })
  }

  if ("speedMode" in patch) {
    const speedMode = Number(patch.speedMode)
    if (!Number.isFinite(speedMode)) {
      throw new Error("speedMode must be a number")
    }
    lastStatus = await getStatusFromReply(client, "setSpeedMode", { speedMode })
  }

  if ("machineName" in patch) {
    if (patch.machineName !== "APPLE2EU" && patch.machineName !== "APPLE2EE") {
      throw new Error("machineName must be 'APPLE2EU' or 'APPLE2EE'")
    }
    lastStatus = await getStatusFromReply(client, "setMachineName", {
      machineName: patch.machineName,
    })
  }

  if ("ramWorksKb" in patch) {
    const ramWorksKb = Number(patch.ramWorksKb)
    if (![64, 512, 1024, 4096, 8192].includes(ramWorksKb)) {
      throw new Error("ramWorksKb must be one of 64, 512, 1024, 4096, or 8192")
    }
    lastStatus = await getStatusFromReply(client, "setRamWorks", { size: ramWorksKb })
  }

  if ("debugEnabled" in patch) {
    lastStatus = await getStatusFromReply(client, "setDebug", {
      enabled: Boolean(patch.debugEnabled),
    })
  }

  if ("showDebugPanel" in patch) {
    lastStatus = await getStatusFromReply(client, "setShowDebugTab", {
      enabled: Boolean(patch.showDebugPanel),
    })
  }

  if (!lastStatus) {
    return getFreshMachineResource(client)
  }

  client.latestState = lastStatus
  client.lastSeenAt = Date.now()
  return getMachineResource(lastStatus)
}

const applyLifecycleAction = async (client, action) => {
  let runMode
  switch (action) {
    case "boot":
      runMode = -3
      break
    case "reset":
      runMode = -4
      break
    case "pause":
      runMode = -2
      break
    case "resume":
      runMode = -1
      break
    default:
      throw new Error(`Unsupported lifecycle action '${action}'`)
  }

  const status = await getStatusFromReply(client, "setRunMode", { runMode })
  client.latestState = status
  client.lastSeenAt = Date.now()
  return getMachineResource(status)
}

const applyDebugStep = async (client, action) => {
  const stepActionMap = {
    into: "stepInto",
    over: "stepOver",
    out: "stepOut",
  }
  const commandAction = stepActionMap[action]
  if (!commandAction) {
    throw new Error(`Unsupported debug step action '${action}'`)
  }

  const status = await getStatusFromReply(client, commandAction, {})
  client.latestState = status
  client.lastSeenAt = Date.now()
  return getCpuResource(status)
}

const getFreshCpuResource = async (client) => {
  const status = await getStatusFromReply(client, "getStatus", {})
  client.latestState = status
  client.lastSeenAt = Date.now()
  return getCpuResource(status)
}

const applyCpuPatch = async (client, patch) => {
  const current = await getFreshCpuResource(client)
  const next = mergeCpuPatch(current, patch)
  const status = await getStatusFromReply(client, "setCpuState", {
    state: buildCpuStateFromResource(next),
  })
  client.latestState = status
  client.lastSeenAt = Date.now()
  return getCpuResource(status)
}

const getSnapshotsFromReply = async (client) => {
  const reply = await dispatchCommand(client, "getSnapshots", {}, true)
  return getSnapshotResources(reply.result?.snapshots)
}

const getMemoryDumpFromReply = async (client) => {
  const reply = await dispatchCommand(client, "getMemory", {}, true)
  const memoryDump = Array.isArray(reply.result?.memoryDump)
    ? reply.result.memoryDump.map((value) => Number(value))
    : null

  if (!memoryDump) {
    throw new Error("Memory dump was not available from the browser client.")
  }

  client.lastSeenAt = Date.now()
  return {
    byteLength: memoryDump.length,
    data: memoryDump,
  }
}

const getMemoryViewFromReply = async (client, request) => {
  const reply = await dispatchCommand(client, "getMemoryView", request, true)
  const result = reply.result
  if (
    !result
    || !Array.isArray(result.bytes)
    || result.bytes.length !== request.length
    || !Array.isArray(result.effectiveSegments)
    || !result.mapping
    || typeof result.mapping !== "object"
  ) {
    throw new Error("Memory view was not available from the browser client.")
  }
  client.lastSeenAt = Date.now()
  return result
}

const MAX_SCREEN_CAPTURE_BASE64_LENGTH = 64 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const getRenderedScreenFromReply = async (client) => {
  const reply = await dispatchCommand(client, "captureScreen", {}, true)
  const result = reply.result
  if (
    result?.mimeType !== "image/png"
    || typeof result.dataBase64 !== "string"
    || result.dataBase64.length === 0
    || result.dataBase64.length > MAX_SCREEN_CAPTURE_BASE64_LENGTH
    || result.dataBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.dataBase64)
    || !Number.isInteger(result.width)
    || result.width < 1
    || !Number.isInteger(result.height)
    || result.height < 1
  ) {
    throw new Error("Rendered screen was not available from the browser client.")
  }
  const image = Buffer.from(result.dataBase64, "base64")
  if (
    image.length < 24
    || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || image.toString("ascii", 12, 16) !== "IHDR"
    || image.readUInt32BE(16) !== result.width
    || image.readUInt32BE(20) !== result.height
  ) {
    throw new Error("Rendered screen was not available from the browser client.")
  }
  client.lastSeenAt = Date.now()
  return {
    mimeType: result.mimeType,
    dataBase64: result.dataBase64,
    width: result.width,
    height: result.height,
  }
}

const formatBytesAsHex = (bytes) =>
  bytes.map((byte) => Number(byte).toString(16).padStart(2, "0").toUpperCase()).join(" ")

const getMemoryRangeResource = (memoryDump, start, length, format) => {
  const slice = memoryDump.slice(start, start + length)
  return {
    start,
    length,
    format,
    data: format === "hex" ? formatBytesAsHex(slice) : slice,
  }
}

const getDriveIdFromPath = (pathname) => decodeURIComponent(pathname.slice("/api/drives/".length))

const getDriveIdOrNull = (driveId) => (["hd1", "hd2", "fd1", "fd2"].includes(driveId) ? driveId : null)

const getMountedDriveResourceFromResult = (result, requestedDriveId) => {
  const status = getStatusFromCommandResult(result)
  if (!status) {
    return null
  }
  const driveResources = getDriveResources(status)
  const mountedDriveIndex =
    result && typeof result === "object" && "mountedDrive" in result ? Number(result.mountedDrive) : null

  if (Number.isInteger(mountedDriveIndex)) {
    const mountedDrive = findDriveResourceByIndex(driveResources, mountedDriveIndex)
    if (mountedDrive) {
      return mountedDrive
    }
  }

  return findDriveResourceById(driveResources, requestedDriveId)
}

const dispatchAcceptedInput = async (client, action, payload) => {
  const reply = await dispatchCommand(client, action, payload, true)
  updateClientStatusFromCommandResult(client, reply.result)
  return {
    accepted: true,
  }
}

const parseInteger = (value) => {
  if (value === null || value === "") return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

const validateMemoryBounds = (start, length) => {
  if (!Number.isInteger(start) || start < 0 || start > 65535) {
    throw new Error("start must be an integer between 0 and 65535")
  }
  if (!Number.isInteger(length) || length < 1 || length > 65536) {
    throw new Error("length must be an integer between 1 and 65536")
  }
  if (start + length > 65536) {
    throw new Error("Requested memory range exceeds 64 KB address space")
  }
}

const loadBinaryBlock = async (client, start, bytes) => {
  if (bytes.length === 0) {
    throw new Error("data must contain at least one byte")
  }
  validateMemoryBounds(start, bytes.length)
  if (start + bytes.length > 0xC000) {
    throw new Error("Binary block must fit within main RAM at $0000-$BFFF")
  }

  const reply = await dispatchCommand(client, "loadBinary", {
    address: start,
    dataBase64: bytes.toString("base64"),
  }, true)
  const status = getStatusFromCommandResult(reply.result)
  if (status) client.latestState = status
  client.lastSeenAt = Date.now()

  return {
    bytesWritten: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

const applySnapshotAction = async (client, action, payload = {}) => {
  const reply = await dispatchCommand(client, action, payload, true)
  client.lastSeenAt = Date.now()
  return getSnapshotResources(reply.result?.snapshots)
}

const getActiveSnapshot = (snapshots) => snapshots.find((snapshot) => snapshot.active) || null

const exportSaveStateFromReply = async (client, includeSnapshots) => {
  const reply = await dispatchCommand(client, "exportSaveState", { includeSnapshots }, true, commandTimeoutMs * 3)
  client.lastSeenAt = Date.now()
  return {
    filename: String(reply.result?.filename || "apple2ts.a2ts"),
    mimeType: String(reply.result?.mimeType || "text/plain"),
    dataBase64: String(reply.result?.dataBase64 || ""),
  }
}

const importSaveStateFromReply = async (client, dataBase64) => {
  const status = await getStatusFromReply(client, "importSaveState", { dataBase64 })
  client.latestState = status
  client.lastSeenAt = Date.now()
  return getMachineResource(status)
}

const sendSseEvent = (res, eventName, data) => {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

const failPendingCommandsForClient = (clientId, errorMessage) => {
  for (const [commandId, pending] of pendingCommands.entries()) {
    if (pending.clientId !== clientId) continue
    clearTimeout(pending.timeout)
    pending.reject(new Error(errorMessage))
    pendingCommands.delete(commandId)
  }
}

const dispatchCommand = (client, action, payload, waitForReply = true, waitMs = commandTimeoutMs) => {
  if (!client || !client.eventStream) {
    return Promise.reject(new Error("No connected browser client is available"))
  }

  const commandId = randomUUID()
  sendSseEvent(client.eventStream, "command", { commandId, action, payload })

  if (!waitForReply) {
    return Promise.resolve({ commandId, accepted: true })
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(commandId)
      reject(new Error(`Timed out waiting for command '${action}'`))
    }, waitMs)

    pendingCommands.set(commandId, {
      clientId: client.clientId,
      resolve,
      reject,
      timeout,
    })
  })
}

const serveStaticFile = async (res, pathname) => {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname
  const resolvedPath = path.resolve(distDir, `.${normalizedPath}`)
  const safeRoot = `${distDir}${path.sep}`
  if (resolvedPath !== distDir && !resolvedPath.startsWith(safeRoot)) {
    writeJson(res, 403, { error: "Forbidden" })
    return
  }

  let filePath = resolvedPath
  try {
    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html")
    }
  } catch {
    filePath = path.join(distDir, "index.html")
  }

  try {
    const canonicalPath = await fs.realpath(filePath)
    if (canonicalPath !== distDir && !canonicalPath.startsWith(safeRoot)) {
      writeJson(res, 403, { error: "Forbidden" })
      return
    }
    const data = await fs.readFile(canonicalPath)
    const ext = path.extname(canonicalPath)
    res.statusCode = 200
    res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream")
    res.end(data)
  } catch (error) {
    writeJson(res, 404, { error: "File not found", details: error.message })
  }
}

const serveFile = async (res, filePath) => {
  try {
    const data = await fs.readFile(filePath)
    const ext = path.extname(filePath)
    res.statusCode = 200
    res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream")
    res.end(data)
  } catch (error) {
    writeJson(res, 404, { error: "File not found", details: error.message })
  }
}

const server = createServer(async (req, res) => {
  setCorsHeaders(res)

  if (!req.url) {
    writeJson(res, 400, { error: "Missing request URL" })
    return
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)

  if (isPrivateControllerPath(url.pathname) && !controllerRequestMatches(req)) {
    writePrivateControllerError(res)
    return
  }

  try {
    // Health check endpoint
    if (req.method === "GET" && url.pathname === "/api/health") {
      setCorsHeaders(res)
      res.statusCode = 200
      res.setHeader("Content-Type", "application/json; charset=utf-8")
      res.end(JSON.stringify({ status: "ok" }))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/client/connect") {
      const body = await readJsonBody(req)
      if (!rendererCredentialsMatch(body)) {
        writePrivateRendererError(res, 403, "Renderer credentials do not match this private server.")
        return
      }

      if (privateRenderer?.clientId) {
        writeJson(res, 200, { clientId: privateRenderer.clientId })
        return
      }

      const clientId = randomUUID()
      clients.set(clientId, {
        clientId,
        rendererId: privateRenderer ? body.rendererId : clientId,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        pathname: body.pathname || "/",
        userAgent: body.userAgent || "",
        latestState: null,
        eventStream: null,
        heartbeat: null,
      })
      if (privateRenderer) privateRenderer.clientId = clientId
      writeJson(res, 200, { clientId })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/client/events") {
      const clientId = url.searchParams.get("clientId")
      const client = clientId ? clients.get(clientId) : null
      if (!client) {
        writeJson(res, 404, { error: "Unknown client" })
        return
      }
      if (!rendererRequestMatches(url, client)) {
        writePrivateRendererError(res, 403, "Renderer credentials do not match this private server.")
        return
      }
      if (client.eventStream) {
        writePrivateRendererError(res, 409, "The renderer already has an active event stream.")
        return
      }

      res.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
      })

      client.lastSeenAt = Date.now()
      client.eventStream = res
      cancelPrivateRendererDisconnect()
      client.heartbeat = setInterval(() => {
        res.write(": keep-alive\n\n")
      }, 15000)
      sendSseEvent(res, "hello", { clientId })

      req.on("close", () => {
        if (client.heartbeat) clearInterval(client.heartbeat)
        client.heartbeat = null
        if (client.eventStream === res) {
          client.eventStream = null
          schedulePrivateRendererDisconnect()
        }
        client.lastSeenAt = Date.now()
        failPendingCommandsForClient(clientId, "Browser client disconnected")
      })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/client/state") {
      const body = await readJsonBody(req)
      const client = clients.get(body.clientId)
      if (!client) {
        writeJson(res, 404, { error: "Unknown client" })
        return
      }
      if (!rendererCredentialsMatch(body) || (privateRenderer && client.clientId !== privateRenderer.clientId)) {
        writePrivateRendererError(res, 403, "Renderer credentials do not match this private server.")
        return
      }
      client.lastSeenAt = Date.now()
      client.latestState = body.state || null
      clientStateObserver?.(client.latestState)
      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/client/reply") {
      const body = await readJsonBody(req)
      const client = clients.get(body.clientId)
      if (!client || !rendererCredentialsMatch(body) || (privateRenderer && client.clientId !== privateRenderer.clientId)) {
        writePrivateRendererError(res, 403, "Renderer credentials do not match this private server.")
        return
      }
      const pending = pendingCommands.get(body.commandId)
      if (!pending) {
        writeJson(res, 404, { error: "Unknown command" })
        return
      }
      if (pending.clientId !== body.clientId) {
        writePrivateRendererError(res, 403, "The command belongs to another renderer.")
        return
      }

      clearTimeout(pending.timeout)
      pendingCommands.delete(body.commandId)

      if (body.ok === false) {
        pending.reject(new Error(body.error || "Command failed"))
      } else {
        pending.resolve({
          clientId: body.clientId,
          commandId: body.commandId,
          result: body.result,
        })
      }

      writeJson(res, 200, { ok: true })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/machine") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await getFreshMachineResource(client))
      return
    }

    if (req.method === "PATCH" && url.pathname === "/api/machine") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      const keys = Object.keys(body)
      if (keys.length === 0) {
        writeErrorEnvelope(res, 400, "BAD_REQUEST", "At least one machine field must be provided.")
        return
      }
      const unknownKeys = keys.filter((key) => !allowedMachinePatchFields.has(key))
      if (unknownKeys.length > 0) {
        writeErrorEnvelope(res, 400, "BAD_REQUEST", `Unknown machine fields: ${unknownKeys.join(", ")}`)
        return
      }

      try {
        writeEnvelope(res, 200, await applyMachinePatch(client, body))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "POST" && url.pathname === "/api/machine/boot") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await applyLifecycleAction(client, "boot"))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/machine/reset") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await applyLifecycleAction(client, "reset"))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/machine/pause") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await applyLifecycleAction(client, "pause"))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/machine/resume") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await applyLifecycleAction(client, "resume"))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/input/keys") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      try {
        if (body.type === "key") {
          if (typeof body.key !== "string" || body.key.length === 0) {
            throw new Error("key is required for type 'key'")
          }
          writeEnvelope(
            res,
            200,
            await dispatchAcceptedInput(client, "keypress", {
              key: body.key,
              release: body.release !== false,
            }),
          )
          return
        }

        if (body.type === "keyCode") {
          const keyCode = parseInteger(body.keyCode)
          if (keyCode === null) {
            throw new Error("keyCode is required for type 'keyCode'")
          }
          writeEnvelope(
            res,
            200,
            await dispatchAcceptedInput(client, "keypress", {
              key: keyCode,
              release: body.release !== false,
            }),
          )
          return
        }

        if (body.type === "keyState") {
          const keyCode = typeof body.key === "string" && body.key.length === 1
            ? body.key.charCodeAt(0)
            : 0
          if (keyCode < 1 || keyCode > 255) {
            throw new Error("key must be one character with a code from 1 through 255 for type 'keyState'")
          }
          if (typeof body.isDown !== "boolean") {
            throw new Error("isDown is required for type 'keyState'")
          }
          if (body.repeat !== undefined && typeof body.repeat !== "boolean") {
            throw new Error("repeat must be a boolean for type 'keyState'")
          }
          writeEnvelope(
            res,
            200,
            await dispatchAcceptedInput(client, "setKeyboardState", {
              key: body.key,
              isDown: body.isDown,
              repeat: body.repeat === true,
            }),
          )
          return
        }

        if (body.type === "text") {
          if (typeof body.text !== "string") {
            throw new Error("text is required for type 'text'")
          }
          writeEnvelope(res, 200, await dispatchAcceptedInput(client, "pasteText", { text: body.text }))
          return
        }

        throw new Error("type must be one of 'key', 'keyCode', 'keyState', or 'text'")
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "POST" && url.pathname === "/api/input/apple-keys") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      try {
        if (body.side !== "left" && body.side !== "right") {
          throw new Error("side must be 'left' or 'right'")
        }
        if (typeof body.pressed !== "boolean") {
          throw new Error("pressed must be a boolean")
        }
        writeEnvelope(res, 200, await dispatchAcceptedInput(client, "appleKey", body))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "POST" && url.pathname === "/api/input/mouse") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      try {
        const x = parseInteger(body.x)
        const y = parseInteger(body.y)
        const buttons = parseInteger(body.buttons)
        if (x === null || y === null || buttons === null) {
          throw new Error("x, y, and buttons must be integers")
        }
        writeEnvelope(res, 200, await dispatchAcceptedInput(client, "mouseEvent", { x, y, buttons }))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/drives") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, getDriveResources(await getFreshStatus(client)))
      return
    }

    if (req.method === "GET" && url.pathname === "/api/debug/memory/full") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      try {
        writeEnvelope(res, 200, await getMemoryDumpFromReply(client))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/private/screen") {
      if (!privateRenderer) {
        writeErrorEnvelope(res, 404, "NOT_FOUND", "Screen capture requires a private emulator session.")
        return
      }
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      try {
        writeEnvelope(res, 200, await getRenderedScreenFromReply(client))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/private/memory") {
      if (!privateRenderer) {
        writeErrorEnvelope(res, 404, "NOT_FOUND", "Physical memory requires a private emulator session.")
        return
      }
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      let space = "active"
      try {
        const address = parseInteger(url.searchParams.get("start"))
        const length = parseInteger(url.searchParams.get("length"))
        space = url.searchParams.get("space") || "active"
        const auxBankText = url.searchParams.get("auxBank")
        const auxBank = auxBankText === null ? undefined : parseInteger(auxBankText)
        if (address === null || length === null) {
          throw new Error("start and length query parameters are required")
        }
        validateMemoryBounds(address, length)
        if (!["active", "main", "aux"].includes(space)) {
          throw new Error("space must be 'active', 'main', or 'aux'")
        }
        if (auxBankText !== null && auxBank === null) {
          throw new Error("auxBank must be an integer")
        }
        writeEnvelope(res, 200, await getMemoryViewFromReply(client, {
          address,
          length,
          space,
          ...(auxBank === undefined ? {} : {auxBank}),
        }))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          space === "active" && detail === "Memory is available only while the emulator is paused"
            ? "Memory dump unavailable for the requested range. Pause the emulator first."
            : detail,
        )
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/debug/memory") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      try {
        const start = parseInteger(url.searchParams.get("start"))
        const length = parseInteger(url.searchParams.get("length"))
        const format = url.searchParams.get("format") || "bytes"

        if (start === null || length === null) {
          throw new Error("start and length query parameters are required")
        }
        if (format !== "bytes" && format !== "hex") {
          throw new Error("format must be 'bytes' or 'hex'")
        }

        validateMemoryBounds(start, length)

        const memoryDump = await getMemoryDumpFromReply(client)
        if (memoryDump.byteLength < start + length) {
          throw new Error("Memory dump unavailable for the requested range. Pause the emulator first.")
        }

        writeEnvelope(res, 200, getMemoryRangeResource(memoryDump.data, start, length, format))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "PUT" && url.pathname === "/api/debug/memory") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      let start
      let bytes
      try {
        start = parseInteger(body.start)
        bytes = Array.isArray(body.data) ? body.data.map((value) => Number(value)) : null
        if (start === null || !bytes) {
          throw new Error("start and data are required")
        }
        if (bytes.length === 0) {
          throw new Error("data must contain at least one byte")
        }
        if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
          throw new Error("data must be an array of byte values between 0 and 255")
        }

        validateMemoryBounds(start, bytes.length)
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
        return
      }

      try {
        const status = await getStatusFromReply(client, "writeMemory", {
          address: start,
          data: bytes,
        })
        client.latestState = status
        client.lastSeenAt = Date.now()

        writeEnvelope(res, 200, { address: start, bytesProcessed: bytes.length })
      } catch (error) {
        writeErrorEnvelope(
          res,
          500,
          "MEMORY_WRITE_FAILED",
          `Memory write may have partially taken effect. ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return
    }

    const isBinaryInput = req.method === "PUT" && url.pathname === "/api/debug/binary"

    if (isBinaryInput && !privateRenderer) {
      req.resume()
      writeErrorEnvelope(res, 404, "NOT_FOUND", "Binary loading requires a private emulator session.")
      return
    }

    if (isBinaryInput) {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      try {
        const contentType = req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase()
        if (contentType !== "application/octet-stream") {
          throw new Error("Content-Type must be application/octet-stream")
        }
        const address = parseInteger(url.searchParams.get("address"))
        if (address === null) {
          throw new Error("address query parameter is required")
        }
        const bytes = await readBinaryBody(req)
        const result = await loadBinaryBlock(client, address, bytes)
        writeEnvelope(res, 200, {
          address,
          bytesWritten: result.bytesWritten,
          sha256: result.sha256,
        })
      } catch (error) {
        req.resume()
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/debug/soft-switches") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, getSoftSwitchResource(await getFreshStatus(client)))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/soft-switches") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      try {
        const addresses = Array.isArray(body.addresses) ? body.addresses.map((value) => Number(value)) : null
        if (!addresses) {
          throw new Error("addresses is required")
        }
        if (addresses.some((value) => !Number.isInteger(value))) {
          throw new Error("addresses must contain integer soft-switch addresses")
        }
        const status = await getStatusFromReply(client, "setSoftSwitches", { addresses })
        client.latestState = status
        client.lastSeenAt = Date.now()
        writeEnvelope(res, 200, getSoftSwitchResource(status))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/step-into") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await applyDebugStep(client, "into"))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/step-over") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await applyDebugStep(client, "over"))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/step-out") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await applyDebugStep(client, "out"))
      return
    }

    if (req.method === "GET" && url.pathname === "/api/debug/cpu") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await getFreshCpuResource(client))
      return
    }

    if (req.method === "PATCH" && url.pathname === "/api/debug/cpu") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      const keys = Object.keys(body)
      if (keys.length === 0) {
        writeErrorEnvelope(res, 400, "BAD_REQUEST", "At least one CPU field must be provided.")
        return
      }
      const unknownKeys = keys.filter((key) => !allowedCpuPatchFields.has(key))
      if (unknownKeys.length > 0) {
        writeErrorEnvelope(res, 400, "BAD_REQUEST", `Unknown CPU fields: ${unknownKeys.join(", ")}`)
        return
      }

      try {
        writeEnvelope(res, 200, await applyCpuPatch(client, body))
      } catch (error) {
        writeErrorEnvelope(
          res,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : String(error),
        )
      }
      return
    }

    if (req.method === "GET" && url.pathname === "/api/debug/breakpoints") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await getBreakpointListResource(await getBreakpointsFromReply(client)))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/breakpoints") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const body = await readJsonBody(req)
      if (!Number.isFinite(Number(body.address))) {
        writeErrorEnvelope(res, 400, "BAD_REQUEST", "Breakpoint address is required.")
        return
      }

      const breakpoints = await getBreakpointsFromReply(client)
      const nextBreakpoint = {
        ...body,
        address: Number(body.address),
      }
      const filtered = breakpoints.filter((breakpoint) => Number(breakpoint.address) !== nextBreakpoint.address)
      filtered.push(nextBreakpoint)
      const nextResources = await setBreakpointsAndReadBack(client, filtered)
      writeEnvelope(res, 200, findBreakpointResourceByAddress(nextResources, nextBreakpoint.address))
      return
    }

    if (req.method === "DELETE" && url.pathname === "/api/debug/breakpoints") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await setBreakpointsAndReadBack(client, []))
      return
    }

    if (url.pathname === "/api/drives" || url.pathname.startsWith("/api/drives/")) {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const mountPrefix = "/api/drives/"
      const mountSuffix = "/mount"
      const isMountRoute = req.method === "POST" && url.pathname.startsWith(mountPrefix) && url.pathname.endsWith(mountSuffix)
      const driveId = isMountRoute
        ? decodeURIComponent(url.pathname.slice(mountPrefix.length, -mountSuffix.length))
        : getDriveIdFromPath(url.pathname)
      const normalizedDriveId = getDriveIdOrNull(driveId)

      if (!normalizedDriveId) {
        writeErrorEnvelope(res, 404, "NOT_FOUND", "Drive not found.")
        return
      }

      const status = await getFreshStatus(client)
      const driveResources = getDriveResources(status)
      const drive = findDriveResourceById(driveResources, normalizedDriveId)
      if (!drive) {
        writeErrorEnvelope(res, 404, "NOT_FOUND", "Drive not found.")
        return
      }

      if (req.method === "GET" && url.pathname === `/api/drives/${normalizedDriveId}`) {
        writeEnvelope(res, 200, drive)
        return
      }

      if (req.method === "PATCH" && url.pathname === `/api/drives/${normalizedDriveId}`) {
        const body = await readJsonBody(req)
        try {
          const keys = Object.keys(body)
          if (keys.length === 0) {
            throw new Error("At least one drive field must be provided.")
          }
          if (keys.some((key) => key !== "writeProtected")) {
            throw new Error("Unknown drive fields. Only 'writeProtected' is supported.")
          }
          if (typeof body.writeProtected !== "boolean") {
            throw new Error("writeProtected must be a boolean")
          }

          const reply = await dispatchCommand(client, "setDriveWriteProtected", {
            driveIndex: drive.index,
            isWriteProtected: body.writeProtected,
          }, true)
          const nextStatus = updateClientStatusFromCommandResult(client, reply.result)
          const nextDrive = findDriveResourceById(getDriveResources(nextStatus || status), normalizedDriveId)
          writeEnvelope(res, 200, nextDrive || drive)
        } catch (error) {
          writeErrorEnvelope(
            res,
            400,
            "BAD_REQUEST",
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }

      if (req.method === "DELETE" && url.pathname === `/api/drives/${normalizedDriveId}`) {
        const reply = await dispatchCommand(client, "ejectDisk", { driveIndex: drive.index }, true)
        const nextStatus = updateClientStatusFromCommandResult(client, reply.result)
        const nextDrive =
          getMountedDriveResourceFromResult(reply.result, normalizedDriveId) ||
          findDriveResourceById(getDriveResources(nextStatus || status), normalizedDriveId) ||
          drive
        writeEnvelope(res, 200, nextDrive)
        return
      }

      if (isMountRoute && driveId === normalizedDriveId) {
        const body = await readJsonBody(req)
        try {
          if (typeof body.sourceType !== "string") {
            throw new Error("sourceType is required")
          }

          let reply
          switch (body.sourceType) {
            case "base64": {
              if (typeof body.dataBase64 !== "string" || !body.dataBase64) {
                throw new Error("dataBase64 is required for sourceType 'base64'")
              }
              if (typeof body.filename !== "string" || !body.filename) {
                throw new Error("filename is required for sourceType 'base64'")
              }
              reply = await dispatchCommand(client, "mountDisk", {
                driveIndex: drive.index,
                filename: body.filename,
                dataBase64: body.dataBase64,
              }, true)
              break
            }

            case "url": {
              if (typeof body.url !== "string" || !body.url) {
                throw new Error("url is required for sourceType 'url'")
              }
              reply = await dispatchCommand(client, "mountDiskFromUrl", {
                driveIndex: drive.index,
                url: body.url,
              }, true, commandTimeoutMs * 3)
              break
            }

            case "library-id": {
              if (typeof body.libraryId !== "string" || !body.libraryId) {
                throw new Error("libraryId is required for sourceType 'library-id'")
              }
              reply = await dispatchCommand(client, "mountDiskFromUrl", {
                driveIndex: drive.index,
                url: `a2ia://${body.libraryId}`,
              }, true, commandTimeoutMs * 3)
              break
            }

            case "binary-block": {
              if (typeof body.dataBase64 !== "string" || !body.dataBase64) {
                throw new Error("dataBase64 is required for sourceType 'binary-block'")
              }
              const address = parseInteger(body.address)
              if (address === null) {
                throw new Error("address is required for sourceType 'binary-block'")
              }
              reply = await dispatchCommand(client, "mountBinaryBlock", {
                address,
                autoRun: body.autoRun !== false,
                dataBase64: body.dataBase64,
              }, true)
              break
            }

            case "basic-text": {
              if (typeof body.text !== "string" || !body.text) {
                throw new Error("text is required for sourceType 'basic-text'")
              }
              reply = await dispatchCommand(client, "mountBasicText", {
                text: body.text,
                autoRun: body.autoRun !== false,
              }, true)
              break
            }

            default:
              throw new Error("Unsupported sourceType")
          }

          const nextStatus = updateClientStatusFromCommandResult(client, reply.result)
          const nextDrive =
            getMountedDriveResourceFromResult(reply.result, normalizedDriveId) ||
            findDriveResourceById(getDriveResources(nextStatus || status), normalizedDriveId) ||
            drive
          writeEnvelope(res, 200, nextDrive)
        } catch (error) {
          writeErrorEnvelope(
            res,
            400,
            "BAD_REQUEST",
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }
    }

    if (url.pathname.startsWith("/api/debug/breakpoints/")) {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }

      const breakpointId = decodeURIComponent(url.pathname.slice("/api/debug/breakpoints/".length))
      const address = parseBreakpointId(breakpointId)
      if (address === null) {
        writeErrorEnvelope(res, 404, "NOT_FOUND", "Breakpoint not found.")
        return
      }

      const breakpoints = await getBreakpointsFromReply(client)
      const index = breakpoints.findIndex((breakpoint) => Number(breakpoint.address) === address)
      if (index < 0) {
        writeErrorEnvelope(res, 404, "NOT_FOUND", "Breakpoint not found.")
        return
      }

      if (req.method === "PATCH") {
        const body = await readJsonBody(req)
        const nextBreakpoint = {
          ...breakpoints[index],
          ...body,
          address: "address" in body ? Number(body.address) : address,
        }
        const filtered = breakpoints.filter((_, breakpointIndex) => breakpointIndex !== index)
        filtered.push(nextBreakpoint)
        const nextResources = await setBreakpointsAndReadBack(client, filtered)
        writeEnvelope(res, 200, findBreakpointResourceByAddress(nextResources, nextBreakpoint.address))
        return
      }

      if (req.method === "DELETE") {
        const filtered = breakpoints.filter((_, breakpointIndex) => breakpointIndex !== index)
        writeEnvelope(res, 200, await setBreakpointsAndReadBack(client, filtered))
        return
      }
    }

    if (req.method === "GET" && url.pathname === "/api/debug/snapshots") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      writeEnvelope(res, 200, await getSnapshotsFromReply(client))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/snapshots") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      const snapshots = await applySnapshotAction(client, "createSnapshot")
      writeEnvelope(res, 200, getActiveSnapshot(snapshots))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/snapshots/step-back") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      const snapshots = await applySnapshotAction(client, "stepSnapshotBack")
      writeEnvelope(res, 200, getActiveSnapshot(snapshots))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/debug/snapshots/step-forward") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      const snapshots = await applySnapshotAction(client, "stepSnapshotForward")
      writeEnvelope(res, 200, getActiveSnapshot(snapshots))
      return
    }

    if (req.method === "POST" && /\/api\/debug\/snapshots\/[^/]+\/activate$/.test(url.pathname)) {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      const snapshotId = decodeURIComponent(url.pathname.slice("/api/debug/snapshots/".length, -"/activate".length))
      if (!/^snap:\d+$/.test(snapshotId)) {
        writeErrorEnvelope(res, 404, "NOT_FOUND", "Snapshot not found.")
        return
      }
      const snapshots = await applySnapshotAction(client, "activateSnapshot", { snapshotId })
      writeEnvelope(res, 200, getActiveSnapshot(snapshots))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/save-states/export") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      const body = await readJsonBody(req)
      writeEnvelope(res, 200, await exportSaveStateFromReply(client, Boolean(body.includeSnapshots)))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/save-states/import") {
      const client = getConnectedClient()
      if (!client) {
        writeNoConnectedClientError(res)
        return
      }
      const body = await readJsonBody(req)
      const dataBase64 = String(body.dataBase64 || "")
      if (!dataBase64) {
        writeErrorEnvelope(res, 400, "BAD_REQUEST", "dataBase64 is required.")
        return
      }
      writeEnvelope(res, 200, await importSaveStateFromReply(client, dataBase64))
      return
    }

    if (req.method === "GET" && url.pathname === "/openapi.json") {
      await serveFile(res, path.join(serverDir, "openapi.json"))
      return
    }

    if (req.method === "GET" && (url.pathname === "/docs" || url.pathname === "/docs/")) {
      await serveFile(res, path.join(serverDir, "swagger.html"))
      return
    }

    await serveStaticFile(res, url.pathname)
  } catch (error) {
    writeJson(res, 500, {
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    })
  }
})

export const resolveBrowserBuildDir = (candidate = process.env.APPLE2TS_DIST_DIR) => {
  if (!candidate) return defaultDistDir
  if (!path.isAbsolute(candidate)) {
    throw new Error("APPLE2TS_DIST_DIR must be an absolute path")
  }
  return path.normalize(candidate)
}

export const getMissingBrowserBuildMessage = (browserBuildDir = resolveBrowserBuildDir()) =>
  `Cannot start the Apple2TS browser: missing ${path.join(browserBuildDir, "index.html")}. `
  + "Build Apple2TS in its source repository and set APPLE2TS_DIST_DIR to that dist directory."

export const hasBrowserBuild = async (browserBuildDir = resolveBrowserBuildDir()) => {
  let hasDist = true
  try {
    await fs.access(path.join(browserBuildDir, "index.html"))
  } catch {
    hasDist = false
  }

  return hasDist
}

export const startApple2tsServer = async (options = {}) => {
  if (server.listening) {
    throw new Error("Apple2TS server is already listening")
  }

  host = options.host || "127.0.0.1"
  port = Number(options.port ?? process.env.PORT ?? 6502)
  const selectedDistDir = resolveBrowserBuildDir(options.distDir)
  try {
    distDir = await fs.realpath(selectedDistDir)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    distDir = selectedDistDir
  }
  commandTimeoutMs = Number(options.commandTimeoutMs ?? process.env.COMMAND_TIMEOUT_MS ?? 10000)
  serverInstanceId = options.serverInstanceId || randomUUID()
  logger = options.logger || console
  clientStateObserver = typeof options.onClientState === "function" ? options.onClientState : null
  if (
    options.privateRenderer &&
    (!options.privateRenderer.remoteControlToken ||
      !options.privateRenderer.rendererId ||
      !options.privateRenderer.controllerToken)
  ) {
    throw new Error("Private renderer mode requires renderer, remote-control, and controller identities")
  }
  privateRenderer = options.privateRenderer
    ? {
        remoteControlToken: String(options.privateRenderer.remoteControlToken),
        rendererId: String(options.privateRenderer.rendererId),
        controllerToken: String(options.privateRenderer.controllerToken),
        clientId: null,
        disconnectGraceMs: Number(options.privateRenderer.disconnectGraceMs ?? 0),
        disconnectTimer: null,
        onDisconnect: options.privateRenderer.onDisconnect,
      }
    : null

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    await stopApple2tsServer()
    throw new Error("Apple2TS server did not acquire a TCP listener")
  }

  const url = `http://${address.address}:${address.port}`
  logger.log?.(`Apple2TS server listening on ${url} (localhost only)`)
  if (!(await hasBrowserBuild(distDir))) {
    logger.log?.(getMissingBrowserBuildMessage(distDir))
  }

  return { url, host: address.address, port: address.port, serverInstanceId }
}

export const stopApple2tsServer = async () => {
  cancelPrivateRendererDisconnect()
  for (const client of clients.values()) {
    if (client.heartbeat) clearInterval(client.heartbeat)
    client.heartbeat = null
    if (client.eventStream && !client.eventStream.destroyed) client.eventStream.destroy()
    client.eventStream = null
    failPendingCommandsForClient(client.clientId, "Apple2TS server stopped")
  }
  clients.clear()
  privateRenderer = null
  clientStateObserver = null

  if (!server.listening) return
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections?.()
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  startApple2tsServer().catch((error) => {
    process.stderr.write(`Failed to start Apple2TS server: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
