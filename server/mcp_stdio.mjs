#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, lstat, mkdtemp, open, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

import {
  hasBrowserBuild,
  getMissingBrowserBuildMessage,
  resolveBrowserBuildDir,
  startApple2tsServer,
  stopApple2tsServer,
} from "./server.mjs"

const SERVER_NAME = "apple2ts"
const SERVER_VERSION = "0.1.0"
const DEFAULT_STARTUP_TIMEOUT_MS = 10000
const BROWSER_EXIT_TIMEOUT_MS = 2000
const CHILD_STDERR_LIMIT = 8192
const READ_TIMEOUT_MS = 2000
const MUTATION_RESPONSE_MARGIN_MS = 1000
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 10000)
const MUTATION_TIMEOUT_MS = COMMAND_TIMEOUT_MS + MUTATION_RESPONSE_MARGIN_MS
// Mounting asks the renderer for fresh status before it performs the mount.
// A rejected image then needs one more fresh-status request to confirm that no
// media was mounted, so retain one shared budget for all three requests.
const MOUNT_TIMEOUT_MS = COMMAND_TIMEOUT_MS * 3 + MUTATION_RESPONSE_MARGIN_MS
const MAX_BINARY_BYTES = 0xC000
const MAX_FLOPPY_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_HARD_DRIVE_IMAGE_BYTES = 32 * 1024 * 1024
const STANDARD_FLOPPY_IMAGE_BYTES = 143360
const DRIVE_IDS = ["hd1", "hd2", "fd1", "fd2"]
const CPU_PATCH_MAXIMUMS = Object.freeze({
  PC: 65535,
  A: 255,
  X: 255,
  Y: 255,
  S: 255,
  PStatus: 255,
})

class ConfirmedMutationRejection extends Error {
  constructor(error) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = "ConfirmedMutationRejection"
  }
}

const noInputSchema = fromJsonSchema({
  type: "object",
  properties: {},
  additionalProperties: false,
})

const speedInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    speed: { type: "integer", enum: [-2, -1, 0, 1, 2, 3, 4] },
  },
  required: ["speed"],
  additionalProperties: false,
})

const keyboardKeyInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    key: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: 1,
      pattern: "^[\\u0001-\\u00FF]$",
    },
    repeat: { type: "boolean", default: false },
  },
  required: ["key"],
  additionalProperties: false,
})

const driveInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    driveId: { type: "string", enum: DRIVE_IDS },
  },
  required: ["driveId"],
  additionalProperties: false,
})

const diskMountInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    driveId: { type: "string", enum: DRIVE_IDS },
    path: { type: "string", minLength: 1 },
  },
  required: ["driveId", "path"],
  additionalProperties: false,
})

const fileStageInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
  },
  required: ["path"],
  additionalProperties: false,
})

const emulatorIdentitySchema = {
  type: "object",
  properties: {
    serverInstanceId: { type: "string" },
    rendererId: { type: "string" },
    targetId: { type: "string" },
  },
  required: ["serverInstanceId", "rendererId", "targetId"],
  additionalProperties: false,
}

const sessionStartResultSchema = fromJsonSchema({
  type: "object",
  properties: { emulator: emulatorIdentitySchema },
  required: ["emulator"],
  additionalProperties: false,
})

const sessionStopResultSchema = fromJsonSchema({
  type: "object",
  properties: { stopped: { type: "boolean" } },
  required: ["stopped"],
  additionalProperties: false,
})

const driveReceiptSchema = {
  type: "object",
  properties: {
    driveId: { type: "string", enum: DRIVE_IDS },
    mounted: { type: "boolean" },
  },
  required: ["driveId", "mounted"],
  additionalProperties: false,
}

const driveResultSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    state: driveReceiptSchema,
  },
  required: ["emulator", "state"],
  additionalProperties: false,
})

const fileStageResultSchema = fromJsonSchema({
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    byteCount: { type: "integer", minimum: 1, maximum: MAX_HARD_DRIVE_IMAGE_BYTES },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
  required: ["path", "byteCount", "sha256"],
  additionalProperties: false,
})

const machineResultSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    state: {
      type: "object",
      properties: {
        runMode: { type: "string", enum: ["idle", "booting", "running", "paused", "resetting"] },
        speedMode: { type: "integer" },
      },
      required: ["runMode", "speedMode"],
      additionalProperties: false,
    },
  },
  required: ["emulator", "state"],
  additionalProperties: false,
})

const memoryReadInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    address: { type: "integer", minimum: 0, maximum: 65535 },
    length: { type: "integer", minimum: 1, maximum: 4096 },
    space: { type: "string", enum: ["active", "main", "aux"], default: "active" },
    auxBank: { type: "integer", minimum: 0, maximum: 127 },
  },
  required: ["address", "length"],
  additionalProperties: false,
})

const memoryReadOutputSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    value: {
      type: "object",
      properties: {
        address: { type: "integer", minimum: 0, maximum: 65535 },
        length: { type: "integer", minimum: 1, maximum: 4096 },
        bytes: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 255 },
          minItems: 1,
          maxItems: 4096,
        },
        requestedSpace: { type: "string", enum: ["active", "main", "aux"] },
        requestedAuxBank: { type: "integer", minimum: 0, maximum: 127 },
        effectiveAuxBank: { type: "integer", minimum: 0, maximum: 127 },
        effectiveSegments: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              address: { type: "integer", minimum: 0, maximum: 65535 },
              length: { type: "integer", minimum: 1, maximum: 4096 },
              space: { type: "string", enum: ["main", "aux", "system"] },
              auxBank: { type: "integer", minimum: 0, maximum: 127 },
            },
            required: ["address", "length", "space"],
            additionalProperties: false,
          },
        },
        mapping: {
          type: "object",
          properties: {
            RAMRD: { type: "boolean" },
            RAMWRT: { type: "boolean" },
            ALTZP: { type: "boolean" },
            "80STORE": { type: "boolean" },
            PAGE2: { type: "boolean" },
            HIRES: { type: "boolean" },
          },
          required: ["RAMRD", "RAMWRT", "ALTZP", "80STORE", "PAGE2", "HIRES"],
          additionalProperties: false,
        },
      },
      required: [
        "address",
        "length",
        "bytes",
        "requestedSpace",
        "effectiveSegments",
        "mapping",
      ],
      additionalProperties: false,
    },
  },
  required: ["emulator", "value"],
  additionalProperties: false,
})

const screenCaptureOutputSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    image: {
      type: "object",
      properties: {
        mimeType: { type: "string", enum: ["image/png"] },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
      },
      required: ["mimeType", "width", "height"],
      additionalProperties: false,
    },
  },
  required: ["emulator", "image"],
  additionalProperties: false,
})

const keyboardKeyOutputSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    value: {
      type: "object",
      properties: {
        heldKey: { type: ["string", "null"] },
      },
      required: ["heldKey"],
      additionalProperties: false,
    },
  },
  required: ["emulator", "value"],
  additionalProperties: false,
})

const binaryLoadInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    address: { type: "integer", minimum: 0, maximum: 49151 },
  },
  required: ["path", "address"],
  additionalProperties: false,
})

const binaryLoadOutputSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    address: { type: "integer", minimum: 0, maximum: 49151 },
    bytesWritten: { type: "integer", minimum: 1, maximum: MAX_BINARY_BYTES },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
  required: ["emulator", "address", "bytesWritten", "sha256"],
  additionalProperties: false,
})

const breakpointInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    address: { type: "integer", minimum: 0, maximum: 65535 },
  },
  required: ["address"],
  additionalProperties: false,
})

const breakpointResultSchema = (extraProperties = {}, extraRequired = []) => fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    value: {
      type: "object",
      properties: {
        address: { type: "integer", minimum: 0, maximum: 65535 },
        breakpointId: { type: "string" },
        ...extraProperties,
      },
      required: ["address", "breakpointId", ...extraRequired],
      additionalProperties: false,
    },
  },
  required: ["emulator", "value"],
  additionalProperties: false,
})

const breakpointClearAllResultSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    value: {
      type: "object",
      properties: { count: { type: "integer", minimum: 0 } },
      required: ["count"],
      additionalProperties: false,
    },
  },
  required: ["emulator", "value"],
  additionalProperties: false,
})

const cpuPatchInputSchema = fromJsonSchema({
  type: "object",
  properties: {
    PC: { type: "integer", minimum: 0, maximum: 65535 },
    A: { type: "integer", minimum: 0, maximum: 255 },
    X: { type: "integer", minimum: 0, maximum: 255 },
    Y: { type: "integer", minimum: 0, maximum: 255 },
    S: { type: "integer", minimum: 0, maximum: 255 },
    PStatus: { type: "integer", minimum: 0, maximum: 255 },
  },
  anyOf: ["PC", "A", "X", "Y", "S", "PStatus"].map((field) => ({ required: [field] })),
  additionalProperties: false,
})

const cpuResultSchema = fromJsonSchema({
  type: "object",
  properties: {
    emulator: emulatorIdentitySchema,
    value: {
      type: "object",
      properties: {
        PC: { type: "integer", minimum: 0, maximum: 65535 },
        A: { type: "integer", minimum: 0, maximum: 255 },
        X: { type: "integer", minimum: 0, maximum: 255 },
        Y: { type: "integer", minimum: 0, maximum: 255 },
        S: { type: "integer", minimum: 0, maximum: 255 },
        PStatus: { type: "integer", minimum: 0, maximum: 255 },
      },
      required: ["PC", "A", "X", "Y", "S", "PStatus"],
      additionalProperties: false,
    },
  },
  required: ["emulator", "value"],
  additionalProperties: false,
})

const executionBreakpoint = (address) => ({
  address,
  watchpoint: false,
  instruction: false,
  disabled: false,
  hidden: false,
  once: false,
  memget: false,
  memset: true,
  expression1: { register: "", address: 0x300, operator: "==", value: 0x80 },
  expression2: { register: "", address: 0x300, operator: "==", value: 0x80 },
  expressionOperator: "",
  hexvalue: -1,
  hitcount: 1,
  nhits: 0,
  memoryBank: "",
  action1: { action: "", register: "A", address: 0x300, value: 0 },
  action2: { action: "", register: "A", address: 0x300, value: 0 },
  halt: false,
  basic: false,
})

const sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error("Startup cancelled"))
      return
    }
    const finish = (callback) => {
      signal.removeEventListener("abort", onAbort)
      callback()
    }
    const timeout = setTimeout(() => finish(resolve), milliseconds)
    const onAbort = () => {
      clearTimeout(timeout)
      finish(() => reject(signal.reason || new Error("Startup cancelled")))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

const fetchEnvelope = async (baseUrl, pathname, controllerToken, signal, options = {}, timeoutMs) => {
  const headers = { Authorization: `Bearer ${controllerToken}` }
  if (options.body !== undefined) {
    headers["Content-Type"] = options.contentType || "application/json"
  }
  const method = options.method || "GET"
  const timeoutSignal = AbortSignal.timeout(
    timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS),
  )
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers,
    body: options.body === undefined
      ? undefined
      : options.contentType
        ? options.body
        : JSON.stringify(options.body),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    const detail = payload?.error?.message || payload?.error?.code || payload?.error || `HTTP ${response.status}`
    const error = new Error(`Apple2TS bridge request ${pathname} failed: ${detail}`)
    error.bridgeStatus = response.status
    throw error
  }
  return payload.data
}

const resolveBinaryRoot = async (configuredRoot, settingName = "APPLE2TS_BINARY_ROOT") => {
  if (!configuredRoot) return null
  try {
    const root = await realpath(path.resolve(configuredRoot))
    if (!(await stat(root)).isDirectory()) throw new Error()
    await access(root, fsConstants.R_OK | fsConstants.X_OK)
    return root
  } catch {
    throw new Error(`${settingName} must name a readable directory`)
  }
}

const readAtMost = async (handle, limit) => {
  const buffer = Buffer.allocUnsafe(limit)
  let length = 0
  while (length < limit) {
    const { bytesRead } = await handle.read(buffer, length, limit - length)
    if (bytesRead === 0) break
    length += bytesRead
  }
  return buffer.subarray(0, length)
}

