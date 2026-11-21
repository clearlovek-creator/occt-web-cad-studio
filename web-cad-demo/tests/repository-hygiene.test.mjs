import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("runtime projects, provider settings and environment secrets are excluded from Git while the example remains trackable", () => {
  const files=[".env",".env.local",".env.production",".data/agent-providers.enc",".data/pi-sessions/private.jsonl",".data/property-schemas/default.json","runtime-logs/services/services.json",".artifacts/workbench/test.png",".env.example"];
  const result=spawnSync("git",["check-ignore","--no-index","--stdin"],{cwd:fileURLToPath(new URL("../",import.meta.url)),input:files.join("\n")+"\n",encoding:"utf8",windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const ignored=new Set(result.stdout.trim().split(/\r?\n/));
  for(const file of files.slice(0,-1)) assert.ok(ignored.has(file),`Sensitive runtime path must be ignored: ${file}`);
  assert.equal(ignored.has(".env.example"),false);
});
