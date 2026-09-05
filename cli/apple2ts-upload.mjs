#!/usr/bin/env node

import { constants as fsConstants } from "node:fs"
import { open } from "node:fs/promises"

const fail = (message) => {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

const usage = "Usage: apple2ts-upload (ticket on stdin)"

const printReceipt = (receipt) => {
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}

const readTicket = async () => {
  let input = ""
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.length > 4096) throw new Error("Upload ticket input is too long")
  }
  if (!/^[^\r\n]+(?:\r?\n)?$/.test(input)) {
    throw new Error("Write exactly one upload ticket line to apple2ts-upload stdin")
  }
  return input.trimEnd()
}

if (process.argv.length === 3 && ["-h", "--help"].includes(process.argv[2])) {
  process.stdout.write(`${usage}\n`)
} else if (process.argv.length !== 2) {
  fail(usage)
} else {
  try {
    const ticket = await readTicket()
    const ticketUrl = new URL(ticket)
    if (ticketUrl.protocol !== "http:" || ticketUrl.hostname !== "127.0.0.1") {
      throw new Error("Upload ticket must use loopback HTTP")
    }

    const ticketResponse = await fetch(ticketUrl)
    const ticketPayload = await ticketResponse.json().catch(() => null)
    if (!ticketResponse.ok || ticketPayload?.ok !== true) {
      throw new Error(ticketPayload?.error || `Upload ticket failed with HTTP ${ticketResponse.status}`)
    }
    if (ticketPayload.data?.status === "completed") {
      printReceipt(ticketPayload.data.result)
    } else if (ticketPayload.data?.status === "failed") {
      throw new Error(ticketPayload.data.error)
    } else if (ticketPayload.data?.status !== "pending") {
      throw new Error("Upload ticket returned an invalid state")
    } else if (ticketPayload.data.claimed) {
      throw new Error("Upload already in progress; retry after it completes")
    } else {
      const handle = await open(
        ticketPayload.data.path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      )
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error("Bound path must name a regular file")
        if (info.size === 0) throw new Error("Bound file must not be empty")
        if (info.size > ticketPayload.data.maxBytes) {
          throw new Error(`Bound file cannot exceed ${ticketPayload.data.maxBytes} bytes`)
        }
        const response = await fetch(ticketUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: handle.createReadStream(),
          duplex: "half",
        })
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.ok !== true) {
          throw new Error(payload?.error || `Upload failed with HTTP ${response.status}`)
        }
        if (payload.data?.status !== "completed") {
          throw new Error("Upload did not return a completed result")
        }
        printReceipt(payload.data.result)
      } finally {
        await handle.close().catch(() => {})
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}
