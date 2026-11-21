import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {IdempotencyOutcomeStore} from './idempotency-outcome-store.mjs';
import {CheckpointReader} from './checkpoint-reader.mjs';

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SNAPSHOT_FILE = /^state-[0-9]+-[0-9]+-[0-9]+\.xbf$/;
export function historyRecoveryWarning(history){const operation=history.events?.at(-1)?.operation;return operation==="history.recover-checkpoint"?"工程已恢复到较早的完整检查点，请核对最近的几何与属性修改；原始证据已保留。":operation==="history.recover-transaction"?"检测到未完成的工程事务，已整体回滚，未自动重放操作；请核对后继续。":operation==="history.recover-live"?"异常检查点已从经核验的活内核状态重建；原始证据已保留。":null;}

function emptyHistory() {
  return { current: null, undo: [], redo: [], restoreError: null, events: [], idempotency: [], projectData:{}, stateSequence:0 };
}
function atomicJson(file,value,maxBytes=null){const text=JSON.stringify(value,null,2);if(maxBytes!==null&&Buffer.byteLength(text)>maxBytes)throw new Error("属性检查点超过 32 MiB 限制，未发布不可恢复的工程状态。");const temporary=file+`.${process.pid}.${Date.now()}.tmp`;let fd;try{fd=fs.openSync(temporary,"wx");fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}}

export class PersistentHistoryStore {
  constructor(dataDir, { limit = 50, eventLimit = 100, idempotencyLimit = 100, idempotencyBytes=256*1024*1024, projectData=null, onWarning = (message) => console.warn(message) } = {}) {
    this.rootDir = path.join(dataDir, "history");
    this.outcomes=new IdempotencyOutcomeStore(this.rootDir);
    this.limit = limit;
    this.eventLimit = eventLimit;
    this.idempotencyLimit = idempotencyLimit;
    this.idempotencyBytes=idempotencyBytes;
    this.onWarning = onWarning;
    this.projectDataAdapter=projectData;
    this.deferredCleanup=new Set();
    this.sequence = 1;
    this.histories = new Map();
    this.checksums = new Map();
    this.checkpointReader=new CheckpointReader();
    this.integrityPasses={repair:0,commit:0};
    this.load();
  }

  get(documentId) {
    if (!this.histories.has(documentId)) this.histories.set(documentId, emptyHistory());
    const history = this.histories.get(documentId);
    return {
      current: history.current,
      undo: [...history.undo],
      redo: [...history.redo],
      restoreError: history.restoreError,
      events: [...(history.events || [])],
      idempotency: [...(history.idempotency || [])],
      projectData: structuredClone(history.projectData||{}),
      stateSequence: history.stateSequence || 0,
    };
  }

  entries() {
    return [...this.histories.entries()].map(([documentId]) => [documentId, this.get(documentId)]);
  }
  documentIds() { return [...this.histories.keys()]; }
  hasDocument(id) { return this.histories.has(id); }

  sourceCheckpoints(id){
    const history=this.get(id),checksums=this.checksums.get(id)||{};
    const entry=(file,scope)=>({file,scope,name:path.basename(file),sha256:checksums[path.basename(file)]});
    return {restoreError:history.restoreError,checkpoints:[...(history.current?[entry(history.current,'current')]:[]),...history.undo.map(file=>entry(file,'undo')),...history.redo.map(file=>entry(file,'redo'))]};
  }

  repair(documentId) {
    this.integrityPasses.repair++;
    const history = this.get(documentId);
    if(history.restoreError)return history;
    const currentIsValid = Boolean(history.current && this.isValidSnapshot(documentId, history.current));
    if(history.current && !currentIsValid){this.markRestoreError(documentId,"当前恢复快照无效，已保留原文件，请从有效备份恢复工程。");return this.get(documentId);}
    const nextHistory = currentIsValid
      ? {
          ...history,
          undo: history.undo.filter((item) => this.isValidSnapshot(documentId, item)),
          redo: history.redo.filter((item) => this.isValidSnapshot(documentId, item)),
        }
      : emptyHistory();
    const changed = nextHistory.current !== history.current
      || nextHistory.undo.length !== history.undo.length
      || nextHistory.redo.length !== history.redo.length;
    if (!changed) return history;
    this.onWarning(`[history] Repaired invalid snapshot references for ${documentId}.`);
    return this.commit(documentId, nextHistory);
  }

