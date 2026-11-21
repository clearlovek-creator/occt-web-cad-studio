import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_EVENTS = 2000;
const MAX_TEXT = 1000;

function text(value, max = MAX_TEXT) {
  return String(value ?? "").trim().slice(0, max);
}

function auditId() {
  return `agent-audit-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function safeEvent(input = {}) {
  const event = {
    id: text(input.id, 120) || auditId(),
    timestamp: text(input.timestamp, 40) || new Date().toISOString(),
    type: text(input.type, 80) || "agent.event",
    documentId: text(input.documentId, 80) || null,
    conversationId: text(input.conversationId, 120) || null,
    requestId: text(input.requestId, 160) || null,
    providerId: text(input.providerId, 80) || null,
    model: text(input.model, 160) || null,
    planId: text(input.planId, 160) || null,
    operation: text(input.operation, 120) || null,
    status: text(input.status, 40) || null,
    durationMs: Number.isFinite(Number(input.durationMs)) ? Math.max(0, Math.trunc(Number(input.durationMs))) : null,
    attempts: Number.isFinite(Number(input.attempts)) ? Math.max(0, Math.trunc(Number(input.attempts))) : null,
    revision: Number.isInteger(input.revision) ? input.revision : null,
    summary: text(input.summary, MAX_TEXT) || null,
    errorCode: text(input.errorCode, 120) || null,
    errorClass: text(input.errorClass, 80) || null,
    protocol: text(input.protocol, 40) || null,
    turn: Number.isFinite(Number(input.turn)) ? Math.max(0, Math.trunc(Number(input.turn))) : null,
    toolCount: Number.isFinite(Number(input.toolCount)) ? Math.max(0, Math.trunc(Number(input.toolCount))) : null,
    promptBytes: Number.isFinite(Number(input.promptBytes)) ? Math.max(0, Math.trunc(Number(input.promptBytes))) : null,
    contextBytes: Number.isFinite(Number(input.contextBytes)) ? Math.max(0, Math.trunc(Number(input.contextBytes))) : null,
    retryAfterMs: Number.isFinite(Number(input.retryAfterMs)) ? Math.max(0, Math.trunc(Number(input.retryAfterMs))) : null,
  };
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== null && value !== ""));
}

export class AgentAuditStore {
  constructor(dataDir, { limit = MAX_EVENTS } = {}) {
    this.filePath = path.join(dataDir, "agent-audit.json");
    this.limit = Math.max(100, Math.min(MAX_EVENTS, Math.trunc(limit)));
    this.events = [];
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed)) this.events = parsed.map(safeEvent).slice(-this.limit);
    } catch { this.events = []; }
  }

  save() {
    const temporary = this.filePath + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
    fs.writeFileSync(temporary, JSON.stringify(this.events, null, 2), "utf8");
    try {
      fs.rmSync(this.filePath, { force: true });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      try {
        fs.copyFileSync(temporary, this.filePath);
        fs.rmSync(temporary, { force: true });
      } catch {
        try { fs.rmSync(temporary, { force: true }); } catch { /* ignore cleanup */ }
        throw error;
      }
    }
  }  append(input) {
    const event = safeEvent(input);
    this.events = [...this.events, event].slice(-this.limit);
    this.save();
    return event;
  }

  list({ documentId, conversationId, limit = 100 } = {}) {
    const max = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.events.filter((event) => (!documentId || event.documentId === String(documentId)) && (!conversationId || event.conversationId === String(conversationId))).slice(-max);
  }
}

export { safeEvent };
