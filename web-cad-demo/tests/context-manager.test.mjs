import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationContext } from "../gateway/llm/context-manager.mjs";

test("conversation context keeps recent turns and compacts older turns", () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `turn-${index + 1}`,
    role: index % 2 ? "assistant" : "user",
    content: index === 1 ? "确认变量 substrateWidth=40mm" : `message ${index + 1}`,
    revision: index,
    planId: index % 3 === 0 ? `plan-${index}` : undefined,
  }));
  const context = buildConversationContext(messages, { recentLimit: 4, maxSummaryChars: 500 });
  assert.equal(context.recent.length, 4);
  assert.equal(context.recent[0].id, "turn-9");
  assert.equal(context.compacted, true);
  assert.equal(context.summary.summarizedThroughTurnId, "turn-8");
  assert.match(context.summary.text, /turn|确认变量/);
  assert.equal(context.summary.keyFacts[0].sourceTurnId, "turn-2");
  assert.ok(context.tokenEstimate > 0);
});

test("empty conversation context is stable", () => {
  assert.deepEqual(buildConversationContext([]), {
    recent: [],
    summary: { version: 2, turns: 0, summarizedThroughTurnId: null, text: "", keyFacts: [] },
    tokenEstimate: 26,
    compacted: false,
  });
});
