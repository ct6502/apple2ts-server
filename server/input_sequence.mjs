const SPACES = new Set(["active", "main", "aux"])
const OUTCOMES = new Set([
  "completed", "timeout", "cancelled", "unexpected_stop", "not_running", "input_busy",
])
const DELIVERY_OUTCOMES = new Set([
  "completed", "timeout", "interrupted", "not_running", "input_busy",
])

const validDelivery = (delivery, keyCount) => DELIVERY_OUTCOMES.has(delivery?.outcome)
  && Number.isInteger(delivery.keysDelivered)
  && delivery.keysDelivered >= 0 && delivery.keysDelivered <= keyCount
  && typeof delivery.keyMayHaveBeenObserved === "boolean"
  && (delivery.outcome === "completed"
    ? delivery.keysDelivered === keyCount && delivery.keyMayHaveBeenObserved === false
    : delivery.outcome === "timeout" || delivery.outcome === "interrupted"
      ? delivery.keyMayHaveBeenObserved === true
      : delivery.keysDelivered === 0 && delivery.keyMayHaveBeenObserved === false)

const validatePredicate = (predicate) => {
  if (!predicate || typeof predicate !== "object") throw new Error("memory predicate is required")
  if ("all" in predicate) throw new Error("nested memory conditions are not supported")
  if (!Number.isInteger(predicate.address) || predicate.address < 0 || predicate.address > 0xFFFF) {
    throw new Error("predicate address must be between 0 and 65535")
  }
  const space = predicate.space ?? "active"
  if (!SPACES.has(space)) throw new Error("invalid predicate memory space")
  if (!Array.isArray(predicate.bytes) || predicate.bytes.length < 1 || predicate.bytes.length > 32
    || predicate.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xFF)) {
    throw new Error("predicate bytes must contain 1 to 32 byte values")
  }
  if (predicate.address + predicate.bytes.length > 0x10000) {
    throw new Error("predicate range must not wrap past 65535")
  }
  if (space !== "active" && predicate.address + predicate.bytes.length > 0xC000) {
    throw new Error("physical predicate range must fit within main or auxiliary RAM")
  }
  if (predicate.auxBank !== undefined
    && (space !== "aux" || !Number.isInteger(predicate.auxBank)
      || predicate.auxBank < 0 || predicate.auxBank > 127)) {
    throw new Error("predicate auxBank is valid only for auxiliary memory")
  }
  if (predicate.mask !== undefined
    && (!Array.isArray(predicate.mask) || predicate.mask.length !== predicate.bytes.length
      || predicate.mask.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xFF))) {
    throw new Error("predicate mask must match the byte pattern")
  }
  return {...predicate, space}
}

const conditionPredicates = condition => condition?.all ?? (condition ? [condition] : [])

const validateCondition = condition => {
  if (!condition || !("all" in condition)) return validatePredicate(condition)
  if (Object.keys(condition).length !== 1 || !Array.isArray(condition.all)
    || condition.all.length < 1 || condition.all.length > 8) {
    throw new Error("all must contain 1 to 8 non-nested memory predicates")
  }
  return {all: condition.all.map(validatePredicate)}
}

const validBytes = (actual, condition, matched = false) => {
  const predicates = conditionPredicates(condition)
  return Array.isArray(actual) && actual.length === predicates.length
    && actual.every((bytes, index) => Array.isArray(bytes)
      && bytes.length === predicates[index].bytes.length
      && bytes.every((byte, offset) => Number.isInteger(byte) && byte >= 0 && byte <= 255
        && (!matched || (byte & (predicates[index].mask?.[offset] ?? 255))
          === (predicates[index].bytes[offset] & (predicates[index].mask?.[offset] ?? 255)))))
}

