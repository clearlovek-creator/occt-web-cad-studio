import assert from "node:assert/strict";
import { test } from "node:test";
import { corsHeaders, resolveCorsOrigin } from "../gateway/cors.mjs";

test("accepts localhost aliases on the configured development port", () => {
  const configured = "http://localhost:3000";
  assert.equal(resolveCorsOrigin("http://localhost:3000", configured), configured);
  assert.equal(resolveCorsOrigin("http://127.0.0.1:3000", configured), "http://127.0.0.1:3000");
  assert.equal(resolveCorsOrigin("http://[::1]:3000", configured), "http://[::1]:3000");
  assert.equal(resolveCorsOrigin("http://localhost:3001", configured), configured);
  assert.equal(resolveCorsOrigin("https://evil.example", configured), configured);
});

test("declares DELETE for Provider removal preflight", () => {
  assert.match(corsHeaders("http://localhost:3000")["Access-Control-Allow-Methods"], /\bDELETE\b/);
});