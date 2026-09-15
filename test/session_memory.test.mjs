import assert from "node:assert/strict"
import test from "node:test"
import { Apple2tsCore } from "../server/mcp_stdio.mjs"
import { validateSessionMemoryRequest, validateSessionMemoryResult } from "../server/session_memory.mjs"

const snapshotId = "session-snapshot:123e4567-e89b-42d3-a456-426614174000"
const input = {snapshotId, address: 0x200, length: 2}
const request = validateSessionMemoryRequest(input)
const receipt = {
  snapshotId, address: 0x200, length: 2, requestedSpace: "main",
  requestedAuxBank: null, effectiveAuxBank: null,
  effectiveSegments: [{address: 0x200, length: 2, space: "main"}],
  baselineCycleCount: 100, currentCycleCount: 150,
  currentMapping: {RAMRD: false, RAMWRT: false, ALTZP: false, "80STORE": false, PAGE2: false, HIRES: false},
  changes: [{address: 0x201, before: 0x11, after: 0x22}], totalChangeCount: 1, truncated: false,
}

test("physical comparison request defaults and boundaries", () => {
  assert.deepEqual(request, {...input, space: "main", maxChanges: 32})
  assert.equal(validateSessionMemoryRequest({...input, address: 0, length: 0xC000}).length, 0xC000)
  for (const invalid of [
    {snapshotId: "other"}, {space: "active"}, {address: -1}, {address: 0xC000},
    {length: 0}, {length: 0xC000}, {length: 1.5}, {auxBank: 0},
    {space: "aux", auxBank: -1}, {space: "aux", auxBank: 128}, {maxChanges: 0}, {maxChanges: 65},
  ]) assert.throws(() => validateSessionMemoryRequest({...input, ...invalid}))
})

test("comparison receipts enforce identity, ascending capped evidence, and physical mapping", () => {
  assert.deepEqual(validateSessionMemoryResult(request, receipt), receipt)
  const truncated = {...receipt, totalChangeCount: 2, truncated: true}
  assert.deepEqual(validateSessionMemoryResult({...request, maxChanges: 1}, truncated), truncated)
  assert.equal(validateSessionMemoryResult(request, {...receipt, privatePayload: "hidden"}).privatePayload, undefined)
  for (const invalid of [
    {snapshotId: "stale"}, {address: 0}, {length: 3}, {requestedSpace: "aux"},
    {requestedAuxBank: 0}, {effectiveAuxBank: 0}, {effectiveSegments: []},
    {currentMapping: {}}, {baselineCycleCount: -1}, {currentCycleCount: NaN},
    {bytes: [1]}, {memory: "payload"}, {totalChangeCount: 3}, {truncated: true},
    {changes: [{address: 0x200, before: 1, after: 1}]},
    {changes: [{address: 0x202, before: 1, after: 2}]},
    {changes: [{address: 0x200, before: 256, after: 2}]},
    {totalChangeCount: 2, changes: [receipt.changes[0], receipt.changes[0]]},
  ]) assert.throws(() => validateSessionMemoryResult(request, {...receipt, ...invalid}))
  const aux = {...receipt, requestedSpace: "aux", requestedAuxBank: 1, effectiveAuxBank: 1,
    effectiveSegments: [{address: 0x200, length: 2, space: "aux", auxBank: 1}]}
  assert.deepEqual(validateSessionMemoryResult({...request, space: "aux", auxBank: 1}, aux), aux)
  assert.throws(() => validateSessionMemoryResult({...request, space: "aux", auxBank: 0}, aux))
})

test("comparison is session-bound, serialized, cancellable, and never starts a mutation", async () => {
  const core = new Apple2tsCore("http://unused.test", "token", {targetId: "one"})
  core.sessionSnapshotId = snapshotId
  const requests = []
  core.request = async (pathname, options) => {
    requests.push({pathname, options})
    return {emulator: core.identity, state: receipt}
  }
  let release
  core.mutations = new Promise((resolve) => { release = resolve })
  const comparison = core.compareSessionMemory(input)
  await Promise.resolve()
  assert.equal(requests.length, 0)
  release()
  assert.deepEqual((await comparison).value, receipt)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].pathname, "/api/private/session-snapshot/compare-memory")
  assert.deepEqual(requests[0].options.body, request)
  core.request = async () => { throw new Error("emulator must be paused") }
  await assert.rejects(core.compareSessionMemory(input), /paused/)
  core.request = async () => ({emulator: core.identity, state: receipt})
  assert.deepEqual((await core.compareSessionMemory(input)).value, receipt)
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await assert.rejects(core.compareSessionMemory(input, controller.signal), /cancelled/)
  assert.deepEqual((await core.compareSessionMemory(input)).value, receipt)
  let entered
  const inFlight = new Promise((resolve) => { entered = resolve })
  let releases = 0
  core.releaseHeldKeyboard = async () => { releases++ }
  core.request = (_pathname, _options, signal) => new Promise((_resolve, reject) => {
    entered()
    signal.addEventListener("abort", () => reject(signal.reason), {once: true})
  })
  const activeController = new AbortController()
  const interrupted = core.compareSessionMemory(input, activeController.signal)
  await inFlight
  activeController.abort(new Error("interrupted read"))
  await assert.rejects(interrupted, /interrupted read/)
  assert.equal(releases, 0)
  core.request = async () => ({emulator: core.identity, state: receipt})
  assert.deepEqual((await core.compareSessionMemory(input)).value, receipt)
  const other = new Apple2tsCore("http://unused.test", "token", {targetId: "two"})
  await assert.rejects(other.compareSessionMemory(input), /not found/)
  core.sessionSnapshotId = "replacement"
  await assert.rejects(core.compareSessionMemory(input), /not found/)
  core.closeExecution()
  await assert.rejects(core.compareSessionMemory(input), /not found/)
})
