#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"

import { statusFixture } from "./status_fixture.mjs"

const profileArgument = process.argv.find((argument) => argument.startsWith("--user-data-dir="))
const launchArgument = process.argv.find((argument) => argument.startsWith("http://"))
if (!profileArgument || !launchArgument) process.exit(64)

const profilePath = profileArgument.slice("--user-data-dir=".length)
const launchUrl = new URL(launchArgument)
const remoteControlToken = launchUrl.searchParams.get("remoteControlToken")
const rendererId = launchUrl.searchParams.get("rendererId")
const receiptPath = process.env.APPLE2TS_FAKE_CHROMIUM_RECEIPT

if (receiptPath) {
  await writeFile(receiptPath, JSON.stringify({
    pid: process.pid,
    profilePath,
    launchUrl: launchUrl.href,
    headless: process.argv.includes("--headless=new"),
  }))
}

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
const eventsResponse = await fetch(eventsUrl)
if (!eventsResponse.ok) process.exit(67)

const reader = eventsResponse.body.getReader()
const decoder = new TextDecoder()
const memoryDump = new Array(65536).fill(0)
memoryDump[65534] = 171
memoryDump[65535] = 205
let breakpoints = []
let buffer = ""
let stopping = false
let statusReplies = 0
const status = structuredClone(statusFixture)
const canHaltAtAddress = (breakpoint) => breakpoint.watchpoint === false
  && breakpoint.instruction === false
  && breakpoint.disabled === false
  && breakpoint.basic === false
  && breakpoint.expression1?.register === ""
  && breakpoint.hitcount === 1
  && breakpoint.action1?.action === ""
  && breakpoint.action2?.action === ""

const stop = () => {
  if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "ignore-term") {
    if (receiptPath) {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"))
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, sigtermSeen: true }))
    }
    return
  }
  stopping = true
  void reader.cancel().finally(() => process.exit(0))
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

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
      result = status
    } else if (command.action === "setSpeedMode") {
      status.machine.speedMode = command.payload.speedMode
      result = status
    } else if (command.action === "getStatus") {
      result = status
    } else if (command.action === "getMemory") {
      result = { memoryDump }
    } else if (command.action === "loadBinary") {
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
    if (command.action === "getStatus") {
      statusReplies += 1
      if (process.env.APPLE2TS_FAKE_CHROMIUM_MODE === "crash-after-ready" && statusReplies >= 2) {
        setTimeout(() => process.exit(43), 50)
      }
    }
  }
}