const readTrustedFile = async (root, filePath, noun, maxBytes, rootName = "APPLE2TS_BINARY_ROOT") => {
  if (typeof filePath !== "string" || filePath.length === 0 || path.isAbsolute(filePath)) {
    throw new Error(`path must be a non-empty path relative to ${rootName}`)
  }

  const candidate = path.resolve(root, filePath)
  const relative = path.relative(root, candidate)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path must stay within ${rootName}`)
  }

  let pathInfo
  try {
    pathInfo = await lstat(candidate)
  } catch {
    throw new Error(`${noun} file is unavailable or unreadable`)
  }
  if (pathInfo.isSymbolicLink()) throw new Error("symbolic links are not allowed")
  if (!pathInfo.isFile()) throw new Error("path must name a regular file")

  let resolvedFile
  try {
    resolvedFile = await realpath(candidate)
  } catch {
    throw new Error(`${noun} file is unavailable or unreadable`)
  }
  if (resolvedFile !== candidate) throw new Error("symbolic links are not allowed")

  let handle
  try {
    try {
      handle = await open(
        candidate,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      )
    } catch {
      throw new Error(`${noun} file is unavailable or unreadable`)
    }
    const fileInfo = await handle.stat()
    if (!fileInfo.isFile()) throw new Error("path must name a regular file")
    if (fileInfo.size === 0) throw new Error(`${noun} file must not be empty`)
    if (fileInfo.size > maxBytes) throw new Error(`${noun} file cannot exceed ${maxBytes} bytes`)

    const bytes = await readAtMost(handle, maxBytes + 1)
    if (bytes.length === 0) throw new Error(`${noun} file must not be empty`)
    if (bytes.length > maxBytes) throw new Error(`${noun} file cannot exceed ${maxBytes} bytes`)
    return bytes
  } finally {
    await handle?.close()
  }
}

export class FileStager {
  constructor(sourceRoot, binaryRoot) {
    this.sourceRoot = sourceRoot
    this.binaryRoot = binaryRoot
    this.stageDirectory = null
    this.stages = Promise.resolve()
    this.closing = false
  }

  stage(filePath) {
    if (this.closing) return Promise.reject(new Error("File staging is closing"))
    const stage = this.stages.then(() => this.stageOne(filePath))
    this.stages = stage.catch(() => {})
    return stage
  }

  async stageOne(filePath) {
    const bytes = await readTrustedFile(
      this.sourceRoot,
      filePath,
      "file",
      MAX_HARD_DRIVE_IMAGE_BYTES,
      "APPLE2TS_FILE_SOURCE_ROOT",
    )
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const stageDirectory = await this.getStageDirectory()
    const stagedPath = path.join(stageDirectory, `${sha256}${path.extname(filePath).toLowerCase()}`)
    const temporaryPath = path.join(stageDirectory, `.${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx" })
      await rename(temporaryPath, stagedPath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
    return {
      path: path.relative(this.binaryRoot, stagedPath),
      byteCount: bytes.length,
      sha256,
    }
  }

  async getStageDirectory() {
    if (!this.stageDirectory) {
      this.stageDirectory = await mkdtemp(path.join(this.binaryRoot, ".apple2ts-mcp-stage-"))
    }
    return this.stageDirectory
  }

  async cleanup() {
    this.closing = true
    await this.stages
    if (!this.stageDirectory) return
    const stageDirectory = this.stageDirectory
    await rm(stageDirectory, { recursive: true, force: true })
    this.stageDirectory = null
  }

  read(filePath, noun, maxBytes) {
    if (!this.stageDirectory) throw new Error("path must name a file staged by this MCP session")
    const candidate = path.resolve(this.binaryRoot, filePath)
    const relative = path.relative(this.stageDirectory, candidate)
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("path must name a file staged by this MCP session")
    }
    return readTrustedFile(this.binaryRoot, filePath, noun, maxBytes, "APPLE2TS_FILE_STAGING_ROOT")
  }
}

const classifyDiskImage = (filePath, byteLength) => {
  switch (path.extname(path.basename(filePath)).toLowerCase()) {
    case ".hdv":
    case ".2mg":
    case ".2meg":
      return "hard-drive"
    case ".po":
      return byteLength > STANDARD_FLOPPY_IMAGE_BYTES ? "hard-drive" : "floppy"
    case ".dsk":
    case ".do":
    case ".woz":
      return "floppy"
    default:
      return null
  }
}

const isConfirmedDriveState = (result, driveId, mounted) =>
  result?.state?.driveId === driveId
  && result.state.mounted === mounted

const confirmDriveState = (result, driveId, mounted, operation) => {
  if (!isConfirmedDriveState(result, driveId, mounted)) {
    throw new Error(`Apple2TS did not confirm ${operation} for ${driveId}`)
  }
  return {
    emulator: result.emulator,
    state: { driveId: result.state.driveId, mounted: result.state.mounted },
  }
}

export class Apple2tsCore {
  constructor(
    baseUrl,
    controllerToken,
    identity,
    signal = new AbortController().signal,
    binaryRoot = null,
    fileStager = null,
  ) {
    this.baseUrl = baseUrl
    this.controllerToken = controllerToken
    this.identity = identity
    this.signal = signal
    this.binaryRoot = binaryRoot
    this.fileStager = fileStager
    this.mutations = Promise.resolve()
    this.mutationFailure = null
    this.heldKey = null
  }

  async request(pathname, options, signal = this.signal, timeoutMs) {
    const state = await fetchEnvelope(
      this.baseUrl,
      pathname,
      this.controllerToken,
      signal,
      options,
      timeoutMs,
    )
    return { emulator: this.identity, state }
  }

  readMachine() {
    return this.request("/api/machine")
  }

  readCpu() {
    return this.request("/api/debug/cpu")
  }

  readBreakpoints() {
    return this.request("/api/debug/breakpoints")
  }

  readDrives() {
    return this.request("/api/drives")
  }

  async readSoftSwitches() {
    const result = await this.request("/api/debug/soft-switches")
    return { emulator: result.emulator, softswitches: result.state.switches }
  }

  async readTextScreen() {
    const result = await this.readMachine()
    return {
      emulator: result.emulator,
      state: { textPage: result.state.textPage },
    }
  }

  async captureScreen() {
    const result = await this.request("/api/private/screen")
    return {
      emulator: result.emulator,
      image: {
        mimeType: result.state.mimeType,
        width: result.state.width,
        height: result.state.height,
      },
      dataBase64: result.state.dataBase64,
    }
  }

