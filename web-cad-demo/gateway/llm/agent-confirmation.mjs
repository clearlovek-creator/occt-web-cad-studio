import { createHash } from "node:crypto";

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function parseArguments(call) {
  if (!call || typeof call !== "object") return {};
  if (call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)) return call.arguments;
  if (typeof call.arguments === "string") {
    try {
      const parsed = JSON.parse(call.arguments);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

/**
 * A confirmation fingerprint binds the approval to the exact operation that
 * was shown to the user. It deliberately includes entity references and the
 * document revision so a stale or substituted Tool Call cannot be resumed.
 */
export function confirmationFingerprint({ planId = null, revision = null, call = null } = {}) {
  const args = parseArguments(call);
  const entityKeys = ["bodyId", "targetBody", "toolBody", "sourceBody", "featureId", "edgeId", "faceId", "topologyId", "material", "coordinateSystemId"];
  const entities = Object.fromEntries(entityKeys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
  const payload = {
    planId: planId == null ? null : String(planId),
    revision: Number.isInteger(revision) ? revision : null,
    toolName: String(call?.name || ""),
    arguments: args,
    entities,
  };
  return createHash("sha256").update(stable(payload)).digest("hex");
}

export function sameConfirmationFingerprint(expected, actual) {
  return Boolean(expected && actual && String(expected) === String(actual));
}

export { parseArguments as parseConfirmationArguments };
