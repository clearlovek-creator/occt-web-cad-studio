import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveWritableDataDir } from "../gateway/data-dir.mjs";

test("resolves a writable data directory for geometry persistence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "occt-data-dir-"));
  const configured = path.join(root, "configured");
  const fallbackRoot = path.join(root, "fallback");
  let fallbackNotice = null;
  try {
    const resolved = resolveWritableDataDir(configured, { fallbackRoot, onFallback: (notice) => { fallbackNotice = notice; } });
    assert.equal(resolved, path.resolve(configured));
    assert.equal(fallbackNotice, null);
    assert.ok(fs.existsSync(resolved));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("falls back when the configured data path cannot be used as a directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "occt-data-dir-blocked-"));
  const configured = path.join(root, "blocked");
  const fallbackRoot = path.join(root, "fallback");
  fs.writeFileSync(configured, "not a directory", "utf8");
  let fallbackNotice = null;
  try {
    assert.throws(() => resolveWritableDataDir(configured, {fallbackRoot}), /Temporary fallback is disabled/);
    assert.equal(fs.existsSync(fallbackRoot), false);
    const resolved = resolveWritableDataDir(configured, { allowTemporaryFallback: true, fallbackRoot, onFallback: (notice) => { fallbackNotice = notice; } });
    assert.equal(resolved, path.join(fallbackRoot, "occt-web-cad-demo-data"));
    assert.deepEqual(fallbackNotice, { configured: path.resolve(configured), fallback: resolved });
    assert.ok(fs.existsSync(resolved));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