  serializeMutation(operation, signal, { prepare = false } = {}) {
    const mutation = this.mutations.then(async () => {
      if (this.mutationFailure) throw this.mutationFailure
      if (signal?.aborted) throw signal.reason
      let mutationStarted = !prepare
      let uncertain = false
      const markUncertain = () => {
        if (!mutationStarted) return
        uncertain = true
        this.mutationFailure ||= new Error(
          "The previous mutation did not complete cleanly; restart this MCP session",
        )
      }
      const startMutation = () => {
        if (signal?.aborted) throw signal.reason
        mutationStarted = true
      }
      signal?.addEventListener("abort", markUncertain, { once: true })
      try {
        const result = await operation(startMutation)
        if (uncertain) await this.releaseHeldKeyboard().catch(() => {})
        return result
      } catch (error) {
        if (!(error instanceof ConfirmedMutationRejection)) markUncertain()
        if (uncertain) await this.releaseHeldKeyboard().catch(() => {})
        throw error
      } finally {
        signal?.removeEventListener("abort", markUncertain)
      }
    })
    this.mutations = mutation.catch(() => {})
    return mutation
  }

  changeMachine(pathname, options, signal) {
    return this.serializeMutation(async () => {
      const result = await this.request(pathname, options)
      return {
        emulator: result.emulator,
        state: {
          runMode: result.state.runMode,
          speedMode: result.state.speedMode,
        },
      }
    }, signal)
  }

  reset(signal) {
    return this.changeMachine("/api/machine/reset", { method: "POST" }, signal)
  }

  boot(signal) {
    return this.changeMachine("/api/machine/boot", { method: "POST" }, signal)
  }

  pause(signal) {
    return this.changeMachine("/api/machine/pause", { method: "POST" }, signal)
  }

  resume(signal) {
    return this.changeMachine("/api/machine/resume", { method: "POST" }, signal)
  }

  setSpeed(speed, signal) {
    return this.changeMachine("/api/machine", { method: "PATCH", body: { speedMode: speed } }, signal)
  }

  setKeyboardKey(key, repeat = false, signal) {
    return this.serializeMutation(async () => {
      if (key === this.heldKey) {
        if (key !== null && repeat) await this.sendKeyboardState(key, true, true)
        return { emulator: this.identity, value: { heldKey: this.heldKey } }
      }
      if (this.heldKey !== null) {
        await this.sendKeyboardState(this.heldKey, false)
        this.heldKey = null
      }
      if (key !== null) {
        this.heldKey = key
        await this.sendKeyboardState(key, true, repeat)
      }
      return { emulator: this.identity, value: { heldKey: this.heldKey } }
    }, signal)
  }

  sendKeyboardState(key, isDown, repeat = false, signal = this.signal) {
    return this.request("/api/input/keys", {
      method: "POST",
      body: { type: "keyState", key, isDown, repeat },
    }, signal)
  }

  async releaseHeldKeyboard() {
    if (this.heldKey === null) return
    const key = this.heldKey
    await this.sendKeyboardState(key, false, false, null)
    if (this.heldKey === key) this.heldKey = null
  }

  async neutralizeKeyboard() {
    await this.mutations
    await this.releaseHeldKeyboard()
  }

  stageFile({ path: filePath }) {
    if (!this.fileStager) throw new Error("File staging is not configured")
    return this.fileStager.stage(filePath)
  }

  cleanupStagedFiles() {
    return this.fileStager?.cleanup()
  }

  readInputFile(filePath, noun, maxBytes) {
    return this.fileStager
      ? this.fileStager.read(filePath, noun, maxBytes)
      : readTrustedFile(this.binaryRoot, filePath, noun, maxBytes)
  }

  mountDisk({ driveId, path: filePath }, signal) {
    return this.serializeMutation(async (startMutation) => {
      const hardDrive = driveId === "hd1" || driveId === "hd2"
      const bytes = await this.readInputFile(
        filePath,
        hardDrive ? "hard-drive image" : "floppy image",
        hardDrive ? MAX_HARD_DRIVE_IMAGE_BYTES : MAX_FLOPPY_IMAGE_BYTES,
      )
      const mediaKind = classifyDiskImage(filePath, bytes.length)
      if (mediaKind && mediaKind !== (hardDrive ? "hard-drive" : "floppy")) {
        throw new Error(`${driveId} cannot mount a ${mediaKind} image`)
      }
      startMutation()
      const mountDeadline = Date.now() + MOUNT_TIMEOUT_MS
      const mountRequest = (pathname, options) => this.request(
        pathname,
        options,
        this.signal,
        Math.max(1, mountDeadline - Date.now()),
      )
      let result
      try {
        result = await mountRequest(`/api/drives/${driveId}/mount`, {
          method: "POST",
          body: {
            sourceType: "base64",
            filename: path.basename(filePath),
            dataBase64: bytes.toString("base64"),
          },
        })
      } catch (error) {
        if (error?.bridgeStatus !== 400) throw error
        const current = await mountRequest(`/api/drives/${driveId}`)
        if (!isConfirmedDriveState(current, driveId, false)) throw error
        throw new ConfirmedMutationRejection(error)
      }
      return confirmDriveState(result, driveId, true, "disk mount")
    }, signal, { prepare: true })
  }

  ejectDisk(driveId, signal) {
    return this.serializeMutation(async () => {
      const result = await this.request(`/api/drives/${driveId}`, { method: "DELETE" })
      return confirmDriveState(result, driveId, false, "disk eject")
    }, signal)
  }

  setBreakpoint(address, signal) {
    return this.serializeMutation(async () => {
      const before = await this.request("/api/debug/breakpoints")
      const existing = before.state.find((breakpoint) => breakpoint.address === address)
      if (existing) {
        return {
          emulator: before.emulator,
          value: { address, breakpointId: existing.breakpointId || `bp:${address}` },
        }
      }
      const result = await this.request("/api/debug/breakpoints", {
        method: "POST",
        body: executionBreakpoint(address),
      })
      if (result.state?.address !== address) {
        throw new Error("Apple2TS did not confirm the requested breakpoint")
      }
      return {
        emulator: result.emulator,
        value: { address, breakpointId: result.state.breakpointId },
      }
    }, signal)
  }

  clearBreakpoint(address, signal) {
    return this.serializeMutation(async () => {
      const before = await this.request("/api/debug/breakpoints")
      const cleared = before.state.some((breakpoint) => breakpoint.address === address)
      const result = cleared
        ? await this.request(`/api/debug/breakpoints/bp:${address}`, { method: "DELETE" })
        : before
      if (result.state.some((breakpoint) => breakpoint.address === address)) {
        throw new Error("Apple2TS did not confirm breakpoint removal")
      }
      return {
        emulator: result.emulator,
        value: { address, breakpointId: `bp:${address}`, cleared },
      }
    }, signal)
  }

