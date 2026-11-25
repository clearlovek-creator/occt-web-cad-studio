import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("property instances stay under their type alongside mesh and simulation management", async () => {
  const tree = await readFile(new URL("../app/workbench/ProjectTree.tsx", import.meta.url), "utf8");

  assert.match(tree, /types\.map\(\(type\) => \{/);
  assert.match(tree, /const records = instances\.filter\(\(instance\) => instance\.typeId === type\.typeId\)/);
  assert.match(tree, /<Branch key=\{type\.typeId\} label=\{type\.name\}/);
  assert.match(tree, /records\.map\(\(instance\) =>/);
  assert.match(tree, /onClick=\{onOpenMesh\}[\s\S]*?<strong>网格管理<\/strong>/);
  assert.doesNotMatch(tree, /<Branch label="网格|网格管理操作|网格任务与结果/);
  assert.match(tree, /<Branch label="仿真管理"/);
  assert.doesNotMatch(tree, /求解设置|激励源|边界条件|频率扫描/);
});
