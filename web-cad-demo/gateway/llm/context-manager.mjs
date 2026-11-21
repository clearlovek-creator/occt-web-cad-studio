const DEFAULT_RECENT_LIMIT = 8;
const DEFAULT_SUMMARY_CHARS = 12_000;
const DEFAULT_RECENT_BYTES = 64_000;
const MAX_COMPACT_DEPTH = 3;
const LARGE_RESULT_KEYS = new Set(["positions", "normals", "indices", "triangleFaceIds", "edges", "bodyPresentations", "bodyMetadata", "mesh", "geometry"]);

function text(value, max = 2_000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_COMPACT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    if (value.length > 32) return { count: value.length, truncated: true };
    return value.map((item) => compactValue(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (LARGE_RESULT_KEYS.has(key)) {
      output[key] = Array.isArray(item) ? { count: item.length, truncated: true } : "[truncated]";
      continue;
    }
    output[key] = compactValue(item, depth + 1);
  }
  if (Object.keys(value).length > 64) output.truncatedKeys = true;
  return output;
}

export function compactToolResult(value) {
  const result = compactValue(value);
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") <= 16_000) return result;
  return {
    ok: value?.ok === true,
    status: value?.status || "unknown",
    revision: value?.revision ?? null,
    summary: text(value?.error || value?.result?.error || "Tool result compacted.", 500),
    truncated: true,
  };
}

function compactMessage(message) {
  return {
    role: message.role,
    content: text(message.content, 4_000),
    ...(message.id ? { id: message.id } : {}),
    ...(message.planId ? { planId: message.planId } : {}),
    ...(Number.isFinite(Number(message.revision)) ? { revision: Number(message.revision) } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
    ...(message.toolArguments ? { toolArguments: compactValue(message.toolArguments) } : {}),
    ...(message.toolResult ? { toolResult: compactToolResult(message.toolResult) } : {}),
    ...((message.reasoningContent || message.reasoning_content) ? { reasoningContent: text(message.reasoningContent || message.reasoning_content, 12_000) } : {}),
    ...(Array.isArray(message.entityRefs) && message.entityRefs.length ? { entityRefs: message.entityRefs.slice(0, 16) } : {}),
  };
}

function factsFrom(messages) {
  const facts = [];
  for (const message of messages) {
    const content = text(message.content, 600);
    if (!content) continue;
    if (/(变量|variable|材料|material|坐标系|coordinate|属性|property|确认|采用|不要|不能|必须)/i.test(content)) {
      facts.push({
        sourceTurnId: message.id || null,
        role: message.role,
        content,
        ...(message.planId ? { planId: message.planId } : {}),
        ...(Number.isFinite(Number(message.revision)) ? { revision: Number(message.revision) } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.toolResult ? { toolResult: compactToolResult(message.toolResult) } : {}),
      });
    }
  }
  return facts.slice(-32);
}

function summaryText(messages, maxChars) {
  const lines = messages.map((message) => {
    const prefix = message.role === "user" ? "User" : message.role === "assistant" ? "Agent" : message.role === "tool" ? "Tool" : "System";
    const refs = Array.isArray(message.entityRefs) && message.entityRefs.length
      ? ` [refs:${message.entityRefs.map((ref) => `${ref.kind}:${ref.id}`).join(",")}]`
      : "";
    const plan = message.planId ? ` [plan:${message.planId}]` : "";
    const revision = Number.isFinite(Number(message.revision)) ? ` [R${message.revision}]` : "";
    return `${prefix}${revision}${plan}${refs}: ${text(message.content, 500)}`;
  });
  let result = lines.join("\n");
  if (result.length > maxChars) result = result.slice(result.length - maxChars);
  return result;
}

export function buildConversationContext(messages, { recentLimit = DEFAULT_RECENT_LIMIT, maxSummaryChars = DEFAULT_SUMMARY_CHARS, maxRecentBytes = DEFAULT_RECENT_BYTES } = {}) {
  const source = Array.isArray(messages) ? messages.filter((message) => message && typeof message === "object") : [];
  const splitAt = Math.max(0, source.length - Math.max(1, recentLimit));
  const older = source.slice(0, splitAt);
  const originalRecent = source.slice(splitAt);
  let recent = originalRecent.map(compactMessage);
  while (recent.length > 1 && Buffer.byteLength(JSON.stringify(recent), "utf8") > maxRecentBytes) recent = recent.slice(1);
  const summary = {
    version: 2,
    turns: older.length + Math.max(0, originalRecent.length - recent.length),
    summarizedThroughTurnId: (older.at(-1) || originalRecent[originalRecent.length - recent.length - 1])?.id || null,
    text: summaryText([...older, ...originalRecent.slice(0, Math.max(0, originalRecent.length - recent.length))], maxSummaryChars),
    keyFacts: factsFrom([...older, ...originalRecent.slice(0, Math.max(0, originalRecent.length - recent.length))]),
  };
  const tokenEstimate = Math.ceil(Buffer.byteLength(JSON.stringify({ summary, recent }), "utf8") / 4);
  return { recent, summary, tokenEstimate, compacted: older.length > 0 || recent.length < originalRecent.length };
}

export { compactMessage };