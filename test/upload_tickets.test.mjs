import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { request } from "node:http"
import { chmod, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { UploadTickets } from "../server/upload_tickets.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uploadHelper = path.resolve(__dirname, "../cli/apple2ts-upload.mjs")

const startTicketServer = async (core, options = {}) => {
  let tickets
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (!await tickets.handle(req, res, url)) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  tickets = new UploadTickets(baseUrl, core, options)
  return {
    tickets,
    close: async () => {
      tickets.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const runUpload = (input, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [uploadHelper, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  child.once("error", reject)
  child.once("close", (code) => {
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error(stderr.trim() || `apple2ts-upload exited with status ${code}`))
  })
  child.stdin.end(input)
})

test("upload helper requires exactly one loopback ticket", async () => {
  assert.equal((await runUpload("", ["--help"])).stdout, "Usage: apple2ts-upload (ticket on stdin)\n")
  await assert.rejects(runUpload(""), /exactly one upload ticket line/)
  await assert.rejects(runUpload("one\ntwo\n"), /exactly one upload ticket line/)
  await assert.rejects(runUpload("one\n", ["unexpected"]), /Usage: apple2ts-upload \(ticket on stdin\)/)
  await assert.rejects(runUpload("https://example.test/upload\n"), /must use loopback HTTP/)
})

test("upload helper uses the ticket-bound path and returns the final mount receipt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apple2ts-upload-ticket-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const selectedPath = path.join(root, "selected.po")
  const otherPath = path.join(root, "other.po")
  await writeFile(selectedPath, "selected bytes")
  await writeFile(otherPath, "other bytes")
  const calls = []
  const core = {
    async mountDiskBytes(intent, bytes) {
      calls.push({ intent, bytes: bytes.toString() })
      return { emulator: { rendererId: "renderer" }, state: { driveId: intent.driveId, mounted: true } }
    },
  }
  const server = await startTicketServer(core)
  t.after(server.close)
  const expectedSha256 = createHash("sha256").update("selected bytes").digest("hex")
  const prepared = server.tickets.prepareMount({
    path: selectedPath,
    driveId: "hd1",
    expectedSha256: expectedSha256.toUpperCase(),
  })
  const { stdout } = await runUpload(`${prepared.ticket}\n`)
  const retried = await runUpload(`${prepared.ticket}\n`)

  assert.equal(calls.length, 1)
  assert.deepEqual(
    {
      operation: calls[0].intent.operation,
      path: calls[0].intent.path,
      driveId: calls[0].intent.driveId,
      expectedSha256: calls[0].intent.expectedSha256,
      maxBytes: calls[0].intent.maxBytes,
      bytes: calls[0].bytes,
    },
    {
      operation: "mount_disk",
      path: selectedPath,
      driveId: "hd1",
      expectedSha256,
      maxBytes: 32 * 1024 * 1024,
      bytes: "selected bytes",
    },
  )
  assert.deepEqual(JSON.parse(stdout), {
    emulator: { rendererId: "renderer" },
    state: { driveId: "hd1", mounted: true },
    byteCount: 14,
    sha256: expectedSha256,
  })
  assert.equal(retried.stdout, stdout)
  assert.equal(calls.length, 1)
})

test("upload helper completes a bound binary load", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apple2ts-upload-ticket-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, "program.bin")
  await writeFile(sourcePath, Buffer.from([0xA9, 0x42, 0x60]))
  const core = {
    async loadBinaryBytes(intent, bytes) {
      return { address: intent.address, bytesWritten: bytes.length, sha256: "a".repeat(64) }
    },
  }
  const server = await startTicketServer(core)
  t.after(server.close)
  const prepared = server.tickets.prepareLoad({ path: sourcePath, address: 0x6000 })
  const { stdout } = await runUpload(`${prepared.ticket}\n`)

  assert.deepEqual(JSON.parse(stdout), {
    address: 0x6000,
    bytesWritten: 3,
    byteCount: 3,
    sha256: createHash("sha256").update(Buffer.from([0xA9, 0x42, 0x60])).digest("hex"),
  })
})

test("upload helper reads a source that it cannot modify", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "apple2ts-upload-readonly-"))
  t.after(async () => {
    await chmod(root, 0o755)
    await rm(root, { recursive: true, force: true })
  })
  const sourcePath = path.join(root, "program.bin")
  const bytes = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])
  await writeFile(sourcePath, bytes)
  await chmod(sourcePath, 0o444)
  await chmod(root, 0o555)
  await assert.rejects(writeFile(sourcePath, "changed", { flag: "a" }), { code: "EACCES" })

  let loaded
  const core = {
    async loadBinaryBytes(intent, received) {
      loaded = { intent, received }
      return { address: intent.address, bytesWritten: received.length }
    },
  }
  const server = await startTicketServer(core)
  t.after(server.close)
  const prepared = server.tickets.prepareLoad({ path: sourcePath, address: 0x2000 })
  const { stdout } = await runUpload(`${prepared.ticket}\n`)

  assert.deepEqual(loaded.received, bytes)
  assert.equal(JSON.parse(stdout).sha256, createHash("sha256").update(bytes).digest("hex"))
})

