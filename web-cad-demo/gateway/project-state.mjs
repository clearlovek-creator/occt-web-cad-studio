import { createHash } from "node:crypto";

/** Opaque edit precondition, not the native geometry revision. Undo/Redo append
 * events, so returning to identical geometry/data never revives an old token.
 * Checkpoint maintenance and idempotency recording do not change this token. */
export function projectStateToken(documentId, history) {
  return createHash("sha256").update(JSON.stringify([documentId, history.events?.at(-1)?.eventId || "initial"])).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const transport = new Set(["clientRequestId", "requestId", "baseRevision", "baseStateToken", "agentPlanId", "conversationId", "workerCapabilityPrecondition"]);
export function mutationFingerprint(operation, fields) {
  const semantic = Object.fromEntries(Object.entries(fields).filter(([key]) => !transport.has(key)));
  return createHash("sha256").update(JSON.stringify(canonical({operation, fields: semantic}))).digest("hex");
}