  clearAllBreakpoints(signal) {
    return this.serializeMutation(async () => {
      const before = await this.request("/api/debug/breakpoints")
      const result = before.state.length === 0
        ? before
        : await this.request("/api/debug/breakpoints", { method: "DELETE" })
      if (result.state.length !== 0) {
        throw new Error("Apple2TS did not confirm breakpoint removal")
      }
      return {
        emulator: result.emulator,
        value: { count: before.state.length },
      }
    }, signal)
  }

  setCpu(patch, signal) {
    const fields = Object.keys(patch)
    if (fields.length < 1 || fields.some((field) => !Object.hasOwn(CPU_PATCH_MAXIMUMS, field))) {
      throw new Error("set_cpu accepts PC, A, X, Y, S, and PStatus")
    }
    for (const field of fields) {
      const maximum = CPU_PATCH_MAXIMUMS[field]
      if (!Number.isInteger(patch[field]) || patch[field] < 0 || patch[field] > maximum) {
        throw new Error(`${field} must be an integer between 0 and ${maximum}`)
      }
    }

    return this.serializeMutation(async () => {
      const result = await this.request("/api/debug/cpu", { method: "PATCH", body: patch })
      return {
        emulator: result.emulator,
        value: {
          PC: result.state.PC,
          A: result.state.A,
          X: result.state.X,
          Y: result.state.Y,
          S: result.state.S,
          PStatus: result.state.PStatus,
        },
      }
    }, signal)
  }

  async readMemory({ address, length, space = "active", auxBank }) {
    if (!Number.isInteger(address) || address < 0 || address > 65535) {
      throw new Error("address must be an integer between 0 and 65535")
    }
    if (!Number.isInteger(length) || length < 1 || length > 4096) {
      throw new Error("length must be an integer between 1 and 4096")
    }
    if (address + length > 65536) {
      throw new Error("Requested memory range exceeds 64 KB address space")
    }
    if (!(["active", "main", "aux"].includes(space))) {
      throw new Error("space must be 'active', 'main', or 'aux'")
    }
    if (auxBank !== undefined && space !== "aux") {
      throw new Error("auxBank is valid only when space is 'aux'")
    }
    if (auxBank !== undefined && (!Number.isInteger(auxBank) || auxBank < 0 || auxBank > 127)) {
      throw new Error("auxBank must be an integer between 0 and 127")
    }
    if (space !== "active" && address + length > 0xC000) {
      throw new Error("Physical memory reads must fit within RAM at $0000-$BFFF")
    }
    const query = new URLSearchParams({
      start: String(address),
      length: String(length),
      space,
    })
    if (auxBank !== undefined) query.set("auxBank", String(auxBank))
    const result = await this.request(`/api/private/memory?${query}`)
    return {
      emulator: result.emulator,
      value: {
        address: result.state.address,
        length: result.state.length,
        bytes: result.state.bytes,
        requestedSpace: result.state.requestedSpace,
        ...(Number.isInteger(result.state.requestedAuxBank)
          ? {requestedAuxBank: result.state.requestedAuxBank}
          : {}),
        ...(Number.isInteger(result.state.effectiveAuxBank)
          ? {effectiveAuxBank: result.state.effectiveAuxBank}
          : {}),
        effectiveSegments: result.state.effectiveSegments,
        mapping: result.state.mapping,
      },
    }
  }

  loadBinary({ path: filePath, address }, signal) {
    return this.serializeMutation(async (startMutation) => {
      const bytes = await this.readInputFile(filePath, "binary", MAX_BINARY_BYTES)
      if (!Number.isInteger(address) || address < 0 || address >= MAX_BINARY_BYTES) {
        throw new Error("address must be an integer between 0 and 49151")
      }
      if (address + bytes.length > MAX_BINARY_BYTES) {
        throw new Error("binary block must fit within main RAM at $0000-$BFFF")
      }
      startMutation()
      const query = new URLSearchParams({ address: String(address) })
      const receipt = await this.request(
        `/api/debug/binary?${query}`,
        { method: "PUT", body: bytes, contentType: "application/octet-stream" },
      )
      return { emulator: receipt.emulator, ...receipt.state }
    }, signal, { prepare: true })
  }
}