export const validateConditionalInputRequest = (body) => {
  if (body?.startExecution !== undefined && typeof body.startExecution !== "boolean") {
    throw new Error("startExecution must be boolean")
  }
  if (!Array.isArray(body?.phases) || body.phases.length < 1 || body.phases.length > 16) {
    throw new Error("phases must contain 1 to 16 entries")
  }
  let totalKeys = 0
  const phases = body.phases.map((phase) => {
    const keys = typeof phase?.keys === "string" ? Array.from(phase.keys) : []
    if (keys.length < 1 || keys.length > 32
      || keys.some((key) => !/^[\u0001-\u00FF]$/.test(key))) {
      throw new Error("each phase must contain 1 to 32 Apple II keys")
    }
    totalKeys += keys.length
    return {
      keys: phase.keys,
      ...(phase.when === undefined ? {} : {when: validateCondition(phase.when)}),
    }
  })
  if (totalKeys > 64) throw new Error("phases cannot contain more than 64 keys")
  if (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > 120000) {
    throw new Error("timeoutMs must be an integer between 1 and 120000")
  }
  return {
    phases,
    final: validateCondition(body.final),
    timeoutMs: body.timeoutMs,
    ...(body.startExecution === undefined ? {} : {startExecution: body.startExecution}),
  }
}

export const validateConditionalInputResult = (result, input) => {
  const phaseCount = input.phases.length
  const completed = result?.outcome === "completed"
  const terminal = !new Set(["not_running", "input_busy"]).has(result?.outcome)
  const deliveriesValid = Array.isArray(result?.keyDeliveries)
    && result.keyDeliveries.length >= result.completedPhases
    && result.keyDeliveries.length <= result.completedPhases + 1
    && result.keyDeliveries.length <= phaseCount
    && result.keyDeliveries.every((delivery, index) => {
      const keyCount = Array.from(input.phases[index].keys).length
      return delivery?.phase === index
        && validDelivery(delivery, keyCount)
        && (input.phases[index].when
          ? Number.isSafeInteger(delivery.predicateMatchCycle) && delivery.predicateMatchCycle >= 0
          : delivery.predicateMatchCycle === null)
        && validBytes(delivery.matchedBytes, input.phases[index].when, true)
        && Array.isArray(delivery.keyConsumptionCycles)
        && delivery.keyConsumptionCycles.length === delivery.keysDelivered
        && delivery.keyConsumptionCycles.every((cycle, key) => Number.isSafeInteger(cycle)
          && cycle >= (key ? delivery.keyConsumptionCycles[key - 1] : delivery.predicateMatchCycle ?? 0))
        && (index < result.completedPhases) === (delivery.outcome === "completed")
    })
  const timedOutDelivery = result?.keyDeliveries?.at(-1)?.outcome === "timeout"
  const pendingCondition = input.phases[result?.completedPhases]?.when
    ?? (result?.completedPhases === phaseCount ? input.final : undefined)
  const timeoutValid = result?.outcome === "timeout"
    ? result.timeout?.waitingFor === (timedOutDelivery ? "key_consumption" : "condition")
      && validBytes(result.timeout.actualBytes, pendingCondition)
    : result?.timeout === undefined
  if (!OUTCOMES.has(result?.outcome)
    || !Number.isInteger(result?.completedPhases)
    || result.completedPhases < 0 || result.completedPhases > phaseCount
    || (completed ? result.completedPhases !== phaseCount || result.failurePhase !== null
      : result.failurePhase !== result.completedPhases)
    || !deliveriesValid || !timeoutValid || (completed && result.keyDeliveries.length !== phaseCount)
    || (["not_running", "input_busy"].includes(result?.outcome)
      && (result.completedPhases !== 0 || result.keyDeliveries.length !== 0))
    || !Number.isSafeInteger(result.cyclesElapsed) || result.cyclesElapsed < 0
    || !result.status?.machine?.execution
    || (terminal && result.status.machine.execution.state !== "paused")
    || (["completed", "timeout", "cancelled"].includes(result?.outcome)
      && result.status.machine.execution.pauseReason !== "input-sequence")) {
    throw new Error("Invalid conditional input result from browser client")
  }
  return result
}
