import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentAuditStore, safeEvent } from "../gateway/llm/agent-audit-store.mjs";

test("Agent audit store persists trace fields without secrets", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-agent-audit-"));
  try {
    const store = new AgentAuditStore(dataDir, { limit: 100 });
    const event = store.append({ type: "agent.plan.generated", documentId: "doc-1", conversationId: "conversation-1", requestId: "req-1", providerId: "mock", model: "model-x", planId: "plan-1", status: "ready", durationMs: 12, attempts: 1, summary: "create box", apiKey: "do-not-store" });
    assert.equal(event.planId, "plan-1");
    assert.equal(event.apiKey, undefined);
    assert.equal(store.list({ documentId: "doc-1" }).length, 1);
    const restored = new AgentAuditStore(dataDir);
    assert.equal(restored.list({ conversationId: "conversation-1" })[0].providerId, "mock");
    assert.doesNotMatch(fs.readFileSync(path.join(dataDir, "agent-audit.json"), "utf8"), /do-not-store/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("safeEvent bounds free-form audit text", () => {
  const event = safeEvent({ type: "agent.plan.failed", summary: "x".repeat(5000), errorCode: "E".repeat(5000) });
  assert.equal(event.summary.length, 1000);
  assert.equal(event.errorCode.length, 120);
});
