import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildMeshCommand } from "../gateway/mesh-routes.mjs";

test("mesh gateway confines generated output to its managed directory", () => {
  const root = path.resolve("C:/temp/mesh-output");
  const command = buildMeshCommand("mesh.create", {
    inputPath: "part.geo",
    outputPath: "..\\outside.msh",
  }, "r1", { outputDirectory: root });
  assert.equal(command.parameters.outputPath, path.join(root, "outside.msh"));
});