const mutationTools = [
  {
    name: "stage_file",
    title: "Stage a local file",
    description: "Copy one file from the configured source directory into this MCP session's trusted input area.",
    inputSchema: fileStageInputSchema,
    outputSchema: fileStageResultSchema,
    destructiveHint: false,
    idempotentHint: true,
    enabled: (session) => session.fileStagingConfigured,
    execute: (core, input) => core.stageFile(input),
  },
  {
    name: "set_keyboard_key",
    title: "Set held keyboard key",
    description: "Hold one keyboard key, or pass null to release the held key.",
    inputSchema: keyboardKeyInputSchema,
    outputSchema: keyboardKeyOutputSchema,
    destructiveHint: false,
    idempotentHint: false,
    execute: (core, input, signal) => core.setKeyboardKey(input.key, input.repeat, signal),
  },
  {
    name: "mount_disk",
    title: "Mount a local disk image",
    description: "Mount one file staged by this MCP session in hd1, hd2, fd1, or fd2. Use stage_file first. Floppy images may be up to 2 MiB; hard-drive images may be up to 32 MiB.",
    inputSchema: diskMountInputSchema,
    outputSchema: driveResultSchema,
    destructiveHint: true,
    idempotentHint: false,
    enabled: (session) => session.fileStagingConfigured,
    execute: (core, input, signal) => core.mountDisk(input, signal),
  },
  {
    name: "eject_disk",
    title: "Eject a disk",
    description: "Eject the disk in hd1, hd2, fd1, or fd2 and return its confirmed mounted-state receipt.",
    inputSchema: driveInputSchema,
    outputSchema: driveResultSchema,
    destructiveHint: true,
    idempotentHint: true,
    execute: (core, input, signal) => core.ejectDisk(input.driveId, signal),
  },
  {
    name: "boot",
    title: "Boot Apple II",
    description: "Boot the emulator and return its confirmed machine state.",
    inputSchema: noInputSchema,
    outputSchema: machineResultSchema,
    destructiveHint: true,
    idempotentHint: false,
    execute: (core, _input, signal) => core.boot(signal),
  },
  {
    name: "reset",
    title: "Reset Apple II",
    description: "Reset the emulator and return its confirmed machine state.",
    inputSchema: noInputSchema,
    outputSchema: machineResultSchema,
    destructiveHint: true,
    idempotentHint: false,
    execute: (core, _input, signal) => core.reset(signal),
  },
  {
    name: "pause",
    title: "Pause Apple II",
    description: "Pause the emulator and return its confirmed machine state.",
    inputSchema: noInputSchema,
    outputSchema: machineResultSchema,
    destructiveHint: false,
    idempotentHint: true,
    execute: (core, _input, signal) => core.pause(signal),
  },
  {
    name: "resume",
    title: "Resume Apple II",
    description: "Resume the emulator and return its confirmed machine state.",
    inputSchema: noInputSchema,
    outputSchema: machineResultSchema,
    destructiveHint: false,
    idempotentHint: true,
    execute: (core, _input, signal) => core.resume(signal),
  },
  {
    name: "set_speed",
    title: "Set Apple II speed",
    description: "Set speed from -2 (0.1 MHz) through 4 (maximum) and return the confirmed machine state.",
    inputSchema: speedInputSchema,
    outputSchema: machineResultSchema,
    destructiveHint: false,
    idempotentHint: true,
    execute: (core, input, signal) => core.setSpeed(input.speed, signal),
  },
  {
    name: "set_breakpoint",
    title: "Set Apple II breakpoint",
    description: "Set an instruction breakpoint and return its confirmed identity.",
    inputSchema: breakpointInputSchema,
    outputSchema: breakpointResultSchema(),
    destructiveHint: false,
    idempotentHint: true,
    execute: (core, input, signal) => core.setBreakpoint(input.address, signal),
  },
  {
    name: "clear_breakpoint",
    title: "Clear Apple II breakpoint",
    description: "Clear an instruction breakpoint by address and report whether it existed.",
    inputSchema: breakpointInputSchema,
    outputSchema: breakpointResultSchema({ cleared: { type: "boolean" } }, ["cleared"]),
    destructiveHint: true,
    idempotentHint: true,
    execute: (core, input, signal) => core.clearBreakpoint(input.address, signal),
  },
  {
    name: "clear_all_breakpoints",
    title: "Clear all Apple II breakpoints",
    description: "Clear every breakpoint and return the number removed.",
    inputSchema: noInputSchema,
    outputSchema: breakpointClearAllResultSchema,
    destructiveHint: true,
    idempotentHint: true,
    execute: (core, _input, signal) => core.clearAllBreakpoints(signal),
  },
  {
    name: "set_cpu",
    title: "Set Apple II CPU state",
    description: "Set CPU registers or processor status and return confirmed CPU state.",
    inputSchema: cpuPatchInputSchema,
    outputSchema: cpuResultSchema,
    destructiveHint: true,
    idempotentHint: true,
    execute: (core, input, signal) => core.setCpu(input, signal),
  },
]

const toolResult = (result) => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
})

const memoryReadResult = (result) => {
  const {address, length, requestedSpace} = result.value
  const space = requestedSpace === "active"
    ? "active memory"
    : requestedSpace === "aux" ? "auxiliary RAM" : "main RAM"
  const byteLabel = length === 1 ? "byte" : "bytes"
  const addressLabel = address.toString(16).toUpperCase().padStart(4, "0")
  return {
    content: [{type: "text", text: `Read ${length} ${byteLabel} from ${space} at $${addressLabel}.`}],
    structuredContent: result,
  }
}

const screenCaptureResult = ({ dataBase64, ...result }) => ({
  content: [
    { type: "image", data: dataBase64, mimeType: result.image.mimeType },
    { type: "text", text: JSON.stringify(result) },
  ],
  structuredContent: result,
})

export const createMcpServer = (session) => {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const core = () => session.requireCore()

  const resources = [
    {
      name: "machine",
      uri: "apple2ts://machine",
      title: "Apple2TS machine state",
      description: "Current state of the emulator bound to this process.",
      read: () => core().readMachine(),
    },
    {
      name: "cpu",
      uri: "apple2ts://cpu",
      title: "Apple2TS CPU state",
      description: "Current CPU state of the emulator bound to this process.",
      read: () => core().readCpu(),
    },
    {
      name: "breakpoints",
      uri: "apple2ts://debugger/breakpoints",
      title: "Apple2TS breakpoints",
      description: "Current breakpoints for the emulator bound to this process.",
      read: () => core().readBreakpoints(),
    },
    {
      name: "drives",
      uri: "apple2ts://disks/current",
      title: "Apple2TS drives",
      description: "Current drives and mounted media for the emulator bound to this process.",
      read: () => core().readDrives(),
    },
    {
      name: "soft-switches",
      uri: "apple2ts://system/softswitches",
      title: "Apple2TS soft switches",
      description: "Current soft-switch state for the emulator bound to this process.",
      read: () => core().readSoftSwitches(),
    },
    {
      name: "text-screen",
      uri: "apple2ts://video/text",
      title: "Apple2TS text screen",
      description: "Current Apple II text screen for the emulator bound to this process.",
      read: () => core().readTextScreen(),
    },
  ]

  if (session.fileStagingConfigured) {
    resources.push({
      name: "task-input-root",
      uri: "apple2ts://session/input-root",
      title: "Apple2TS task input folder",
      description: "Folder where this MCP session accepts files for stage_file.",
      read: () => ({ path: session.fileSourceRoot }),
    })
  }

  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await resource.read()),
        }],
      }),
    )
  }

  server.registerTool(
    "start_session",
    {
      title: "Start Apple2TS session",
      description: "Start the private emulator session owned by this MCP process.",
      inputSchema: noInputSchema,
      outputSchema: sessionStartResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return toolResult(await session.start())
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        }
      }
    },
  )

  server.registerTool(
    "stop_session",
    {
      title: "Stop Apple2TS session",
      description: "Stop the private emulator session owned by this MCP process.",
      inputSchema: noInputSchema,
      outputSchema: sessionStopResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return toolResult(await session.stop("MCP client stopped session"))
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        }
      }
    },
  )

  server.registerTool(
    "read_memory",
    {
      title: "Read Apple II memory",
      description: "Read a bounded active, main, or auxiliary memory range from the emulator bound to this process. Explicit physical reads are side-effect-free and require a paused emulator. Request the smallest useful range because results contain one integer per byte and large reads can consume substantial client or model context.",
      inputSchema: memoryReadInputSchema,
      outputSchema: memoryReadOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return memoryReadResult(await core().readMemory(input))
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        }
      }
    },
  )

  server.registerTool(
    "capture_screen",
    {
      title: "Capture Apple II screen",
      description: "Capture the current rendered Apple II display from the emulator bound to this process.",
      inputSchema: noInputSchema,
      outputSchema: screenCaptureOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return screenCaptureResult(await core().captureScreen())
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        }
      }
    },
  )

  if (session.fileStagingConfigured) {
    server.registerTool(
      "load_binary",
      {
        title: "Load an Apple II binary",
        description: "Load one file staged by this MCP session into main RAM. Use stage_file first.",
        inputSchema: binaryLoadInputSchema,
        outputSchema: binaryLoadOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input, context) => {
        try {
          return toolResult(await core().loadBinary(input, context.mcpReq.signal))
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          }
        }
      },
    )
  }

  for (const tool of mutationTools) {
    if (tool.enabled && !tool.enabled(session)) continue
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: tool.destructiveHint,
          idempotentHint: tool.idempotentHint,
          openWorldHint: false,
        },
      },
      async (input, context) => toolResult(await tool.execute(core(), input, context.mcpReq.signal)),
    )
  }

  return server
}

