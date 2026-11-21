import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("property instances are grouped under their type without a simulation placeholder", async () => {
  const tree = await readFile(new URL("../app/workbench/ProjectTree.tsx", import.meta.url), "utf8");

  assert.match(tree, /types\.map\(\(type\) => \{/);
  assert.match(tree, /const records = instances\.filter\(\(instance\) => instance\.typeId === type\.typeId\)/);
  assert.match(tree, /<Branch key=\{type\.typeId\} label=\{type\.name\}/);
  assert.match(tree, /records\.map\(\(instance\) =>/);
  assert.doesNotMatch(tree, /仿真管理|求解设置|激励源|边界条件|频率扫描/);
});
