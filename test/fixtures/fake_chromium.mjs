#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs"
import { chmod, rename, rm, writeFile } from "node:fs/promises"

import { statusFixture } from "./status_fixture.mjs"

const profileArgument = process.argv.find((argument) => argument.startsWith("--user-data-dir="))
const launchArgument = process.argv.find((argument) => argument.startsWith("http://"))
if (!profileArgument || !launchArgument) process.exit(64)

const profilePath = profileArgument.slice("--user-data-dir=".length)
const launchUrl = new URL(launchArgument)
const remoteControlToken = launchUrl.searchParams.get("remoteControlToken")
const rendererId = launchUrl.searchParams.get("rendererId")
const receiptPath = process.env.APPLE2TS_FAKE_CHROMIUM_RECEIPT

let receiptUpdateSequence = 0
let receiptUpdates = Promise.resolve()
const writeReceipt = (makeReceipt) => {
  if (!receiptPath) return Promise.resolve()
  receiptUpdates = receiptUpdates.then(async () => {
    const temporaryPath = `${receiptPath}.${process.pid}.${receiptUpdateSequence++}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(makeReceipt()))
      await rename(temporaryPath, receiptPath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  })
  return receiptUpdates
}
const updateReceipt = (patch) => writeReceipt(() => ({
  ...JSON.parse(readFileSync(receiptPath, "utf8")),
  ...patch,
}))

await writeReceipt(() => ({
  pid: process.pid,
  profilePath,
  launchUrl: launchUrl.href,
  headless: process.argv.includes("--headless=new"),
}))

if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "exit") process.exit(42)
if (launchUrl.searchParams.get("remoteControl") !== "1" || !remoteControlToken || !rendererId) process.exit(65)

const postJson = (pathname, body) =>
  fetch(new URL(pathname, launchUrl.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const connectResponse = await postJson("/api/client/connect", {
  remoteControlToken,
  rendererId,
  pathname: launchUrl.pathname,
  userAgent: "fake-chromium",
})
if (!connectResponse.ok) process.exit(66)
const { clientId } = await connectResponse.json()

const eventsUrl = new URL("/api/client/events", launchUrl.origin)
eventsUrl.searchParams.set("clientId", clientId)
eventsUrl.searchParams.set("remoteControlToken", remoteControlToken)
eventsUrl.searchParams.set("rendererId", rendererId)
const eventController = new AbortController()
const eventsResponse = await fetch(eventsUrl, { signal: eventController.signal })
if (!eventsResponse.ok) process.exit(67)

const reader = eventsResponse.body.getReader()
const decoder = new TextDecoder()
const memoryDump = new Array(65536).fill(0)
memoryDump[65534] = 171
memoryDump[65535] = 205
const mainMemory = [...memoryDump]
const auxMemory = new Array(65536).fill(0)
mainMemory[0x03A4] = 0x11
auxMemory[0x03A4] = 0x22
let breakpoints = []
let buffer = ""
let stopping = false
let statusReplies = 0
const status = structuredClone(statusFixture)
status.drives = [{
  index: 0,
  drive: 1,
  hardDrive: false,
  filename: "fixture.woz",
  status: "mounted",
  isWriteProtected: true,
  diskHasChanges: false,
  motorRunning: false,
  byteLength: 143360,
}]
if (process.env.APPLE2TS_FAKE_CHROMIUM_HARD_DRIVE === "1") {
  status.drives.push({
    index: 2,
    drive: 1,
    hardDrive: true,
    filename: "",
    status: "",
    isWriteProtected: false,
    diskHasChanges: false,
    motorRunning: false,
    byteLength: 0,
  })
}
const keyboardStates = []
const canHaltAtAddress = (breakpoint) => breakpoint.watchpoint === false
  && breakpoint.instruction === false
  && breakpoint.disabled === false
  && breakpoint.basic === false
  && breakpoint.expression1?.register === ""
  && breakpoint.hitcount === 1
  && breakpoint.action1?.action === ""
  && breakpoint.action2?.action === ""

const initialState = await postJson("/api/client/state", {
  clientId,
  remoteControlToken,
  rendererId,
  state: status,
})
if (!initialState.ok) process.exit(69)

const stop = () => {
  if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "ignore-term") {
    void updateReceipt({ sigtermSeen: true })
    return
  }
  stopping = true
  eventController.abort()
  void reader.cancel().finally(() => process.exit(0))
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE?.startsWith("disconnect-before-ready")) {
  if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE.endsWith("cleanup-failure")) {
    await writeFile(`${profilePath}/retained`, "retained")
    await chmod(profilePath, 0o000)
  }
  eventController.abort()
  await reader.cancel().catch(() => {})
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

while (!stopping) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  while (buffer.includes("\n\n")) {
    const boundary = buffer.indexOf("\n\n")
    const frame = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    const event = frame.split("\n").find((line) => line === "event: command")
    const data = frame.split("\n").find((line) => line.startsWith("data: "))
    if (!event || !data) continue
    const command = JSON.parse(data.slice(6))
    let result
    if (command.action === "setRunMode") {
      status.machine.runMode = command.payload.runMode === -4 || command.payload.runMode === -3
        ? -1
        : command.payload.runMode
      status.machine.execution.executionSequence += 1
      status.machine.execution.state = status.machine.runMode === -2 ? "paused" : "running"
      status.machine.execution.pauseReason = status.machine.runMode === -2 ? "explicit" : null
      status.machine.execution.breakpoint = null
      if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "stall-run-mode") {
        await updateReceipt({ stalledRunMode: true })
        continue
      }
      result = status
      if (
        process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "execution-stop"
        && status.machine.runMode === -1
        && breakpoints.length > 0
      ) {
        const breakpoint = breakpoints[0]
        setTimeout(() => {
          status.machine.runMode = -2
          status.machine.machineState.PC = breakpoint.address
          status.machine.execution = {
            ...status.machine.execution,
            executionSequence: status.machine.execution.executionSequence + 1,
            state: "paused",
            pauseReason: "breakpoint",
            breakpoint: {
              breakpointId: `bp:${breakpoint.address}`,
              address: breakpoint.address,
            },
            PC: breakpoint.address,
          }
          void postJson("/api/client/state", {
            clientId,
            remoteControlToken,
            rendererId,
            state: status,
          })
        }, Number(process.env.APPLE2TS_FAKE_EXECUTION_STOP_DELAY_MS || 5))
      }
    } else if (command.action === "setSpeedMode") {
      status.machine.speedMode = command.payload.speedMode
      result = status
    } else if (command.action === "getStatus") {
      result = status
    } else if (command.action === "getMemory") {
      result = { memoryDump }
    } else if (command.action === "getMemoryView") {
      if (status.machine.runMode !== -2) {
        const reply = await postJson("/api/client/reply", {
          clientId,
          remoteControlToken,
          rendererId,
          commandId: command.commandId,
          ok: false,
          error: "Memory is available only while the emulator is paused",
        })
        if (!reply.ok) process.exit(68)
        continue
      }
      const {address, length, space, auxBank} = command.payload
      const source = space === "aux" ? auxMemory : mainMemory
      result = {
        address,
        length,
        requestedSpace: space,
        requestedAuxBank: auxBank ?? null,
        effectiveAuxBank: space === "aux" ? auxBank ?? 0 : null,
        effectiveSegments: [{
          address,
          length,
          space: space === "active" && address >= 0xC000 ? "system" : space === "aux" ? "aux" : "main",
          ...(space === "aux" ? {auxBank: auxBank ?? 0} : {}),
        }],
        mapping: {
          RAMRD: false,
          RAMWRT: false,
          ALTZP: false,
          "80STORE": false,
          PAGE2: false,
          HIRES: false,
        },
        bytes: source.slice(address, address + length),
      }
    } else if (command.action === "captureScreen") {
      result = {
        mimeType: "image/png",
        dataBase64: process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "invalid-screen"
          ? "not base64"
          : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        width: 1,
        height: 1,
      }
    } else if (command.action === "loadBinary") {
      result = status
    } else if (command.action === "mountDisk") {
      const driveIndex = Number(command.payload.driveIndex)
      const drive = status.drives.find((candidate) => candidate.index === driveIndex)
      if (drive) {
        drive.filename = command.payload.filename
        drive.status = "mounted"
        drive.byteLength = 143360
      }
      result = { mountedDrive: driveIndex, status }
    } else if (command.action === "ejectDisk") {
      const driveIndex = Number(command.payload.driveIndex)
      const drive = status.drives.find((candidate) => candidate.index === driveIndex)
      if (drive) {
        drive.filename = ""
        drive.status = ""
        drive.byteLength = 0
      }
      result = status
    } else if (command.action === "getBreakpoints") {
      result = { breakpoints }
    } else if (command.action === "setBreakpoints") {
      const nextBreakpoints = command.payload.breakpoints
      if (nextBreakpoints.every(canHaltAtAddress)) {
        breakpoints = structuredClone(nextBreakpoints)
        result = { breakpoints }
      }
    } else if (command.action === "setCpuState") {
      status.machine.machineState = command.payload.state
      const { PC, Accum, XReg, YReg, StackPtr, PStatus } = command.payload.state
      status.machine.execution = {
        ...status.machine.execution,
        PC,
        A: Accum,
        X: XReg,
        Y: YReg,
        S: StackPtr,
        PStatus,
      }
      result = status
    } else if (command.action === "setKeyboardState") {
      keyboardStates.push(command.payload)
      await updateReceipt({ keyboardStates })
      result = status
    }
    const reply = await postJson("/api/client/reply", {
      clientId,
      remoteControlToken,
      rendererId,
      commandId: command.commandId,
      ok: result !== undefined,
      result,
      error: result === undefined ? "Unsupported fake command" : undefined,
    })
    if (!reply.ok) process.exit(68)
    if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "disconnect-after-load" && command.action === "loadBinary") {
      eventController.abort()
      await reader.cancel().catch(() => {})
      setInterval(() => {}, 1000)
      await new Promise(() => {})
    }
    if (command.action === "getStatus") {
      statusReplies += 1
      if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "crash-after-ready" && statusReplies >= 2) {
        setTimeout(() => process.exit(43), 50)
      }
      if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "close-after-ready" && statusReplies >= 2) {
        setTimeout(() => process.exit(0), 50)
      }
    }
  }
}