  snapshotPath(documentId) {
    const directory = this.documentDirectory(documentId);
    fs.mkdirSync(directory, { recursive: true });
    return path.join(directory, `state-${Date.now()}-${process.pid}-${this.sequence++}.xbf`);
  }

  discard(filePath) {
    if (!filePath || !this.isInsideRoot(filePath)) return;
    fs.rmSync(filePath, { force: true });
    fs.rmSync(filePath+".properties.json",{force:true});
  }

  prepareCommit(documentId,nextHistory){
    const previous=this.get(documentId);
    const history = this.normalize(documentId, {...nextHistory,projectData:nextHistory.projectData??this.get(documentId).projectData}, true);
    const changed=previous.events.at(-1)?.eventId!==history.events.at(-1)?.eventId;
    history.stateSequence=Math.max(previous.stateSequence,history.stateSequence)+(changed?1:0);
    if(!Number.isSafeInteger(history.stateSequence))throw new Error("Project state sequence exceeds its safe range.");
    return history;
  }

  commit(documentId, nextHistory, { cleanup = true } = {}) {
    this.integrityPasses.commit++;
    const history=this.prepareCommit(documentId,nextHistory);
    const directory = this.documentDirectory(documentId);
    fs.mkdirSync(directory, { recursive: true });
    const manifestPath = path.join(directory, "manifest.json");
    const previousChecksums = this.checksums.get(documentId) || {};
    const checksums = {};
    for (const filePath of [history.current, ...history.undo, ...history.redo].filter(Boolean)) {
      const fileName = path.basename(filePath);
      const actual=this.checkpointReader.snapshot(filePath);
      if(previousChecksums[fileName]&&previousChecksums[fileName]!==actual)throw new Error(`History snapshot checksum changed: ${fileName}`);
      checksums[fileName]=actual;
      if(history.projectData[fileName])this.readProjectDataFile(documentId,filePath,history.projectData[fileName],actual);
    }
    if(this.projectDataAdapter&&history.current&&!history.projectData[path.basename(history.current)]){
      const schema=this.projectDataAdapter.validate(this.projectDataAdapter.capture(documentId));
      const file=history.current+".properties.json";atomicJson(file,{version:1,geometrySha256:checksums[path.basename(history.current)],schema},32*1024*1024);
      const bytes=fs.readFileSync(file);history.projectData[path.basename(history.current)]={sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};
    }
    const retained=[];let outcomeBytes=0;
    for(const entry of [...history.idempotency].reverse()){
      const stored=this.outcomes.storeEntry(documentId,entry),size=stored.responseRef.bytes;
      if(outcomeBytes+size>this.idempotencyBytes){if(!retained.length)throw new Error('最新命令结果超过幂等保留总量限制，未提交修改。');break;}
      retained.push(stored);outcomeBytes+=size;
    }
    history.idempotency=retained.reverse();
    const manifest = {
      version: 2,
      documentId,
      current: history.current ? path.basename(history.current) : null,
      undo: history.undo.map((item) => path.basename(item)),
      redo: history.redo.map((item) => path.basename(item)),
      checksums,
      events: history.events || [],
      idempotency: history.idempotency || [],
      projectData: history.projectData,
      stateSequence: history.stateSequence,
      updatedAt: new Date().toISOString(),
    };
    atomicJson(manifestPath,manifest);
    this.histories.set(documentId, history);
    this.checksums.set(documentId, checksums);
    if (cleanup&&!this.deferredCleanup.has(documentId)) this.cleanup(directory, history);
    return this.get(documentId);
  }

