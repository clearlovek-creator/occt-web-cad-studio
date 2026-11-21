import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildConversationContext, compactToolResult } from "./llm/context-manager.mjs";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function id(value, field) {
  const result = String(value || "");
  if (!ID_PATTERN.test(result)) throw new Error(`${field} is invalid.`);
  return result;
}

function timestamp() { return new Date().toISOString(); }

function conversationId() { return `conversation-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`; }

function normalizeMessage(input) {
  if (!input || typeof input !== "object") throw new Error("message must be an object.");
  const role = String(input.role || "");
  if (!["user", "assistant", "system", "tool"].includes(role)) throw new Error("message.role is invalid.");
  const content = String(input.content || "").trim();
  if (!content || content.length > 12000) throw new Error("message.content is required and must be at most 12000 characters.");
  const refs = Array.isArray(input.entityRefs) ? input.entityRefs.slice(0, 64).map((ref) => ({
    kind: String(ref?.kind || "").slice(0, 40),
    id: String(ref?.id || "").slice(0, 120),
    label: String(ref?.label || "").slice(0, 160),
  })).filter((ref) => ref.kind && ref.id) : [];
  return {
    id: String(input.id || `message-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`).slice(0, 120),
    role,
    content,
    createdAt: String(input.createdAt || timestamp()),
    ...(input.planId ? { planId: String(input.planId).slice(0, 120) } : {}),
    ...(Number.isFinite(Number(input.revision)) ? { revision: Number(input.revision) } : {}),
    ...(input.toolCallId ? { toolCallId: String(input.toolCallId).slice(0, 160) } : {}),
    ...(input.toolName ? { toolName: String(input.toolName).slice(0, 120) } : {}),
    ...(input.toolArguments && typeof input.toolArguments === 'object' ? { toolArguments: input.toolArguments } : {}),
    ...(input.toolResult && typeof input.toolResult === 'object' ? { toolResult: compactToolResult(input.toolResult) } : {}),
    ...((input.reasoningContent || input.reasoning_content) ? { reasoningContent: String(input.reasoningContent || input.reasoning_content).slice(0, 12000) } : {}),
    ...(refs.length ? { entityRefs: refs } : {}),
  };
}

export class AgentConversationStore {
  constructor(dataDir, { limit = 200 } = {}) {
    this.rootDir = path.join(dataDir, "agent-conversations");
    this.limit = limit;
    this.conversations = new Map();
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.load();
  }

  filePath(idValue) { return path.join(this.rootDir, `${id(idValue, "conversationId")}.json`); }

  load() {
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.rootDir, entry.name), "utf8"));
        if (parsed?.id && parsed?.documentId) this.conversations.set(parsed.id, parsed);
      } catch { /* ignore a damaged conversation; CAD history remains independent */ }
    }
  }

  save(conversation) {
    const current = this.conversations.get(conversation.id);
    if (current && Number(conversation.version || 0) <= Number(current.version || 0)) throw new Error("CONVERSATION_STALE_WRITE");
    const target = this.filePath(conversation.id);
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(temporary, JSON.stringify(conversation, null, 2), "utf8");
    try {
      // Windows cannot atomically rename over an existing file. Remove the old
      // snapshot first, then replace it with this uniquely named temporary file.
      fs.rmSync(target, { force: true });
      fs.renameSync(temporary, target);
    } catch (error) {
      // A transient file lock should not abort a modeling operation. Direct
      // copy is overwrite-safe and is used as a final persistence fallback.
      try {
        fs.copyFileSync(temporary, target);
        fs.rmSync(temporary, { force: true });
      } catch {
        try { fs.rmSync(temporary, { force: true }); } catch { /* ignore cleanup */ }
        throw error;
      }
    }
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }
  create(documentIdValue, title = "建模会话") {
    const documentId = id(documentIdValue || "default", "documentId");
    const conversation = { id: conversationId(), documentId, title: String(title || "建模会话").slice(0, 160), createdAt: timestamp(), updatedAt: timestamp(), version: 1, messages: [], contextSummary: buildConversationContext([]).summary, activePlan: null, pendingPrompt: null, pendingToolCall: null, pendingRevision: null, pendingFingerprint: null };
    return this.save(conversation);
  }

  get(conversationIdValue, documentIdValue) {
    const conversation = this.conversations.get(id(conversationIdValue, "conversationId"));
    if (!conversation || (documentIdValue && conversation.documentId !== id(documentIdValue, "documentId"))) return null;
    return conversation;
  }

  list(documentIdValue) {
    const documentId = id(documentIdValue || "default", "documentId");
    return [...this.conversations.values()].filter((item) => item.documentId === documentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50).map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length }));
  }

  remove(conversationIdValue, documentIdValue) {
    const conversation = this.get(conversationIdValue, documentIdValue);
    if (!conversation) throw new Error("Agent conversation does not exist.");
    fs.rmSync(this.filePath(conversation.id), { force: true });
    this.conversations.delete(conversation.id);
    return conversation;
  }

  append(conversationIdValue, documentIdValue, message) {
    const conversation = this.get(conversationIdValue, documentIdValue);
    if (!conversation) throw new Error("Agent conversation does not exist.");
    const messages = [...conversation.messages, normalizeMessage(message)].slice(-this.limit);
    const next = { ...conversation, version: Number(conversation.version || 0) + 1, updatedAt: timestamp(), messages, contextSummary: buildConversationContext(messages).summary };
    return this.save(next);
  }

  compact(conversationIdValue, documentIdValue, options = {}) {
    const conversation = this.get(conversationIdValue, documentIdValue);
    if (!conversation) throw new Error("Agent conversation does not exist.");
    const context = buildConversationContext(conversation.messages || [], {
      recentLimit: Number.isFinite(Number(options.recentLimit)) ? Number(options.recentLimit) : 8,
      maxSummaryChars: Number.isFinite(Number(options.maxSummaryChars)) ? Number(options.maxSummaryChars) : 12_000,
    });
    const next = this.save({ ...conversation, version: Number(conversation.version || 0) + 1, updatedAt: timestamp(), contextSummary: context.summary });
    return {
      conversation: next,
      context: {
        compacted: context.compacted,
        tokenEstimate: context.tokenEstimate,
        recentCount: context.recent.length,
        summary: context.summary,
      },
    };
  }
  updateState(conversationIdValue, documentIdValue, state = {}) {
    const conversation = this.get(conversationIdValue, documentIdValue);
    if (!conversation) throw new Error("Agent conversation does not exist.");
    const activePlan = state.activePlan && typeof state.activePlan === "object" ? state.activePlan : null;
    const pendingPrompt = state.pendingPrompt == null ? null : String(state.pendingPrompt).trim().slice(0, 12000) || null;
    const pendingToolCall = state.pendingToolCall && typeof state.pendingToolCall === "object" ? state.pendingToolCall : null;
    const pendingRevision = Number.isInteger(state.pendingRevision) ? state.pendingRevision : null;
    const pendingFingerprint = state.pendingFingerprint == null ? null : String(state.pendingFingerprint).slice(0, 240) || null;
    return this.save({ ...conversation, version: Number(conversation.version || 0) + 1, updatedAt: timestamp(), activePlan, pendingPrompt, pendingToolCall, pendingRevision, pendingFingerprint, contextSummary: buildConversationContext(conversation.messages || []).summary });
  }
}

export { normalizeMessage };
