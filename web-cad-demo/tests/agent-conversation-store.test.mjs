import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentConversationStore } from "../gateway/agent-conversation-store.mjs";

test("Agent conversation snapshots replace existing Windows files safely", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-conversation-save-"));
  try {
    const store = new AgentConversationStore(dataDir);
    const conversation = store.create("save-test");
    for (let index = 0; index < 12; index += 1) {
      store.append(conversation.id, "save-test", { role: "user", content: `message-${index}` });
    }
    const file = path.join(dataDir, "agent-conversations", `${conversation.id}.json`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.messages.at(-1).content, "message-11");
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
test("manual compaction persists a conversation summary", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-conversation-compact-"));
  try {
    const store = new AgentConversationStore(dataDir);
    const conversation = store.create("compact-test");
    for (let index = 0; index < 10; index += 1) store.append(conversation.id, "compact-test", { role: "user", content: `turn-${index}` });
    const result = store.compact(conversation.id, "compact-test");
    assert.equal(result.context.compacted, true);
    assert.equal(result.context.recentCount, 8);
    assert.equal(result.conversation.contextSummary.turns, 2);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
test("conversation context strips render meshes from tool results", async () => {
  const { compactToolResult } = await import("../gateway/llm/context-manager.mjs");
  const compacted = compactToolResult({ ok: true, status: "executed", revision: 7, result: { positions: Array.from({ length: 100000 }, () => 1), normals: Array.from({ length: 100000 }, () => 0), indices: Array.from({ length: 30000 }, () => 0), stats: { faceCount: 6 } } });
  const serialized = JSON.stringify(compacted);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 16_000);
  assert.doesNotMatch(serialized, /1,1,1,1,1/);
  assert.match(serialized, /truncated/);
});
test("conversation store rejects stale snapshot writes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-conversation-version-"));
  try {
    const store = new AgentConversationStore(dataDir);
    const conversation = store.create("version-test");
    const current = store.get(conversation.id, "version-test");
    assert.throws(() => store.save({ ...current, version: current.version }), /CONVERSATION_STALE_WRITE/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});