test("upload tickets expire, replay their result, and cannot cross servers", async (t) => {
  let now = 1000
  let mutations = 0
  const core = { mountDiskBytes: async () => { mutations += 1; return { mounted: true } } }
  const first = await startTicketServer(core, { now: () => now, ttlMs: 50 })
  const second = await startTicketServer(core)
  t.after(() => Promise.all([first.close(), second.close()]))

  const expiring = first.tickets.prepareMount({ path: "/unused.po", driveId: "fd1" })
  now += 51
  assert.equal((await fetch(expiring.ticket)).status, 410)

  const crossing = first.tickets.prepareMount({ path: "/unused.po", driveId: "fd1" })
  const tokenPath = new URL(crossing.ticket).pathname
  const crossUrl = new URL(tokenPath, second.tickets.baseUrl)
  assert.equal((await fetch(crossUrl)).status, 404)

  const upload = await fetch(crossing.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "disk",
  })
  assert.equal(upload.status, 200)
  const replay = await fetch(crossing.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "disk",
  })
  assert.equal(replay.status, 200)
  assert.deepEqual((await replay.json()).data, {
    status: "completed",
    result: {
      mounted: true,
      byteCount: 4,
      sha256: createHash("sha256").update("disk").digest("hex"),
    },
  })
  assert.equal(mutations, 1)

  now += 51
  assert.equal((await fetch(crossing.ticket)).status, 410)
})

test("prepare requires an absolute source path", async (t) => {
  const server = await startTicketServer({})
  t.after(server.close)

  assert.throws(
    () => server.tickets.prepareLoad({ path: "relative.bin", address: 0x6000 }),
    /absolute source file path/,
  )
  assert.throws(
    () => server.tickets.prepareMount({ path: "relative.po", driveId: "fd1" }),
    /absolute source file path/,
  )
})

test("preparing a ticket prunes expired entries", async (t) => {
  let now = 1000
  const server = await startTicketServer({}, { now: () => now, ttlMs: 50 })
  t.after(server.close)
  server.tickets.prepareLoad({ path: "/first.bin", address: 0x6000 })
  now += 51
  server.tickets.prepareLoad({ path: "/second.bin", address: 0x6000 })

  assert.equal(server.tickets.tickets.size, 1)
  assert.equal([...server.tickets.tickets.values()][0].path, "/second.bin")
})

test("upload tickets have a fixed live limit", async (t) => {
  let now = 1000
  let sequence = 0
  const server = await startTicketServer({}, {
    now: () => now,
    randomToken: () => `ticket-${sequence++}`,
  })
  t.after(server.close)
  for (let index = 0; index < 64; index += 1) {
    server.tickets.prepareLoad({ path: `/${index}.bin`, address: 0x6000 })
  }
  assert.throws(
    () => server.tickets.prepareLoad({ path: "/overflow.bin", address: 0x6000 }),
    /No more than 64 upload tickets may be active/,
  )

  now += 30_001
  assert.doesNotThrow(
    () => server.tickets.prepareLoad({ path: "/after-expiry.bin", address: 0x6000 }),
  )
})

test("oversize and rejected uploads fail without retrying or changing the emulator", async (t) => {
  let calls = 0
  const core = {
    async loadBinaryBytes() {
      calls += 1
      throw new Error("Binary rejected")
    },
  }
  const server = await startTicketServer(core)
  t.after(server.close)

  const oversized = server.tickets.prepareLoad({ path: "/unused.bin", address: 0x6000 })
  const response = await fetch(oversized.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.alloc(0xC001),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /cannot exceed/)
  assert.equal(calls, 0)
  const oversizedState = await (await fetch(oversized.ticket)).json()
  assert.equal(oversizedState.data.status, "failed")
  await assert.rejects(runUpload(`${oversized.ticket}\n`), /cannot exceed/)

  const rejected = server.tickets.prepareLoad({ path: "/unused.bin", address: 0x6000 })
  const rejectedResponse = await fetch(rejected.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "program",
  })
  assert.equal(rejectedResponse.status, 400)
  assert.equal((await rejectedResponse.json()).error, "Binary rejected")
  assert.equal(calls, 1)
  const rejectedState = await (await fetch(rejected.ticket)).json()
  assert.deepEqual(rejectedState.data, { status: "failed", error: "Binary rejected" })
  await assert.rejects(runUpload(`${rejected.ticket}\n`), /Binary rejected/)
  assert.equal(calls, 1)
})

