#!/usr/bin/env node

import { writeFile } from "node:fs/promises"

const profileArgument = process.argv.find((argument) => argument.startsWith("--user-data-dir="))
const launchArgument = process.argv.find((argument) => argument.startsWith("http://"))
if (!profileArgument || !launchArgument) process.exit(64)

const profilePath = profileArgument.slice("--user-data-dir=".length)
const launchUrl = new URL(launchArgument)
const remoteControlToken = launchUrl.searchParams.get("remoteControlToken")
const rendererId = launchUrl.searchParams.get("rendererId")
const receiptPath = process.env.APPLE2TS_FAKE_CHROMIUM_RECEIPT

if (receiptPath) {
  await writeFile(receiptPath, JSON.stringify({ pid: process.pid, profilePath, launchUrl: launchUrl.href }))
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

const status = {
  machine: {
    runMode: -2,
    speedMode: 1,
    machineName: "APPLE2EE",
    ramWorksKb: 64,
    isDebugging: true,
    showDebugTab: false,
    textPage: "READY",
    machineState: {
      PC: 768,
      Accum: 65,
      XReg: 1,
      YReg: 2,
      StackPtr: 255,
      flagIRQ: 0,
      flagNMI: false,
      PStatus: 32,
      cycleCount: 1234,
    },
  },
  drives: [],
}

const reader = eventsResponse.body.getReader()
const decoder = new TextDecoder()
let buffer = ""
let stopping = false

const stop = () => {
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
    const reply = await postJson("/api/client/reply", {
      clientId,
      remoteControlToken,
      rendererId,
      commandId: command.commandId,
      ok: command.action === "getStatus",
      result: status,
      error: command.action === "getStatus" ? undefined : "Unsupported fake command",
    })
    if (!reply.ok) process.exit(68)
  }
}
