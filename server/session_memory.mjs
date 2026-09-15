// Shared validation for the private HTTP bridge and MCP adapter.
export const validateSessionMemoryRequest = (input) => {
  const {snapshotId, address, length, space = "main", auxBank, maxChanges = 32} = input
  if (typeof snapshotId !== "string"
    || !/^session-snapshot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshotId)) {
    throw new Error("snapshotId is invalid")
  }
  if (!Number.isInteger(address) || address < 0 || !Number.isInteger(length)
    || length < 1 || address + length > 0xC000) {
    throw new Error("Physical memory range must fit within $0000-$BFFF")
  }
  if (space !== "main" && space !== "aux") throw new Error("space must be 'main' or 'aux'")
  if (auxBank !== undefined && (space !== "aux" || !Number.isInteger(auxBank) || auxBank < 0 || auxBank > 127)) {
    throw new Error("auxBank requires auxiliary space and an integer between 0 and 127")
  }
  if (!Number.isInteger(maxChanges) || maxChanges < 1 || maxChanges > 64) {
    throw new Error("maxChanges must be an integer between 1 and 64")
  }
  return {snapshotId, address, length, space, ...(auxBank === undefined ? {} : {auxBank}), maxChanges}
}

export const validateSessionMemoryResult = (request, result) => {
  const bank = result?.effectiveAuxBank
  const segment = result?.effectiveSegments?.[0]
  const changes = result?.changes
  const mappingKeys = ["RAMRD", "RAMWRT", "ALTZP", "80STORE", "PAGE2", "HIRES"]
  if (!result || Object.hasOwn(result, "bytes") || Object.hasOwn(result, "memory")
    || result.snapshotId !== request.snapshotId
    || result.address !== request.address || result.length !== request.length
    || result.requestedSpace !== request.space
    || (result.requestedAuxBank ?? null) !== (request.auxBank ?? null)
    || (request.space === "main" ? bank !== null : !Number.isInteger(bank) || bank < 0 || bank > 127)
    || (request.auxBank !== undefined && bank !== request.auxBank)
    || !Array.isArray(result.effectiveSegments) || result.effectiveSegments.length !== 1
    || segment?.address !== request.address || segment?.length !== request.length
    || segment?.space !== request.space || (segment?.auxBank ?? null) !== bank
    || !Number.isSafeInteger(result.baselineCycleCount) || result.baselineCycleCount < 0
    || !Number.isSafeInteger(result.currentCycleCount) || result.currentCycleCount < 0
    || !mappingKeys.every((key) => typeof result.currentMapping?.[key] === "boolean")
    || !Number.isInteger(result.totalChangeCount) || result.totalChangeCount < 0
    || result.totalChangeCount > request.length
    || !Array.isArray(changes) || changes.length !== Math.min(result.totalChangeCount, request.maxChanges)
    || result.truncated !== (result.totalChangeCount > changes.length)
    || changes.some((change, index) => !change
      || !Number.isInteger(change.address) || change.address < request.address
      || change.address >= request.address + request.length
      || (index > 0 && change.address <= changes[index - 1].address)
      || !Number.isInteger(change.before) || change.before < 0 || change.before > 255
      || !Number.isInteger(change.after) || change.after < 0 || change.after > 255
      || change.before === change.after)) {
    throw new Error("Session memory comparison was not confirmed by the browser client")
  }
  // Project only the bounded evidence; no unexpected worker payload escapes.
  return {
    snapshotId: result.snapshotId,
    address: result.address, length: result.length, requestedSpace: result.requestedSpace,
    requestedAuxBank: result.requestedAuxBank ?? null, effectiveAuxBank: bank,
    effectiveSegments: [{address: segment.address, length: segment.length, space: segment.space,
      ...(bank === null ? {} : {auxBank: bank})}],
    baselineCycleCount: result.baselineCycleCount, currentCycleCount: result.currentCycleCount,
    currentMapping: Object.fromEntries(mappingKeys.map((key) => [key, result.currentMapping[key]])),
    changes: changes.map(({address, before, after}) => ({address, before, after})),
    totalChangeCount: result.totalChangeCount, truncated: result.truncated,
  }
}