test("a digest mismatch consumes the ticket without changing the emulator", async (t) => {
  let calls = 0
  const core = { loadBinaryBytes: async () => { calls += 1 } }
  const server = await startTicketServer(core)
  t.after(server.close)
  const prepared = server.tickets.prepareLoad({
    path: "/unused.bin",
    address: 0x6000,
    expectedSha256: "0".repeat(64),
  })

  const response = await fetch(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "program",
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /does not match expected/)
  assert.equal(calls, 0)
  const state = await (await fetch(prepared.ticket)).json()
  assert.equal(state.data.status, "failed")
  assert.match(state.data.error, /does not match expected/)
})

test("an interrupted upload is consumed without invoking the emulator", async (t) => {
  let calls = 0
  const core = { mountDiskBytes: async () => { calls += 1 } }
  const server = await startTicketServer(core)
  t.after(server.close)
  const prepared = server.tickets.prepareMount({ path: "/unused.hdv", driveId: "hd1" })
  const url = new URL(prepared.ticket)

  await new Promise((resolve) => {
    const req = request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "1024" },
    })
    req.on("error", resolve)
    req.write(Buffer.alloc(16))
    setTimeout(() => req.destroy(), 20)
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(calls, 0)
  const state = await (await fetch(prepared.ticket)).json()
  assert.equal(state.data.status, "failed")
})

test("an upload that stalls past ticket expiry is aborted before emulator mutation", async (t) => {
  let calls = 0
  const core = { mountDiskBytes: async () => { calls += 1 } }
  const server = await startTicketServer(core, { ttlMs: 50 })
  t.after(server.close)
  const prepared = server.tickets.prepareMount({ path: "/unused.hdv", driveId: "hd1" })

  await new Promise((resolve) => {
    const req = request(prepared.ticket, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": "1024" },
    })
    req.on("error", resolve)
    req.write(Buffer.alloc(16))
  })

  assert.equal(calls, 0)
  const state = await (await fetch(prepared.ticket)).json()
  assert.equal(state.data.status, "failed")
  assert.match(state.data.error, /expired during transfer/)
})

test("a lost success response is recovered without repeating the mutation", async (t) => {
  let releaseMutation
  let mutationStarted
  const started = new Promise((resolve) => { mutationStarted = resolve })
  const release = new Promise((resolve) => { releaseMutation = resolve })
  let calls = 0
  const core = {
    async mountDiskBytes(intent) {
      calls += 1
      mutationStarted()
      await release
      return { state: { driveId: intent.driveId, mounted: true } }
    },
  }
  const server = await startTicketServer(core)
  t.after(server.close)
  const prepared = server.tickets.prepareMount({ path: "/disk.po", driveId: "fd1" })
  const req = request(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": "4" },
  })
  req.on("error", () => {})
  req.end("disk")
  await started
  req.destroy()
  releaseMutation()
  while (server.tickets.lookup(new URL(prepared.ticket).pathname.split("/").at(-1)).ticket?.status !== "completed") {
    await new Promise((resolve) => setImmediate(resolve))
  }

  const recovered = await runUpload(`${prepared.ticket}\n`)
  assert.deepEqual(JSON.parse(recovered.stdout).state, { driveId: "fd1", mounted: true })
  assert.equal(calls, 1)
})

test("a slow accepted upload retains its successful receipt after the claim deadline", async (t) => {
  let now = 1000
  let releaseMutation
  let mutationStarted
  const started = new Promise((resolve) => { mutationStarted = resolve })
  const release = new Promise((resolve) => { releaseMutation = resolve })
  let calls = 0
  const core = {
    async mountDiskBytes(intent) {
      calls += 1
      mutationStarted()
      await release
      return { state: { driveId: intent.driveId, mounted: true } }
    },
  }
  const server = await startTicketServer(core, { now: () => now, ttlMs: 50 })
  t.after(server.close)
  const prepared = server.tickets.prepareMount({ path: "/disk.po", driveId: "fd1" })
  const upload = fetch(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "disk",
  })
  await started
  now += 51
  releaseMutation()

  assert.equal((await upload).status, 200)
  const recovered = await runUpload(`${prepared.ticket}\n`)
  assert.deepEqual(JSON.parse(recovered.stdout).state, { driveId: "fd1", mounted: true })
  assert.equal(calls, 1)
  now += 51
  assert.equal((await fetch(prepared.ticket)).status, 410)
})

