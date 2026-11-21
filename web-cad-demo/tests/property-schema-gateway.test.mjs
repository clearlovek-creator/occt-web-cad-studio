import { ObservedCommandClient } from "./helpers/observed-command-client.mjs";
const observedClient = new ObservedCommandClient();
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8847;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cad-property-gateway-"));
let gateway;
async function request(body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(observedClient.prepare(body, "", '/commands')) });
  return { response, payload: observedClient.observe(await response.json(), body.documentId) };
}

test("gateway persists property type instances through command API", async (t) => {
  t.after(async () => { if(gateway){const stopped=new Promise(resolve=>gateway.once('exit',resolve));gateway.kill();await stopped;}const resolved=path.resolve(dataDir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true}); });
  gateway = spawn(process.execPath, [path.join(root, "gateway", "server.mjs")], { cwd: root, env: { ...process.env, GEOMETRY_PORT: String(port), GEOMETRY_DATA_DIR: dataDir }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("gateway startup timed out")), 10000); gateway.stdout.setEncoding("utf8"); gateway.stderr.setEncoding("utf8"); const ready = (chunk) => { if (chunk.includes("Geometry gateway ready")) { clearTimeout(timer); resolve(); } }; gateway.stdout.on("data", ready); gateway.stderr.on("data", ready); gateway.once("error", reject); });
  const created = await request({ documentId: "property_api", operation: "property.type.create", parameters: { key: "WavePort", name: "Wave Port", targetScope: "face", association: "required", fields: [{ key: "frequency", label: "Frequency", type: "double", required: true }] } });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  const typeId = created.payload.type.typeId;
  const box = await request({documentId:"property_api",operation:"primitive.box",parameters:{width:20,depth:20,height:20}});
  const target = {kind:"face",bodyId:box.payload.bodyId,topologyId:box.payload.triangleFaceIds[0]};
  const first = await request({ documentId: "property_api", operation: "property.instance.create", parameters: { typeId, name: "Port1", value: { frequency: 10 }, target } });
  const second = await request({ documentId: "property_api", operation: "property.instance.create", parameters: { typeId, name: "Port2", value: { frequency: 20 }, target } });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.propertySchema.instances.length, 2);
  const listed = await request({ documentId: "property_api", operation: "property.instance.list" });
  assert.equal(listed.payload.instances.length, 2);
  assert.ok(listed.payload.instances.every(instance=>instance.state==="active"));
  const rejected=await request({documentId:"property_api",operation:"property.instance.create",parameters:{typeId,name:"Invalid",value:{frequency:10},target:{...target,topologyId:"face-1-99999"}}});
  assert.equal(rejected.payload.code,"PROPERTY_TARGET_INVALID");
  assert.equal((await request({documentId:"property_api",operation:"property.instance.list"})).payload.instances.length,2);
});