  recordIdempotency(documentId, entry) {
    const history = this.get(documentId);
    const idempotency = [...(history.idempotency || []).filter((item) => item.key !== entry.key), entry]
      .slice(-this.idempotencyLimit);
    return this.commit(documentId, { ...history, idempotency });
  }

  readIdempotency(documentId,entry){return this.outcomes.read(documentId,entry);}

  markRestoreError(documentId, message) {
    const history = this.get(documentId);
    this.histories.set(documentId, { ...history, restoreError: message });
  }

  load() {
    if (!fs.existsSync(this.rootDir)) return;
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !DOCUMENT_ID.test(entry.name)) continue;
      const manifestPath = path.join(this.rootDir, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const history = this.decodeManifest(entry.name,manifest);
        if (history.current && !fs.existsSync(history.current))
          throw new Error("current snapshot is missing");
        history.undo = history.undo.filter((item) => fs.existsSync(item));
        history.redo = history.redo.filter((item) => fs.existsSync(item));
        const checksums = {};
        if (manifest.checksums && typeof manifest.checksums === "object") {
          for (const [fileName, checksum] of Object.entries(manifest.checksums)) {
            if (SNAPSHOT_FILE.test(fileName) && /^[0-9a-f]{64}$/.test(checksum))
              checksums[fileName] = checksum;
          }
        }
        this.histories.set(entry.name, history);
        this.checksums.set(entry.name, checksums);
      } catch (error) {
        this.onWarning(`[history] Ignoring ${entry.name}: ${error.message}`);
        this.histories.set(entry.name,{...emptyHistory(),restoreError:`持久化工程清单无效：${error.message}`});
      }
    }
  }

  isValidSnapshot(documentId, filePath) {
    try {
      const resolved = path.resolve(filePath);
      if (path.dirname(resolved) !== this.documentDirectory(documentId)) return false;
      const expected = this.checksums.get(documentId)?.[path.basename(resolved)];
      const actual=this.checkpointReader.snapshot(resolved);
      if(expected&&actual!==expected)return false;
      const binding=this.get(documentId).projectData[path.basename(resolved)];
      if(binding)this.readProjectDataFile(documentId,resolved,binding,actual);
      return true;
    } catch {
      return false;
    }
  }

  decodeManifest(documentId,manifest,requireFiles=false){
    if(![1,2].includes(manifest?.version)||manifest.documentId!==documentId)throw new Error("unsupported manifest version or document id");
    const resolve=file=>{if(file===null)return null;if(typeof file!=="string"||!SNAPSHOT_FILE.test(file))throw new Error("invalid snapshot filename");return path.join(this.documentDirectory(documentId),file);};
    return this.normalize(documentId,{current:resolve(manifest.current),undo:Array.isArray(manifest.undo)?manifest.undo.map(resolve):[],redo:Array.isArray(manifest.redo)?manifest.redo.map(resolve):[],restoreError:null,events:Array.isArray(manifest.events)?manifest.events:[],idempotency:Array.isArray(manifest.idempotency)?manifest.idempotency:[],projectData:manifest.projectData??{},stateSequence:manifest.stateSequence??0},requireFiles);
  }

  normalize(documentId, value, requireFiles) {
    if (!DOCUMENT_ID.test(documentId)) throw new Error("Invalid history document id.");
    if(value.stateSequence!==undefined && (!Number.isSafeInteger(value.stateSequence)||value.stateSequence<0))throw new Error("Invalid project state sequence.");
    const directory = this.documentDirectory(documentId);
    const validatePath = (filePath) => {
      if (filePath === null) return null;
      const resolved = path.resolve(filePath);
      if (path.dirname(resolved) !== directory || !SNAPSHOT_FILE.test(path.basename(resolved)))
        throw new Error("History snapshot path is outside its document directory.");
      if (requireFiles && !fs.existsSync(resolved))
        throw new Error(`History snapshot does not exist: ${path.basename(resolved)}`);
      return resolved;
    };
    const current=validatePath(value.current??null),undo=(value.undo||[]).map(validatePath).slice(-this.limit),redo=(value.redo||[]).map(validatePath).slice(-this.limit);
    const references=new Set([current,...undo,...redo].filter(Boolean).map(file=>path.basename(file))),projectData={};
    if(value.projectData!==undefined&&(!value.projectData||typeof value.projectData!=="object"||Array.isArray(value.projectData)))throw new Error("Invalid project data checkpoint references.");
    for(const [file,binding] of Object.entries(value.projectData||{})){
      if(!SNAPSHOT_FILE.test(file)||!binding||!/^[a-f0-9]{64}$/.test(binding.sha256)||!Number.isSafeInteger(binding.bytes)||binding.bytes<2||binding.bytes>32*1024*1024)throw new Error("Invalid project data checkpoint metadata.");
      if(references.has(file))projectData[file]={sha256:binding.sha256,bytes:binding.bytes};
    }
    return {
      current,undo,redo,projectData,stateSequence:value.stateSequence??0,
      restoreError: value.restoreError || null,
      events: Array.isArray(value.events) ? value.events.slice(-this.eventLimit) : [],
      idempotency: Array.isArray(value.idempotency) ? value.idempotency.slice(-this.idempotencyLimit) : [],
    };
  }

  cleanup(directory, history) {
    if(this.deferredCleanup.has(path.basename(directory)))return;
    const referenced = new Set(
      [history.current, ...history.undo, ...history.redo]
        .filter(Boolean)
        .map((item) => path.resolve(item)),
    );
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.xbf(?:\.properties\.json)?$/.test(entry.name)) continue;
      const candidate = path.resolve(directory, entry.name);
      const geometry=candidate.endsWith(".properties.json")?candidate.slice(0,-".properties.json".length):candidate;
      if (!referenced.has(geometry)) {
        try { fs.rmSync(candidate, { force: true }); }
        catch (error) { this.onWarning(`[history] Could not remove ${entry.name}: ${error.message}`); }
      }
    }
    try{this.outcomes.cleanup(path.basename(directory),history.idempotency||[]);}
    catch(error){this.onWarning('[history] Outcome cleanup deferred: '+error.message);}
  }

  documentDirectory(documentId) {
    if(!DOCUMENT_ID.test(documentId))throw new Error("Invalid history document id.");
    return path.resolve(this.rootDir, documentId);
  }

  readProjectDataFile(documentId,file,binding,geometrySha256=null) {
    if(path.dirname(path.resolve(file))!==this.documentDirectory(documentId)||!SNAPSHOT_FILE.test(path.basename(file)))throw new Error("Invalid project data checkpoint path.");
    const target=file+".properties.json",stat=fs.lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==binding.bytes||stat.size>32*1024*1024)throw new Error("属性检查点文件长度或类型不合法。");
    const bytes=fs.readFileSync(target);if(createHash("sha256").update(bytes).digest("hex")!==binding.sha256)throw new Error("属性检查点校验失败。");
    const value=JSON.parse(bytes),geometry=geometrySha256||this.checkpointReader.snapshot(file);
    if(value.version!==1||value.geometrySha256!==geometry)throw new Error("属性检查点与几何不匹配。");
    return this.projectDataAdapter?this.projectDataAdapter.validate(value.schema):value.schema;
  }

  readProjectData(documentId,file) {
    const binding=this.get(documentId).projectData[path.basename(file)];
    return binding?this.readProjectDataFile(documentId,file,binding):null;
  }

  isValidProjectData(documentId,file){try{const key=path.basename(file),binding=this.get(documentId).projectData[key];if(binding)this.readProjectDataFile(documentId,file,binding,this.checksums.get(documentId)?.[key]);return true;}catch{return false;}}

  deferCleanup(documentId,enabled){if(enabled)this.deferredCleanup.add(documentId);else this.deferredCleanup.delete(documentId);}

  integrityMetrics(){return {...this.checkpointReader.metrics(),passes:{...this.integrityPasses}};}

  isInsideRoot(filePath) {
    const relative = path.relative(this.rootDir, path.resolve(filePath));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }
}
