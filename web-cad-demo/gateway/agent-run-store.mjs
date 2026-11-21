import fs from "node:fs";
import path from "node:path";

const ID = /^[A-Za-z0-9._:-]{1,160}$/;

function safeId(value) {
  const id = String(value || "");
  if (!ID.test(id)) throw new Error("runId is invalid.");
  return id;
}

function now() { return new Date().toISOString(); }

/** Small durable run ledger used by the UI to recover after SSE disconnects. */
export class AgentRunStore {
  constructor(dataDir, { limit = 500 } = {}) {
    this.root = path.join(dataDir, "agent-runs");
    this.limit = limit;
    this.runs = new Map();
    this.ownedRuns=new Set();
    fs.mkdirSync(this.root, { recursive: true });
    this.load();
  }
  filePath(runId) { return path.join(this.root, `${safeId(runId)}.json`); }
  load() {
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try { const run = JSON.parse(fs.readFileSync(path.join(this.root, entry.name), "utf8")); if (run?.runId) this.runs.set(run.runId, run); } catch { /* ignore a damaged ledger entry */ }
    }
  }
  write(run) {
    const target = this.filePath(run.runId);
    const temp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(run, null, 2), "utf8");
    try { fs.rmSync(target, { force: true }); fs.renameSync(temp, target); }
    catch (error) { try { fs.copyFileSync(temp, target); fs.rmSync(temp, { force: true }); } catch { try { fs.rmSync(temp, { force: true }); } catch {} throw error; } }
    this.runs.set(run.runId, run);
    return run;
  }
  begin(input = {}) {
    if(this.stopping)throw Object.assign(new Error('后台正在停止，未开始新的 Agent 任务。'),{code:'SERVICE_STOPPING'});
    const runId = safeId(input.runId || `agent-run-${Date.now()}-${process.pid}`);
    const run=this.write({ runId, documentId: String(input.documentId || "default"), conversationId: input.conversationId || null, providerId: input.providerId || null, model: input.model || null, mode: input.mode || "edit", status: "running", startedAt: now(), updatedAt: now(), turns: 0, toolCount: 0, events: [] });this.ownedRuns.add(runId);return run;
  }
  update(runId, patch = {}) {
    const current = this.runs.get(safeId(runId));
    if (!current) return null;
    if(this.stopping)return current;
    const events = Array.isArray(patch.events) ? [...current.events, ...patch.events].slice(-200) : current.events;
    return this.write({ ...current, ...patch, events, updatedAt: now() });
  }
  appendEvent(runId, event) { return this.update(runId, { events: [event] }); }
  get(runId) {const run=this.runs.get(safeId(runId));return run?.status==='running'&&!this.ownedRuns.has(run.runId)?{...run,status:'interrupted',recovered:true,errorCode:'AGENT_RESTART_INTERRUPTED',error:'该任务属于上一次后台进程，没有恢复执行或自动重放。'}:run||null;}
  list(documentId) { return [...this.runs.keys()].map(id=>this.get(id)).filter((run) => !documentId || run.documentId === String(documentId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100); }
  stop(){this.stopping=true;let errors=0;for(const run of this.runs.values())if(this.ownedRuns.has(run.runId)&&run.status==='running'){const interrupted={...run,status:'interrupted',errorCode:'SERVICE_STOPPING',error:'后台停止，任务已中断；没有自动重放建模命令。',updatedAt:now()};this.runs.set(run.runId,interrupted);try{this.write(interrupted);}catch{errors++;}}return errors;}
}
