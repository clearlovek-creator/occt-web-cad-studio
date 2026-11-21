import test from "node:test";
import assert from "node:assert/strict";
import { buildMeshCommand, handleMeshRoute, meshOperationFor } from "../gateway/mesh-routes.mjs";

test("mesh routes map HTTP requests to worker operations", () => {
  assert.equal(meshOperationFor("POST", "/api/mesh/preflight"), "mesh.preflight");
  assert.equal(meshOperationFor("POST", "/api/mesh/create"), "mesh.create");
  assert.equal(meshOperationFor("POST", "/api/mesh/repair"), "mesh.repair");
  assert.equal(meshOperationFor("POST", "/api/mesh/intersections"), "mesh.intersections");
  assert.equal(meshOperationFor("POST", "/api/mesh/quality"), "mesh.quality");
  assert.equal(meshOperationFor("GET", "/api/mesh/create"), "");
});

test("mesh create command validates paths and defaults to 3D", () => {
  assert.deepEqual(buildMeshCommand("mesh.create", { inputPath: "part.brep", outputPath: "part.msh" }, "r1"), {
    protocolVersion: 1,
    requestId: "r1",
    operation: "mesh.create",
    parameters: { inputPath: "part.brep", outputPath: "part.msh", dimension: 3 },
  });
  assert.throws(() => buildMeshCommand("mesh.create", { inputPath: "part.brep" }), /outputPath is required/);
  assert.deepEqual(buildMeshCommand("mesh.quality", { inputPath: "part.msh", qualityName: "gamma", qualityThreshold: 0.15 }, "q1"), {
    protocolVersion: 1, requestId: "q1", operation: "mesh.quality", parameters: { inputPath: "part.msh", qualityName: "gamma", qualityThreshold: 0.15 },
  });
});

test("mesh create forwards body ownership spatial hints to the worker", () => {
  const command = buildMeshCommand("mesh.create", {
    inputPath: "assembly.step",
    outputPath: "assembly.msh",
    bodyIds: ["body-1", "body-2"],
    bodyGeometry: [
      { bodyId: "body-1", volume: 1000, centroid: [5, 5, 5] },
      { bodyId: "body-2", volume: 576, centroid: [33, 4, 6] },
    ],
    bodyManifest: { format: "brep", revision: 3, bodies: [] },
  }, "ownership-1");
  assert.deepEqual(command.parameters.bodyIds, ["body-1", "body-2"]);
  assert.deepEqual(command.parameters.bodyGeometry[1], { bodyId: "body-2", volume: 576, centroid: [33, 4, 6] });
  assert.deepEqual(command.parameters.bodyManifest, { format: "brep", revision: 3, bodies: [] });
});
test("mesh route converts worker failures to a recoverable HTTP response", async () => {
  const result = await handleMeshRoute({
    method: "POST",
    pathname: "/api/mesh/preflight",
    input: { inputPath: "part.brep" },
    requestId: "r2",
    client: { request: async () => { throw Object.assign(new Error("not ready"), { code: "MESH_WORKER_UNAVAILABLE" }); } },
  });
  assert.equal(result.status, 503);
  assert.equal(result.payload.code, "MESH_WORKER_UNAVAILABLE");
  assert.equal(result.payload.recoverable, true);
});