const waitForRenderer = async (core, timeoutMs, signal) => {
  const deadline = Date.now() + timeoutMs
  let lastError = new Error("Renderer has not connected")

  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason
    try {
      await Promise.all([core.readMachine(), core.readCpu()])
      return
    } catch (error) {
      lastError = error
      await sleep(50, signal)
    }
  }

  throw new Error(`Timed out waiting for the private renderer: ${lastError.message}`)
}

const waitFor = (promise, timeoutMs) =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    promise.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })

const launchChromium = async ({ executable, bridgeUrl, remoteControlToken, rendererId, mode }) => {
  if (!executable) throw new Error("APPLE2TS_CHROMIUM_EXECUTABLE is required")
  await access(executable, fsConstants.X_OK)

  const profilePath = await mkdtemp(path.join(os.tmpdir(), "apple2ts-mcp-chromium-"))
  const launchUrl = new URL("/", bridgeUrl)
  launchUrl.searchParams.set("remoteControl", "1")
  launchUrl.searchParams.set("remoteControlToken", remoteControlToken)
  launchUrl.searchParams.set("rendererId", rendererId)

  let child
  try {
    const modeArguments = mode === "headless" ? ["--headless=new"] : []
    child = spawn(
      executable,
      [
        ...modeArguments,
        "--disable-background-networking",
        "--no-default-browser-check",
        "--no-first-run",
        `--user-data-dir=${profilePath}`,
        launchUrl.href,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
  } catch (error) {
    await rm(profilePath, { recursive: true, force: true })
    throw error
  }

  let childStderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => {
    if (childStderr.length >= CHILD_STDERR_LIMIT) return
    childStderr += chunk.slice(0, CHILD_STDERR_LIMIT - childStderr.length)
  })

  let childError = null
  child.once("error", (error) => {
    childError = error
  })
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ error: childError, code, signal }))
  })
  let exitOutcome = null
  void exited.then((outcome) => {
    exitOutcome = outcome
  })
  let stopped = false

  return {
    profilePath,
    exited,
    async stop() {
      if (stopped) return
      stopped = true
      let failure = null
      let exitConfirmed = exitOutcome !== null
      try {
        if (!exitConfirmed && (child.exitCode !== null || child.signalCode !== null)) {
          exitConfirmed = await waitFor(exited, BROWSER_EXIT_TIMEOUT_MS)
        }
        if (!exitConfirmed && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM")
          exitConfirmed = await waitFor(exited, BROWSER_EXIT_TIMEOUT_MS)
          if (!exitConfirmed) {
            child.kill("SIGKILL")
            exitConfirmed = await waitFor(exited, BROWSER_EXIT_TIMEOUT_MS)
            if (!exitConfirmed) {
              failure = new Error(
                `Owned Chromium did not exit after SIGTERM and SIGKILL; retained profile ${profilePath}`,
              )
            }
          }
        }
        if (exitConfirmed) {
          const outcome = exitOutcome || await exited
          if (outcome.error && !failure) failure = outcome.error
        } else {
          child.stderr.destroy()
          child.unref()
        }
      } finally {
        if (exitConfirmed) {
          try {
            await rm(profilePath, { recursive: true, force: true })
          } catch (error) {
            if (!failure) failure = error
          }
        }
      }
      if (failure) throw failure
    },
    describeExit(outcome) {
      const detail = outcome.error
        ? outcome.error.message
        : outcome.signal
          ? `signal ${outcome.signal}`
          : `exit code ${outcome.code}`
      const stderrDetail = childStderr.trim() ? `: ${childStderr.trim()}` : ""
      return `${detail}${stderrDetail}`
    },
  }
}

