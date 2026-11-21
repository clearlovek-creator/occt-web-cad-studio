import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../app/model/render-cache.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { pruneBodyRenderables } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("removed Body faces and edge lines leave both the scene and the picking cache", () => {
  const objects = [
    { userData: { bodyId: "body-1", kind: "body" } },
    { userData: { bodyId: "body-1", kind: "edge" } },
    { userData: { bodyId: "body-2", kind: "body" } },
    { userData: { bodyId: "body-2", kind: "edge" } },
  ];
  const children = [...objects], disposed = [];
  const group = { remove(object) { children.splice(children.indexOf(object), 1); } };
  const kept = pruneBodyRenderables(group, objects, new Set(["body-2"]), (object) => disposed.push(object));
  assert.deepEqual(kept, objects.slice(2));
  assert.deepEqual(children, objects.slice(2));
  assert.deepEqual(disposed, objects.slice(0, 2));
  const empty = pruneBodyRenderables(group, kept, new Set(), (object) => disposed.push(object));
  assert.deepEqual(empty, []);
  assert.deepEqual(children, []);
  assert.equal(disposed.length, 4);
});
