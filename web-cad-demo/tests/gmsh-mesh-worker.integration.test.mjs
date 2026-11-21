import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(process.cwd());
const workerPath = path.join(root, "mesh-worker", "build-gmsh", "gmsh_mesh_worker.exe");
const inputPath = path.join(root, "mesh-worker", "testdata", "box.geo");
const overlapInputPath = path.join(root, "mesh-worker", "testdata", "overlap.geo");

test("libgmsh worker generates a tetrahedral mesh when the SDK build is available", { skip: !existsSync(workerPath) }, async () => {
  const outputPath = path.join(os.tmpdir(), `gmsh-worker-${process.pid}-${Date.now()}.msh`);
  const surfaceOutputPath = path.join(os.tmpdir(), "gmsh-surface-" + process.pid + "-" + Date.now() + ".msh");
  const repairedPath = path.join(os.tmpdir(), `gmsh-worker-${process.pid}-${Date.now()}-repaired.brep`);
  const intersectionPath = path.join(os.tmpdir(), `gmsh-worker-${process.pid}-${Date.now()}-intersections.brep`);
  const overlapStepPath = path.join(os.tmpdir(), `gmsh-worker-${process.pid}-${Date.now()}-overlap.step`);
  const overlapFragmentedPath = path.join(os.tmpdir(), `gmsh-worker-${process.pid}-${Date.now()}-overlap-fragmented.step`);
  const environment = { ...process.env };
  delete environment.Path;
  delete environment.PATH;
  environment.Path = [path.dirname(workerPath), "C:\\msys64\\ucrt64\\bin"].join(path.delimiter);
  const worker = spawn(workerPath, [], {
    cwd: path.dirname(workerPath),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  worker.stderr.resume();
  let buffer = "";
  const responses = [];
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) responses.push(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  });
  const request = (payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mesh worker integration timeout")), 30_000);
    const check = () => {
      if (!responses.length) return setTimeout(check, 5);
      clearTimeout(timer);
      resolve(responses.shift());
    };
    check();
    worker.stdin.write(`${JSON.stringify(payload)}\n`);
  });
  try {
    const health = await request({ protocolVersion: 1, requestId: "integration-health", operation: "health.ping" });
    assert.equal(health.backend, "libgmsh");
    const result = await request({ protocolVersion: 1, requestId: "integration-create", operation: "mesh.create", parameters: { inputPath, outputPath, dimension: 3 } });
    assert.equal(result.ok, true);
    assert.equal(result.mesh.dimension, 3);
    assert.ok(result.mesh.nodeCount > 0);
    assert.ok(result.mesh.elementCount > 0);
    assert.equal(result.mesh.quality.tetraCount > 0, true);
    assert.equal(result.mesh.quality.invertedCount, 0);
    assert.equal(result.mesh.render.kind, "wire");
    assert.ok(result.mesh.render.wirePositions.length > 0);
    assert.equal(existsSync(outputPath), true);
    const surface = await request({ protocolVersion: 1, requestId: "integration-surface", operation: "mesh.create", parameters: { inputPath, outputPath: surfaceOutputPath, dimension: 2 } });
    assert.equal(surface.ok, true);
    assert.equal(surface.mesh.dimension, 2);
    assert.equal(surface.mesh.render.kind, "surface");
    assert.ok(surface.mesh.render.indices.length > 0);
    assert.equal(surface.mesh.quality.tetraCount,0);
    assert.equal(surface.mesh.quality.minQuality,null);
    assert.equal(surface.mesh.quality.averageQuality,null);
    const quality = await request({ protocolVersion: 1, requestId: "integration-quality", operation: "mesh.quality", parameters: { inputPath: outputPath } });
    assert.equal(quality.ok, true);
    assert.equal(quality.quality.tetraCount, result.mesh.quality.tetraCount);
    const repaired = await request({ protocolVersion: 1, requestId: "integration-repair", operation: "mesh.repair", parameters: { inputPath, outputPath: repairedPath, repairMode: "conservative" } });
    assert.equal(repaired.ok, true);
    assert.equal(existsSync(repairedPath), true);
    const intersections = await request({ protocolVersion: 1, requestId: "integration-intersections", operation: "mesh.intersections", parameters: { inputPath, outputPath: intersectionPath } });
    assert.equal(intersections.ok, true);
    assert.equal(existsSync(intersectionPath), true);
    const overlapSource = await request({ protocolVersion: 1, requestId: "integration-overlap-source", operation: "mesh.repair", parameters: { inputPath: overlapInputPath, outputPath: overlapStepPath, repairMode: "strict" } });
    assert.equal(overlapSource.ok, true);
    const fragmented = await request({ protocolVersion: 1, requestId: "integration-overlap-fragment", operation: "mesh.intersections", parameters: { inputPath: overlapStepPath, outputPath: overlapFragmentedPath } });
    assert.equal(fragmented.ok, true);
    assert.equal(fragmented.repair.intersectionResolution, true);
    assert.equal(fragmented.repair.geometry.volumeCount, 3);
  } finally {
    worker.kill();
    rmSync(outputPath, { force: true });
    rmSync(surfaceOutputPath, { force: true });
    rmSync(repairedPath, { force: true });
    rmSync(intersectionPath, { force: true });
    rmSync(overlapStepPath, { force: true });
    rmSync(overlapFragmentedPath, { force: true });
  }
});