test("a slow rejected upload retains its failure after the claim deadline", async (t) => {
  let now = 1000
  let releaseMutation
  let mutationStarted
  const started = new Promise((resolve) => { mutationStarted = resolve })
  const release = new Promise((resolve) => { releaseMutation = resolve })
  let calls = 0
  const core = {
    async loadBinaryBytes() {
      calls += 1
      mutationStarted()
      await release
      throw new Error("Binary rejected after inspection")
    },
  }
  const server = await startTicketServer(core, { now: () => now, ttlMs: 50 })
  t.after(server.close)
  const prepared = server.tickets.prepareLoad({ path: "/program.bin", address: 0x6000 })
  const upload = fetch(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "program",
  })
  await started
  now += 51
  releaseMutation()

  assert.equal((await upload).status, 400)
  await assert.rejects(runUpload(`${prepared.ticket}\n`), /Binary rejected after inspection/)
  assert.equal(calls, 1)
  now += 51
  assert.equal((await fetch(prepared.ticket)).status, 410)
})

test("a concurrent upload cannot claim or repeat one pending mutation", async (t) => {
  let releaseMutation
  let mutationStarted
  const started = new Promise((resolve) => { mutationStarted = resolve })
  const release = new Promise((resolve) => { releaseMutation = resolve })
  let calls = 0
  const core = {
    async loadBinaryBytes() {
      calls += 1
      mutationStarted()
      await release
      return { address: 0x6000, bytesWritten: 3 }
    },
  }
  const server = await startTicketServer(core)
  t.after(server.close)
  const prepared = server.tickets.prepareLoad({ path: "/program.bin", address: 0x6000 })
  const first = fetch(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "one",
  })
  await started

  const second = await fetch(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "two",
  })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).data.status, "pending")
  await assert.rejects(
    runUpload(`${prepared.ticket}\n`),
    /Upload already in progress; retry after it completes/,
  )
  releaseMutation()
  assert.equal((await first).status, 200)
  assert.equal(calls, 1)
})

test("only one file upload may buffer or mutate at a time", async (t) => {
  let releaseMutation
  let mutationStarted
  const started = new Promise((resolve) => { mutationStarted = resolve })
  const release = new Promise((resolve) => { releaseMutation = resolve })
  const core = {
    async loadBinaryBytes() {
      mutationStarted()
      await release
      return { address: 0x6000, bytesWritten: 3 }
    },
  }
  const server = await startTicketServer(core)
  t.after(server.close)
  const firstTicket = server.tickets.prepareLoad({ path: "/first.bin", address: 0x6000 })
  const secondTicket = server.tickets.prepareLoad({ path: "/second.bin", address: 0x7000 })
  const first = fetch(firstTicket.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "one",
  })
  await started

  const second = await fetch(secondTicket.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "two",
  })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).error, "Another file upload is in progress")
  const secondState = await (await fetch(secondTicket.ticket)).json()
  assert.deepEqual(secondState.data, {
    status: "pending",
    claimed: false,
    path: "/second.bin",
    maxBytes: 0xC000,
  })

  releaseMutation()
  assert.equal((await first).status, 200)
})

test("closing an upload session invalidates its unclaimed tickets", async (t) => {
  const server = await startTicketServer({})
  const prepared = server.tickets.prepareLoad({ path: "/unused.bin", address: 0x6000 })
  server.tickets.close()
  assert.equal((await fetch(prepared.ticket)).status, 404)
  await server.close()
})

test("closing an upload session aborts an upload before emulator mutation", async (t) => {
  let calls = 0
  const core = { mountDiskBytes: async () => { calls += 1 } }
  const server = await startTicketServer(core)
  t.after(server.close)
  const prepared = server.tickets.prepareMount({ path: "/unused.hdv", driveId: "hd1" })
  const req = request(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": "1024" },
  })
  const outcome = new Promise((resolve) => {
    req.once("error", () => resolve("closed"))
    req.once("response", (response) => {
      response.resume()
      response.once("end", () => resolve("response"))
    })
  })
  req.write(Buffer.alloc(16))
  while (server.tickets.activeRequests.size === 0) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  server.tickets.close()

  assert.equal(await outcome, "closed")
  while (server.tickets.activeRequests.size > 0) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(calls, 0)
})

test("closing during emulator mutation does not restore terminal ticket state", async (t) => {
  let releaseMutation
  let mutationStarted
  const started = new Promise((resolve) => { mutationStarted = resolve })
  const release = new Promise((resolve) => { releaseMutation = resolve })
  let calls = 0
  const core = {
    async loadBinaryBytes() {
      calls += 1
      mutationStarted()
      await release
      return { address: 0x6000, bytesWritten: 3 }
    },
  }
  const server = await startTicketServer(core)
  t.after(async () => {
    releaseMutation()
    await server.close()
  })
  const prepared = server.tickets.prepareLoad({ path: "/program.bin", address: 0x6000 })
  const req = request(prepared.ticket, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": "3" },
  })
  req.on("error", () => {})
  req.end("one")
  await started

  server.tickets.close()
  releaseMutation()
  while (server.tickets.activeRequests.size > 0) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(calls, 1)
  assert.equal(server.tickets.tickets.size, 0)
})
