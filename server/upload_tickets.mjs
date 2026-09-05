import { createHash, randomBytes } from "node:crypto"
import path from "node:path"

const UPLOAD_PATH = "/api/private/file-upload/"
const MAX_LIVE_TICKETS = 64
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

const normalizeExpectedSha256 = (value) => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error("expectedSha256 must be a 64-character hexadecimal SHA-256 digest")
  }
  return value.toLowerCase()
}

const normalizeSourcePath = (value) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("path must be an absolute source file path")
  }
  return path.normalize(value)
}

const writeJson = (res, statusCode, payload) => {
  if (res.destroyed) return
  res.statusCode = statusCode
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(payload))
}

const readBody = async (req, maxBytes) => {
  const declaredLength = Number(req.headers["content-length"])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume()
    throw new Error(`Upload cannot exceed ${maxBytes} bytes`)
  }

  const chunks = []
  let byteCount = 0
  for await (const chunk of req) {
    byteCount += chunk.length
    if (byteCount > maxBytes) {
      req.resume()
      throw new Error(`Upload cannot exceed ${maxBytes} bytes`)
    }
    chunks.push(chunk)
  }
  if (byteCount === 0) throw new Error("Upload must not be empty")
  return Buffer.concat(chunks)
}

export class UploadTickets {
  constructor(baseUrl, core, options = {}) {
    this.baseUrl = baseUrl
    this.core = core
    this.ttlMs = options.ttlMs ?? 30_000
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => randomBytes(24).toString("base64url"))
    this.tickets = new Map()
    this.activeRequests = new Set()
    this.closed = false
  }

  prepare(intent) {
    if (this.closed) throw new Error("File upload is closing")
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= this.now()) this.tickets.delete(token)
    }
    if (this.tickets.size >= MAX_LIVE_TICKETS) {
      throw new Error(`No more than ${MAX_LIVE_TICKETS} upload tickets may be active`)
    }
    const token = this.randomToken()
    const expiresAt = this.now() + this.ttlMs
    this.tickets.set(token, { ...intent, expiresAt, status: "pending", claimed: false })
    return {
      ticket: new URL(`${UPLOAD_PATH}${token}`, this.baseUrl).href,
    }
  }

  prepareMount({ path, driveId, expectedSha256 }) {
    const hardDrive = driveId === "hd1" || driveId === "hd2"
    return this.prepare({
      operation: "mount_disk",
      path: normalizeSourcePath(path),
      driveId,
      expectedSha256: normalizeExpectedSha256(expectedSha256),
      maxBytes: hardDrive ? 32 * 1024 * 1024 : 2 * 1024 * 1024,
    })
  }

  prepareLoad({ path, address, expectedSha256 }) {
    return this.prepare({
      operation: "load_binary",
      path: normalizeSourcePath(path),
      address,
      expectedSha256: normalizeExpectedSha256(expectedSha256),
      maxBytes: 0xC000,
    })
  }

  lookup(token) {
    const ticket = this.tickets.get(token)
    if (!ticket) return { status: 404, message: "Unknown upload ticket" }
    if (ticket.expiresAt <= this.now()) {
      this.tickets.delete(token)
      return { status: 410, message: "Upload ticket expired" }
    }
    return { ticket }
  }

  describe(ticket) {
    if (ticket.status === "completed") {
      return { status: "completed", result: ticket.result }
    }
    if (ticket.status === "failed") {
      return { status: "failed", error: ticket.error }
    }
    return {
      status: "pending",
      claimed: ticket.claimed,
      ...(ticket.claimed ? {} : { path: ticket.path, maxBytes: ticket.maxBytes }),
    }
  }

  async handle(req, res, url) {
    if (!url.pathname.startsWith(UPLOAD_PATH)) return false
    const token = url.pathname.slice(UPLOAD_PATH.length)
    if (!token || token.includes("/")) {
      writeJson(res, 404, { ok: false, error: "Unknown upload ticket" })
      return true
    }

    const found = this.lookup(token)
    if (!found.ticket) {
      writeJson(res, found.status, { ok: false, error: found.message })
      return true
    }

    if (req.method === "GET") {
      writeJson(res, 200, {
        ok: true,
        data: this.describe(found.ticket),
      })
      return true
    }

    if (req.method !== "PUT") {
      writeJson(res, 405, { ok: false, error: "Upload tickets accept GET and PUT" })
      return true
    }

    if (found.ticket.status === "completed") {
      writeJson(res, 200, { ok: true, data: this.describe(found.ticket) })
      return true
    }
    if (found.ticket.status === "failed") {
      writeJson(res, 400, {
        ok: false,
        error: found.ticket.error,
        data: this.describe(found.ticket),
      })
      return true
    }
    if (found.ticket.claimed) {
      writeJson(res, 409, {
        ok: false,
        error: "Upload already in progress",
        data: this.describe(found.ticket),
      })
      return true
    }
    if (this.activeRequests.size > 0) {
      writeJson(res, 409, { ok: false, error: "Another file upload is in progress" })
      return true
    }

    found.ticket.claimed = true
    this.activeRequests.add(req)
    const uploadDeadline = setTimeout(() => {
      req.destroy(new Error("Upload ticket expired during transfer"))
    }, Math.max(1, found.ticket.expiresAt - this.now()))
    try {
      const contentType = req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase()
      if (contentType !== "application/octet-stream") {
        req.resume()
        throw new Error("Content-Type must be application/octet-stream")
      }
      const bytes = await readBody(req, found.ticket.maxBytes)
      if (found.ticket.expiresAt <= this.now()) throw new Error("Upload ticket expired")
      if (this.closed) throw new Error("File upload session closed")
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      if (found.ticket.expectedSha256 && found.ticket.expectedSha256 !== sha256) {
        throw new Error(`Upload SHA-256 ${sha256} does not match expected ${found.ticket.expectedSha256}`)
      }
      // The core operation has its own deadline. Give its terminal result a
      // complete ticket lifetime after it settles.
      clearTimeout(uploadDeadline)
      found.ticket.expiresAt = Infinity
      const result = found.ticket.operation === "mount_disk"
        ? await this.core.mountDiskBytes(found.ticket, bytes)
        : await this.core.loadBinaryBytes(found.ticket, bytes)
      if (this.closed) throw new Error("File upload session closed")
      const receipt = { ...result, byteCount: bytes.length, sha256 }
      this.tickets.set(token, {
        expiresAt: this.now() + this.ttlMs,
        status: "completed",
        result: receipt,
      })
      writeJson(res, 200, {
        ok: true,
        data: this.describe(this.tickets.get(token)),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.closed) {
        this.tickets.set(token, {
          expiresAt: this.now() + this.ttlMs,
          status: "failed",
          error: message,
        })
      }
      writeJson(res, 400, {
        ok: false,
        error: message,
        data: { status: "failed", error: message },
      })
    } finally {
      clearTimeout(uploadDeadline)
      this.activeRequests.delete(req)
    }
    return true
  }

  close() {
    this.closed = true
    this.tickets.clear()
    for (const request of this.activeRequests) {
      request.destroy(new Error("File upload session closed"))
    }
  }
}