export const runStdio = async (options = {}) => {
  const shutdownController = new AbortController()
  let stdioHandle = null
  let stopping = null
  let activeSession = null
  let startingSession = null
  let stoppingSession = null
  const throwIfShuttingDown = () => {
    if (shutdownController.signal.aborted) throw shutdownController.signal.reason
  }

  const session = {
    fileStagingConfigured: Boolean(options.fileStagingRoot && options.fileSourceRoot),
    fileSourceRoot: options.fileSourceRoot,
    requireCore() {
      if (!activeSession) throw new Error("No active Apple2TS session. Call start_session first.")
      return activeSession.core
    },
    async start() {
      throwIfShuttingDown()
      if (stoppingSession) await stoppingSession
      throwIfShuttingDown()
      if (activeSession) return { emulator: activeSession.core.identity }
      if (startingSession) return startingSession

      startingSession = (async () => {
        throwIfShuttingDown()
        if (!options.chromiumExecutable) throw new Error("APPLE2TS_CHROMIUM_EXECUTABLE is required")
        const binaryRoot = await resolveBinaryRoot(options.fileStagingRoot, "APPLE2TS_FILE_STAGING_ROOT")
        const fileSourceRoot = await resolveBinaryRoot(options.fileSourceRoot, "APPLE2TS_FILE_SOURCE_ROOT")
        throwIfShuttingDown()
        if (binaryRoot && fileSourceRoot) {
          const stagingRelativeToSource = path.relative(fileSourceRoot, binaryRoot)
          if (
            stagingRelativeToSource === ""
            || (!stagingRelativeToSource.startsWith(`..${path.sep}`)
              && stagingRelativeToSource !== ".."
              && !path.isAbsolute(stagingRelativeToSource))
          ) {
            throw new Error("APPLE2TS_FILE_STAGING_ROOT must not be inside APPLE2TS_FILE_SOURCE_ROOT")
          }
          try {
            await access(binaryRoot, fsConstants.W_OK | fsConstants.X_OK)
          } catch {
            throw new Error("APPLE2TS_FILE_STAGING_ROOT must be writable when file staging is configured")
          }
        }
        const chromiumMode = options.chromiumMode ?? "headless"
        if (chromiumMode !== "headless" && chromiumMode !== "visible") {
          throw new Error("APPLE2TS_CHROMIUM_MODE must be 'headless' or 'visible'")
        }
        const distDir = resolveBrowserBuildDir(options.distDir)
        const browserBuildAvailable = options.hasBrowserBuild || hasBrowserBuild
        if (options.requireBrowserBuild !== false && !(await browserBuildAvailable(distDir))) {
          throw new Error(getMissingBrowserBuildMessage(distDir))
        }
        throwIfShuttingDown()

        const remoteControlToken = options.remoteControlToken || randomBytes(32).toString("base64url")
        const controllerToken = options.controllerToken || randomBytes(32).toString("base64url")
        const rendererId = options.rendererId || randomUUID()
        const sessionController = new AbortController()
        let listener = null
        let renderer = null
        let core = null
        try {
          listener = await startApple2tsServer({
            host: "127.0.0.1",
            port: Number(options.port ?? 0),
            distDir,
            privateRenderer: { remoteControlToken, rendererId, controllerToken },
            logger: { log: (message) => process.stderr.write(`${message}\n`) },
          })
          throwIfShuttingDown()
          core = new Apple2tsCore(
            listener.url,
            controllerToken,
            {
              serverInstanceId: listener.serverInstanceId,
              rendererId,
              targetId: `${listener.serverInstanceId}:${rendererId}`,
            },
            sessionController.signal,
            binaryRoot,
            binaryRoot && fileSourceRoot ? new FileStager(fileSourceRoot, binaryRoot) : null,
          )
          renderer = await launchChromium({
            executable: options.chromiumExecutable,
            bridgeUrl: listener.url,
            remoteControlToken,
            rendererId,
            mode: chromiumMode,
          })
          throwIfShuttingDown()
          process.stderr.write(`Apple2TS MCP private bridge listening at ${listener.url}; waiting for renderer ${rendererId}.\n`)
          const startupTimeoutMs = Number(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
          const startup = await Promise.race([
            waitForRenderer(core, startupTimeoutMs, sessionController.signal).then(() => ({ ready: true })),
            renderer.exited.then((outcome) => ({ ready: false, outcome })),
          ])
          if (!startup.ready) {
            throw new Error(`Owned Chromium exited before readiness (${renderer.describeExit(startup.outcome)})`)
          }
          if (shutdownController.signal.aborted) throw shutdownController.signal.reason

          const created = { core, renderer, controller: sessionController }
          activeSession = created
          void renderer.exited.then((outcome) => {
            if (activeSession !== created || stopping) return
            process.stderr.write(`Apple2TS MCP renderer exited unexpectedly (${renderer.describeExit(outcome)}).\n`)
            void session.stop("Owned Chromium exited unexpectedly").catch(reportFatal)
          })
          return { emulator: core.identity }
        } catch (error) {
          sessionController.abort(error)
          await core?.neutralizeKeyboard().catch(() => {})
          if (core) await Promise.resolve(core.cleanupStagedFiles()).catch(() => {})
          await renderer?.stop().catch(() => {})
          await stopApple2tsServer().catch(() => {})
          throw error
        }
      })().finally(() => {
        startingSession = null
      })
      return startingSession
    },
    async stop(reason) {
      if (stoppingSession) return stoppingSession
      stoppingSession = (async () => {
        if (startingSession) await startingSession.catch(() => {})
        if (!activeSession) return { stopped: false }
        const current = activeSession
        const failures = []
        current.controller.abort(new Error(reason))
        await current.core.neutralizeKeyboard().catch((error) => failures.push(error))
        await Promise.resolve(current.core.cleanupStagedFiles()).catch((error) => failures.push(error))
        await current.renderer.stop().catch((error) => failures.push(error))
        await stopApple2tsServer().catch((error) => failures.push(error))
        if (activeSession === current) activeSession = null
        if (failures.length) throw new AggregateError(failures, "Apple2TS MCP session cleanup failed")
        return { stopped: true }
      })().finally(() => {
        stoppingSession = null
      })
      return stoppingSession
    },
  }

  const shutdown = (reason) => {
    if (stopping) return stopping
    stopping = (async () => {
      const failures = []
      shutdownController.abort(new Error(reason))
      await session.stop(reason).catch((error) => failures.push(error))
      await stdioHandle?.close().catch((error) => failures.push(error))
      process.stdin.off("end", onStdinEnd)
      process.stdin.off("close", onStdinEnd)
      process.stdin.pause()
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      if (failures.length) throw new AggregateError(failures, "Apple2TS MCP cleanup failed")
    })()
    return stopping
  }

  const onStdinEnd = () => void shutdown("MCP stdin closed").catch(reportFatal)
  const onSigint = () => void shutdown("Received SIGINT").catch(reportFatal)
  const onSigterm = () => void shutdown("Received SIGTERM").catch(reportFatal)
  const reportFatal = (error) => {
    process.stderr.write(`Apple2TS MCP cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }

  process.stdin.once("end", onStdinEnd)
  process.stdin.once("close", onStdinEnd)
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  try {
    stdioHandle = serveStdio(() => createMcpServer(session), {
      onerror: (error) => process.stderr.write(`Apple2TS MCP protocol error: ${error.message}\n`),
    })
    process.stderr.write("Apple2TS MCP ready for session requests.\n")
  } catch (error) {
    if (!shutdownController.signal.aborted) {
      process.stderr.write(`Apple2TS MCP startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
    await shutdown("Startup ended").catch(reportFatal)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
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
  })
}
