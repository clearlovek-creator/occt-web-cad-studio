import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("property type management is a separate window with editable custom fields", async () => {
  const [demo, panel, registry] = await Promise.all([
    readFile(new URL("../app/CadDemo.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/PropertySchemaPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/commands/command-registry.ts", import.meta.url), "utf8"),
  ]);
  assert.match(demo, /activeOperation === "propertyTypes"/);
  assert.match(demo, /<PropertyTypeManagerPanel.*initialTypeId=\{propertyTypeId\}/);
  assert.match(demo, /setPropertyTypeId\(undefined\); setActiveOperation\("propertyTypes"\)/);
  assert.match(panel, /schema-field-editor/);
  assert.match(panel, /添加属性/);
  assert.match(panel, /property\.type\.update/);
  assert.match(registry, /project\.propertyTypes/);
});
