import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {waitChildExit} from './child-exit.mjs';
import {BoundedJsonLines} from './bounded-json-lines.mjs';
import {PI_RPC_TIMEOUTS,piRpcTimeoutMs} from '../shared/pi-rpc-timeouts.mjs';
import {backendChildArgs,backendChildEnvironment} from './backend-runtime.mjs';
import {backendEnvironment} from './backend-release.mjs';
import {ownedPiResumeFile} from './pi-resume-file.mjs';
import {ensurePiSessionOwner,inspectPiSessionOwner,adoptPiSessionOwner,publicPiSessionOwner,assertFreshPiDocument,PiSessionOwnershipError} from './pi-session-ownership.mjs';

export const PI_RPC_LIMITS=Object.freeze({requestBytes:2*1024*1024,responseBytes:64*1024*1024,pendingCount:64,pendingBytes:4*1024*1024,stdinBytes:4*1024*1024,stderrBytes:64*1024,eventBytes:1024*1024,historyBytes:4*1024*1024,historyCount:1000,stopMs:5000});
export const PI_DOCUMENT_ACTIVITY_LIMITS=Object.freeze({sessions:32,documents:64,timeoutMs:5000});
const observations=new Set(['get_state','get_available_models','get_available_thinking_levels','get_session_stats','get_fork_messages','get_entries','get_tree','get_last_assistant_text','get_messages','get_commands']);
const controls=new Set(['abort','abort_retry','get_state']);
const isRecord=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const validBase64=value=>{if(value.length%4||/[^A-Za-z0-9+/=]/.test(value))return false;const padding=value.indexOf('=');return padding<0||padding>=value.length-2&&/^={1,2}$/.test(value.slice(padding));};
async function waitOutputClosed(promise,timeoutMs){let timer;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new PiSessionError('PI_STDIO_CLOSE_UNCONFIRMED','Pi 输出管道尚未核验关闭，未启动替代进程。')),timeoutMs);})]);}finally{clearTimeout(timer);}}

const RPC_COMMANDS = new Set([
  "prompt", "steer", "follow_up", "abort", "new_session", "get_state", "set_model", "cycle_model",
  "get_available_models", "set_thinking_level", "cycle_thinking_level", "get_available_thinking_levels",
  "set_steering_mode", "set_follow_up_mode", "compact", "set_auto_compaction", "set_auto_retry", "abort_retry",
  "get_session_stats", "switch_session", "fork", "clone", "get_fork_messages", "get_entries", "get_tree",
  "get_last_assistant_text", "set_session_name", "get_messages", "get_commands",
]);

const RPC_FIELDS = {
  prompt: ["type", "message", "images", "streamingBehavior"], steer: ["type", "message", "images"], follow_up: ["type", "message", "images"],
  abort: ["type"], new_session: ["type"], get_state: ["type"], set_model: ["type", "provider", "modelId"], cycle_model: ["type"],
  get_available_models: ["type"], set_thinking_level: ["type", "level"], cycle_thinking_level: ["type"], get_available_thinking_levels: ["type"],
  set_steering_mode: ["type", "mode"], set_follow_up_mode: ["type", "mode"], compact: ["type", "customInstructions"],
  set_auto_compaction: ["type", "enabled"], set_auto_retry: ["type", "enabled"], abort_retry: ["type"], get_session_stats: ["type"],
  switch_session: ["type", "sessionPath"], fork: ["type", "entryId"], clone: ["type"], get_fork_messages: ["type"],
  get_entries: ["type", "since"], get_tree: ["type"], get_last_assistant_text: ["type"], set_session_name: ["type", "name"],
  get_messages: ["type"], get_commands: ["type"],
};

export function validatePiCommand(input, { sessionRoot } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !RPC_COMMANDS.has(input.type)) {
    throw new Error(`Unsupported Pi RPC command: ${String(input?.type || "")}`);
  }
  const allowedFields = RPC_FIELDS[input.type];
  const unexpected = Object.keys(input).find((key) => !allowedFields.includes(key));
  if (unexpected) throw new Error(`Unexpected field for Pi RPC ${input.type}: ${unexpected}`);
  const command = { ...input };
  if (["prompt", "steer", "follow_up"].includes(command.type) && (typeof command.message !== "string" || command.message.length > 16_000)) throw new Error("Pi prompt is required and must be at most 16000 characters.");
  if(command.images!==undefined&&(!Array.isArray(command.images)||command.images.length>8||command.images.some(image=>!isRecord(image)||Object.keys(image).some(key=>!['type','data','mimeType'].includes(key))||image.type!=='image'||!['image/png','image/jpeg','image/gif','image/webp'].includes(image.mimeType)||typeof image.data!=='string'||image.data.length===0||image.data.length>PI_RPC_LIMITS.requestBytes||!validBase64(image.data))))throw new PiSessionError('PI_INVALID_IMAGES','Pi 图片须为有界的 PNG/JPEG/GIF/WebP base64 内容，不能携带任意字段。');
  if (command.type === "prompt" && command.streamingBehavior !== undefined && !["steer", "followUp"].includes(command.streamingBehavior)) throw new Error("Unsupported streaming behavior.");
  if (command.type === "set_model" && (![command.provider, command.modelId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200))) throw new Error("Both provider and modelId are required.");
  if (command.type === "set_thinking_level" && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(command.level)) throw new Error("Unsupported thinking level.");
  if (["set_steering_mode", "set_follow_up_mode"].includes(command.type) && !["all", "one-at-a-time"].includes(command.mode)) throw new Error("Unsupported queue mode.");
  if (["set_auto_compaction", "set_auto_retry"].includes(command.type) && typeof command.enabled !== "boolean") throw new Error("enabled must be a boolean.");
  if (command.type === "compact" && command.customInstructions !== undefined && (typeof command.customInstructions !== "string" || command.customInstructions.length > 4000)) throw new Error("Compaction instructions must be at most 4000 characters.");
  if (command.type === "set_session_name" && (typeof command.name !== "string" || command.name.length > 200)) throw new Error("Session name must be at most 200 characters.");
  if (command.type === "fork" && (typeof command.entryId !== "string" || command.entryId.length > 200)) throw new Error("fork requires a valid entry identifier.");
  if (command.type === "get_entries" && command.since !== undefined && (typeof command.since !== "string"||command.since.length>200)) throw new Error("since must be a string entry identifier of at most 200 characters.");
  if (command.type === "switch_session") {
    if (typeof sessionRoot !== "string" || typeof command.sessionPath !== "string"||command.sessionPath.length>4096) throw new Error("Session switching is restricted to the active Pi session directory.");
    const root = path.resolve(sessionRoot);
    const target = path.resolve(command.sessionPath);
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Pi session path must be inside the active session directory.");
  }
  return command;
}

export function normalizePiSessionId(value) {
  return String(value || `pi-${crypto.randomUUID()}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}
export class PiSessionError extends Error {constructor(code,message,{outcome='not-started'}={}){super(message);this.name='PiSessionError';this.code=code;this.outcome=outcome;this.retryableByModel=false;}}

export async function hasSavedPiSession(sessionRoot) {
  try { return (await readdir(sessionRoot)).some((entry) => entry.toLowerCase().endsWith(".jsonl")); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export class PiRpcSession extends EventEmitter {
  constructor({ sessionId, documentId, cliPath, cliArgs = [], extensionPath, cwd, sessionRoot, agentConfigDir, env = process.env, spawnImpl = spawn,limits={},commandGuard }) {
    super();
    this.sessionId = sessionId || `pi-${crypto.randomUUID()}`;
    this.documentId = documentId || "default";
    Object.defineProperty(this,'documentId',{writable:false,configurable:false});
    Object.defineProperty(this,'sessionId',{writable:false,configurable:false});
    this.mode = "edit";
    this.cliPath = cliPath;
    this.cliArgs = cliArgs;
    this.extensionPath = extensionPath;
    this.cwd = cwd;
    this.sessionRoot = sessionRoot;
    this.agentConfigDir = agentConfigDir;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.limits={...PI_RPC_LIMITS,...limits};
    for(const [key,value] of Object.entries(this.limits))if(!Object.hasOwn(PI_RPC_LIMITS,key)||!Number.isSafeInteger(value)||value<1)throw new PiSessionError('PI_INVALID_LIMIT','Pi 传输预算必须为正整数。');
    this.child = null;
    this.pending = new Map();
    this.pendingBytes=0;
    this.sequence = 0;
    this.streamId = crypto.randomUUID();
    this.eventHistory = [];
    this.eventHistoryBytes = 0;
    this.frames=new BoundedJsonLines(this.limits.responseBytes);
    this.stderrBytes=0;
    this.starting = null;
    this.closed = false;
    this.disposed = false;
    this.commandGuard=commandGuard;
    this.commandSequence=0;
  }

  assertReusable() {
    if(this.disposed)throw new PiSessionError('PI_SESSION_DISPOSED','Pi 会话已永久关闭，不能由迟到的重连请求重新启动。');
  }

  async start({ resume = false } = {}) {
    this.assertReusable();
    if (this.starting) return this.starting;
    if(this.stoppingChild){await this.#waitRetired();this.assertReusable();if(this.starting)return this.starting;}
    if (this.child && !this.closed) return this;
    if (!this.cliPath) throw new Error("Pi CLI is not configured. Set PI_CLI_PATH to the pi --mode rpc entry point.");
    if (!this.extensionPath || !this.cwd || !this.sessionRoot || !this.agentConfigDir) throw new Error("Pi runtime paths are incomplete.");
    this.starting = (async () => {
      try{this.owner=ensurePiSessionOwner(this.sessionRoot,this.sessionId,this.documentId);}catch(error){if(error instanceof PiSessionOwnershipError)throw new PiSessionError(error.code,error.message);throw error;}
      await mkdir(this.sessionRoot, { recursive: true });
      await mkdir(this.agentConfigDir, { recursive: true });
      this.assertReusable();
      this.frames.clear();this.stderrBytes=0;
      this.streamId = crypto.randomUUID();this.sequence=0;this.eventHistory=[];this.eventHistoryBytes=0;
      const args = [...backendChildArgs(this.env),this.cliPath, ...this.cliArgs, "--mode", "rpc", "--session-dir", this.sessionRoot, "--extension", this.extensionPath, "--no-builtin-tools"];
      if(resume){let file;try{file=await ownedPiResumeFile(this.sessionRoot);}catch(error){throw new PiSessionError('PI_SESSION_HISTORY_UNAVAILABLE',error instanceof Error?error.message:'原生 Pi 历史尚未核对，未启动空会话。');}if(file)args.push('--session',file);}
      this.assertReusable();
      const sdkRoot=this.env.CAD_PI_SDK_ROOT;
      const runtimeEnvironment=sdkRoot?Object.fromEntries(Object.entries(backendEnvironment(this.env)).filter(([key])=>!/^(?:JITI_|TSX_|ESBUILD_)/i.test(key))):this.env;
      const child = this.spawnImpl(process.execPath, args, {
        cwd: this.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...runtimeEnvironment,...backendChildEnvironment(this.env,sdkRoot?'pi-bundled':'pi-external'),...(sdkRoot?{CAD_PI_SDK_ROOT:sdkRoot,PI_PACKAGE_DIR:path.join(sdkRoot,'packages/coding-agent'),JITI_FS_CACHE:'false',TSX_TSCONFIG_PATH:path.join(sdkRoot,'tsconfig.json'),TSX_CACHE_DIR:path.join(this.agentConfigDir,'runtime-cache/tsx'),PI_SKIP_VERSION_CHECK:'1'}:{}), PI_CODING_AGENT_DIR: this.agentConfigDir, CAD_DOCUMENT_ID: this.documentId, CAD_AGENT_MODE: this.mode, CAD_MCP_SERVER_PATH: path.resolve(path.dirname(this.extensionPath), "cad-mcp-server.mjs") },
      });
      this.child = child;
      this.closed = false;
      let exited,resolveClosed;
      const outputClosed=new Promise(resolve=>{resolveClosed=resolve;});this.outputClosed=outputClosed;
      child.stdout.on("data", (chunk) => { if (this.child === child) this.#receive(chunk); });
      child.stdout.once('end',()=>{
        if(this.child!==child)return;
        try{this.frames.finish(line=>this.#line(line));}catch{this.#fault('PI_RPC_PROTOCOL_ERROR','Pi 输出不是完整有效的 UTF-8 JSON。');}
        if(this.child===child&&!exited)this.#fault('PI_STDOUT_CLOSED','Pi 输出连接已关闭，请恢复会话后核对工程；不会自动重发命令。');
      });
      child.stdout.on('error',()=>{if(this.child===child)this.#fault('PI_STDOUT_ERROR','Pi 输出管道发生错误，请恢复会话并核对工程。');});
      child.stderr.on("data", chunk => {
        if(this.child!==child)return;
        const previous=this.stderrBytes;this.stderrBytes=Math.min(this.limits.stderrBytes+1,previous+chunk.length);
        if(previous===0)this.emit('diagnostic','Pi stderr diagnostics received; raw provider/session content is not logged.');
        if(previous<=this.limits.stderrBytes&&this.stderrBytes>this.limits.stderrBytes)this.emit('diagnostic','Pi stderr diagnostic byte budget reached; further content is drained without logging.');
      });
      child.stderr.on('error',()=>{if(this.child===child)this.emit('diagnostic','Pi stderr diagnostic stream failed.');});
      child.once("error", () => { if (this.child === child) this.#fault('PI_PROCESS_ERROR','Pi 进程启动或运行失败，未自动重发命令。'); });
      child.stdin.on("error", () => { if (this.child === child) this.#fault('PI_STDIN_ERROR','Pi 输入连接失败，请恢复会话并核对工程；不会自动重发命令。'); });
      child.once("exit", (code, signal) => {
        if (this.child !== child) return;
        exited={code,signal};this.closed=true;
        this.stoppingChild=child;this.stoppingClose=outputClosed;
      });
      child.once('close',(code,signal)=>{
        if(this.child===child){
          try{this.frames.finish(line=>this.#line(line));}catch{this.#fail(new PiSessionError('PI_RPC_PROTOCOL_ERROR','Pi 最后一条输出不完整或不是有效 JSON。'));}
          const terminal=exited||{code,signal};
          code=terminal.code;signal=terminal.signal;
        const error = `Pi 进程已退出（code=${code ?? "-"}, signal=${signal ?? "-"}）。可重新连接恢复已有会话，不会自动重发建模命令；若操作被中断，请先查询工程状态。`;
        this.#fail(new PiSessionError('PI_PROCESS_EXIT',error), false);
        this.child = null;
        this.closed = true;
        this.#emitEvent({ type: "runtime_exit", code, signal, error,outcome:'unknown',retryableByModel:false });
        }
        resolveClosed();
      });
      await this.request({ type: "get_state" }, PI_RPC_TIMEOUTS.startupMs);
      this.assertReusable();
      this.#emitEvent({ type: "runtime_ready", sessionId: this.sessionId, documentId: this.documentId, mode: this.mode });
      return this;
    })().catch(async (error) => {
      // A failed handshake must not leave a second orphan Pi process behind.
      await this.stop();
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  #receive(chunk) {
    try{this.frames.push(chunk,line=>this.#line(line));}
    catch(error){this.#fault(error.code==='MCP_FRAME_LIMIT'?'PI_RPC_OUTPUT_LIMIT':'PI_RPC_PROTOCOL_ERROR',error.code==='MCP_FRAME_LIMIT'?'Pi 单条输出超出预算，已停止采用该输出；请恢复会话并核对工程。':'Pi 输出不是有效 UTF-8 JSON，已停止采用；请恢复会话并核对工程。');}
  }
  #line(line){
      if(!line)return;
      let message;try{message=JSON.parse(line);}catch{throw new PiSessionError('PI_RPC_PROTOCOL_ERROR','Pi 输出不是有效 JSON。');}
      if(!isRecord(message)||typeof message.type!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(message.type))throw new PiSessionError('PI_RPC_PROTOCOL_ERROR','Pi 输出结构无效。');
      if (message.type === "response" && message.id != null) {
        if(typeof message.id!=='string'||message.id.length>128||typeof message.success!=='boolean')throw new PiSessionError('PI_RPC_PROTOCOL_ERROR','Pi RPC 回复凭据无效。');
        const pending = this.pending.get(String(message.id));
        if (pending) {
          if(message.command!==undefined&&message.command!==pending.command)throw new PiSessionError('PI_RPC_PROTOCOL_ERROR','Pi RPC 命令与回复不匹配。');
          if (!message.success) this.#settle(message.id,new PiSessionError('PI_RPC_REJECTED',typeof message.error==='string'?message.error.slice(0,4000):`Pi rejected ${pending.command}.`,{outcome:observations.has(pending.command)?'unchanged':'unknown'}));
          else this.#settle(message.id,null,{...message,transport:{streamId:this.streamId,eventCursorBefore:pending.eventCursorBefore,eventCursor:this.sequence}});
        }
      } else {
        if(message.type==='response')throw new PiSessionError('PI_RPC_PROTOCOL_ERROR','Pi RPC 回复缺少请求标识。');
        this.#emitEvent(message);
      }
      return Boolean(this.child);
  }

  #emitEvent(event) {
    let envelope = { id: ++this.sequence, streamId:this.streamId, event };
    // Keep native Pi history intact. Only the live transport uses a small hint
    // when a full tool/message event cannot fit the browser's bounded stream.
    if(Buffer.byteLength(JSON.stringify(envelope))>this.limits.eventBytes){
      const native=isRecord(event.message)?event.message:event;
      const callId=event.toolCallId||native.toolCallId,toolName=event.toolName||native.toolName;
      envelope={...envelope,event:{type:'runtime_snapshot_required',nativeEventType:String(event.type),...(typeof native.role==='string'?{nativeRole:native.role.slice(0,80)}:{}),...(typeof callId==='string'?{toolCallId:callId.slice(0,128)}:{}),...(typeof toolName==='string'?{toolName:toolName.slice(0,128)}:{})}};
    }
    const bytes=Buffer.byteLength(JSON.stringify(envelope));this.eventHistory.push({...envelope,bytes});this.eventHistoryBytes+=bytes;
    while(this.eventHistory.length>this.limits.historyCount||this.eventHistoryBytes>this.limits.historyBytes)this.eventHistoryBytes-=this.eventHistory.shift().bytes;
    this.emit("event", envelope);
  }

  #fail(error, emitEvent = true) {
    for (const [id,pending] of this.pending) this.#settle(id,new PiSessionError(error.code||'PI_RPC_DISCONNECTED',error.message||'Pi 连接已中断。',{outcome:observations.has(pending.command)?'unchanged':'unknown'}));
    if (emitEvent) this.#emitEvent({ type: "runtime_error", code:error.code||'PI_RPC_DISCONNECTED',error: error instanceof Error ? error.message : String(error),outcome:'unknown',retryableByModel:false });
  }
  #settle(id,error,result){const pending=this.pending.get(id);if(!pending)return;this.pending.delete(id);this.pendingBytes-=pending.bytes;clearTimeout(pending.timer);if(error)pending.reject(error);else pending.resolve(result);}
  #fault(code,message){
    if(!this.child)return;
    this.#fail(new PiSessionError(code,message));
    void this.stop().catch(()=>this.emit('diagnostic','Pi process/stdio closure is unconfirmed; replacement remains blocked.'));
  }

  request(input, timeoutMs) {
    const command = validatePiCommand(input, { sessionRoot: this.sessionRoot });
    if(timeoutMs===undefined)timeoutMs=piRpcTimeoutMs(command.type);
    if(this.disposed)return Promise.reject(new PiSessionError('PI_SESSION_DISPOSED','Pi 会话已永久关闭，未发送新的 RPC 命令。'));
    if (!this.child || this.closed || !this.child.stdin.writable) return Promise.reject(new PiSessionError('PI_SESSION_NOT_RUNNING',"Pi RPC session is not running."));
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>PI_RPC_TIMEOUTS.maxMs)return Promise.reject(new PiSessionError('PI_RPC_INVALID_TIMEOUT','Pi 请求截止须为 1 至 600000 毫秒。'));
    const id = `web-${crypto.randomUUID()}`;
    let line;try{line=JSON.stringify({...command,id})+'\n';}catch{return Promise.reject(new PiSessionError('PI_RPC_REQUEST_INVALID','Pi 请求不可序列化，未发送。'));}
    const bytes=Buffer.byteLength(line),urgent=controls.has(command.type),reserveCount=Math.min(4,Math.max(0,this.limits.pendingCount-1)),reserveBytes=Math.min(65536,Math.floor(this.limits.pendingBytes/8)),reserveStdin=Math.min(65536,Math.floor(this.limits.stdinBytes/8));
    if(bytes>this.limits.requestBytes)return Promise.reject(new PiSessionError('PI_RPC_REQUEST_LIMIT','Pi 请求超出字节预算，未发送。'));
    if(this.pending.size>=this.limits.pendingCount-(urgent?0:reserveCount)||this.pendingBytes+bytes>this.limits.pendingBytes-(urgent?0:reserveBytes)||(this.child.stdin.writableLength||0)+bytes>this.limits.stdinBytes-(urgent?0:reserveStdin))return Promise.reject(new PiSessionError('PI_RPC_QUEUE_LIMIT','Pi 传输请求已满，本条未发送；停止和状态查询保留独立余量。'));
    try{this.commandGuard?.(command);}catch(error){return Promise.reject(error);}
    if(!observations.has(command.type))this.commandSequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#settle(id,new PiSessionError('PI_RPC_TIMEOUT',observations.has(command.type)?`Pi 只读请求等待超时：${command.type}。`:`Pi 请求已发送但未确认：${command.type}。可能已经被接受，请核对会话和工程，不要直接重发。`,{outcome:observations.has(command.type)?'unchanged':'unknown'})),timeoutMs);
      this.pending.set(id, { resolve, reject, timer,bytes,command:command.type,eventCursorBefore:this.sequence });this.pendingBytes+=bytes;
      const child=this.child;
      try{child.stdin.write(line,error=>{if(error&&this.child===child)this.#fault('PI_STDIN_ERROR','Pi 输入写入失败，请恢复会话并核对工程，不会自动重发。');});}catch{this.#fault('PI_STDIN_ERROR','Pi 输入写入失败，请恢复会话并核对工程，不会自动重发。');}
    });
  }

  async setContext({ documentId }) {
    this.assertReusable();
    if(documentId!==undefined&&documentId!==this.documentId)throw new PiSessionError('PI_SESSION_DOCUMENT_MISMATCH','Pi 会话的工程归属不可变；未停止原会话或改绑旧历史。');
    // A second browser connection must await the first native RPC handshake.
    // Otherwise a late startup failure could kill a session already exposed as ready.
    if (this.starting) await this.starting;
    this.assertReusable();
    if (!this.child || this.closed) return this.start({ resume: true });
    return this.request({ type: "get_state" });
  }

  async #waitRetired(){
    const child=this.stoppingChild;if(!child)return;
    await waitChildExit(child,{timeoutMs:this.limits.stopMs,code:'PI_STOP_UNCONFIRMED',message:'Pi 进程尚未核验退出，不能宣称停机完成。'});
    if(this.stoppingClose)await waitOutputClosed(this.stoppingClose,this.limits.stopMs);
    if(this.stoppingChild===child){this.stoppingChild=null;this.stoppingClose=null;}
  }
  async stop() {
    if(this.stopPromise)return this.stopPromise;
    const child=this.child;
    if(!child||this.closed)return this.#waitRetired();
    this.stoppingChild=child;this.stoppingClose=this.outputClosed;
    this.child=null;this.closed=true;this.frames.clear();
    this.#fail(new PiSessionError('PI_SESSION_STOPPED','Pi RPC session was stopped. 已发送请求可能已被接受，请核对工程；不会自动重发建模命令。'),false);
    const stopping=(async()=>{
      const exited=waitChildExit(child,{timeoutMs:this.limits.stopMs,code:'PI_STOP_UNCONFIRMED',message:'Pi 进程尚未核验退出，不能宣称停机完成。'});exited.catch(()=>{});
      try{child.stdin.end();}catch{/* A closed stdin is not proof of process exit. */}
      try{child.kill();}catch{/* Still verify the exact owned process below. */}
      await exited;await this.#waitRetired();
    })();this.stopPromise=stopping;
    try{return await stopping;}finally{if(this.stopPromise===stopping)this.stopPromise=null;}
  }

  dispose() {
    this.disposed=true;
    return this.stop();
  }
}

export class PiRpcRuntime {
  constructor(options = {}) {
    this.options = options;
    this.sessions = new Map();
    this.creating = new Map();
    this.retiring=new Set();
    this.closing = false;
    this.ownershipBusy=false;
    this.activityReads=new Map();
    this.documentGuards=new Map();
    this.activityTimeoutMs=options.activityTimeoutMs??PI_DOCUMENT_ACTIVITY_LIMITS.timeoutMs;
    if(!Number.isSafeInteger(this.activityTimeoutMs)||this.activityTimeoutMs<1||this.activityTimeoutMs>PI_DOCUMENT_ACTIVITY_LIMITS.timeoutMs)throw new PiSessionError('PI_DOCUMENT_ACTIVITY_ARGUMENTS','Pi 工程状态查询截止须为 1 至 5000 毫秒。');
  }

  activityDocument(documentId){if(typeof documentId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(documentId))throw new PiSessionError('PI_DOCUMENT_ACTIVITY_ARGUMENTS','Pi 工程身份无效。',{outcome:'unchanged'});return documentId;}
  assertDocumentAvailable(documentId){
    this.activityDocument(documentId);
    if(this.closing)throw new PiSessionError('PI_SESSION_OWNER_STOPPING','Pi 运行时正在停止，未开始工程切换。');
    if(this.documentGuards.has(documentId))throw new PiSessionError('PI_DOCUMENT_TRANSFER_BUSY','此工程正在进行工作区操作，未启动新的 AI 命令；只读查询和停止仍可使用。');
  }
  guardDocumentCommand(documentId,command){
    if(observations.has(command.type)||['abort','abort_retry'].includes(command.type))return;
    this.assertDocumentAvailable(documentId);
  }
  /** This observes existing processes only: no config writes, owner adoption or restart. */
  documentActivity(documentId){
    this.activityDocument(documentId);
    const existing=this.activityReads.get(documentId);if(existing)return existing;
    if(this.activityReads.size>=PI_DOCUMENT_ACTIVITY_LIMITS.documents)throw new PiSessionError('PI_DOCUMENT_ACTIVITY_LIMIT','Pi 工程状态查询名额已满，未启动更多查询。',{outcome:'unchanged'});
    const pending=this.readDocumentActivity(documentId);this.activityReads.set(documentId,pending);
    void pending.finally(()=>{if(this.activityReads.get(documentId)===pending)this.activityReads.delete(documentId);}).catch(()=>{});
    return pending;
  }
  async readDocumentActivity(documentId){
    if(this.closing)throw new PiSessionError('PI_SESSION_OWNER_STOPPING','Pi 运行时正在停止，不能证明工程空闲。',{outcome:'unchanged'});
    const sessions=[...this.sessions.values()].filter(session=>session.documentId===documentId),creating=[...this.creating].filter(([,value])=>value.documentId===documentId),retiring=[...this.retiring].filter(session=>session.documentId===documentId);
    const identities=new Set([...sessions.map(session=>session.sessionId),...creating.map(([id])=>id),...retiring.map(session=>session.sessionId)]);
    if(identities.size>PI_DOCUMENT_ACTIVITY_LIMITS.sessions)throw new PiSessionError('PI_DOCUMENT_ACTIVITY_LIMIT','此工程的 Pi 会话数量超过一次核对预算，未推断空闲。',{outcome:'unchanged'});
    const rows=await Promise.all(sessions.map(async session=>{
      const base={sessionId:session.sessionId,streamId:session.streamId},streamId=session.streamId,child=session.child,sequence=session.commandSequence;
      if(creating.some(([id])=>id===session.sessionId)||session.starting)return {...base,status:'busy',reason:'starting'};
      if(session.stopPromise||session.stoppingChild||retiring.includes(session))return {...base,status:'unknown',reason:'stopping'};
      if(!child||session.closed||session.disposed)return {...base,status:'unknown',reason:'unavailable'};
      if([...session.pending.values()].some(value=>!observations.has(value.command)))return {...base,status:'busy',reason:'pending-command'};
      let value;
      try{value=await session.request({type:'get_state'},this.activityTimeoutMs);}catch{return {...base,status:'unknown',reason:'state-unavailable'};}
      if(this.closing||this.sessions.get(session.sessionId)!==session||session.child!==child||session.closed||session.disposed||session.starting||session.stopPromise||session.stoppingChild||session.streamId!==streamId||value.transport?.streamId!==streamId||session.commandSequence!==sequence)return {...base,status:'unknown',reason:'changed'};
      const state=value.data;
      if(typeof state?.isStreaming!=='boolean'||typeof state?.isCompacting!=='boolean'||!Number.isSafeInteger(state?.pendingMessageCount)||state.pendingMessageCount<0)return {...base,status:'unknown',reason:'invalid-state'};
      const fields={isStreaming:state.isStreaming,isCompacting:state.isCompacting,pendingMessageCount:state.pendingMessageCount};
      return {...base,...fields,status:state.isStreaming||state.isCompacting||state.pendingMessageCount>0?'busy':'idle',...(state.isStreaming?{reason:'streaming'}:state.isCompacting?{reason:'compacting'}:state.pendingMessageCount>0?{reason:'queued'}:{})};
    }));
    for(const [id] of creating)if(!rows.some(row=>row.sessionId===id))rows.push({sessionId:id,status:'busy',reason:'starting'});
    for(const session of retiring)if(!rows.some(row=>row.sessionId===session.sessionId))rows.push({sessionId:session.sessionId,streamId:session.streamId,status:'unknown',reason:'stopping'});
    const current=new Set([...this.sessions.values()].filter(session=>session.documentId===documentId).map(session=>session.sessionId));
    const changed=this.closing||current.size!==sessions.length||sessions.some(session=>!current.has(session.sessionId))||[...this.creating].some(([id,value])=>value.documentId===documentId&&!identities.has(id))||[...this.retiring].some(session=>session.documentId===documentId&&!identities.has(session.sessionId));
    return {version:1,documentId,status:changed||rows.some(row=>row.status==='unknown')?'unknown':rows.some(row=>row.status==='busy')?'busy':'idle',guarded:this.documentGuards.has(documentId),checkedAt:new Date().toISOString(),sessions:rows};
  }
  /** Acquire before the fresh native read; keep the barrier until the action settles. */
  async withDocumentQuiescent(documentId,action){
    this.assertDocumentAvailable(documentId);
    if(typeof action!=='function')throw new PiSessionError('PI_DOCUMENT_ACTIVITY_ARGUMENTS','工作区操作必须提供执行函数。');
    if(this.documentGuards.size>=PI_DOCUMENT_ACTIVITY_LIMITS.documents)throw new PiSessionError('PI_DOCUMENT_ACTIVITY_LIMIT','工程工作区操作名额已满。');
    const owner=Symbol(documentId);this.documentGuards.set(documentId,owner);
    try{
      const prior=this.activityReads.get(documentId);if(prior){await prior.catch(()=>{});if(this.activityReads.get(documentId)===prior)this.activityReads.delete(documentId);}
      const activity=await this.readDocumentActivity(documentId);
      if(activity.status!=='idle')throw new PiSessionError(activity.status==='busy'?'PI_DOCUMENT_ACTIVE':'PI_DOCUMENT_ACTIVITY_UNCONFIRMED',activity.status==='busy'?'原工程的 AI 仍在运行、压缩或排队，未开始工作区操作；请先等待或停止。':'原工程的 AI 状态尚未确认，未开始工作区操作；请恢复原会话并核对任务。',{outcome:'not-started'});
      return await action(activity);
    }finally{if(this.documentGuards.get(documentId)===owner)this.documentGuards.delete(documentId);}
  }

  /** Fail-fast ordered barriers; no partial ownership is left behind on rejection. */
  async withDocumentsQuiescent(documentIds,action){
    if(!Array.isArray(documentIds)||documentIds.length<1||documentIds.length>2||documentIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))||typeof action!=='function')throw new PiSessionError('PI_DOCUMENT_ACTIVITY_ARGUMENTS','工作区切换只接受来源和目标两个工程。');
    const ids=[...new Set(documentIds)].sort();
    const enter=index=>index===ids.length?action():this.withDocumentQuiescent(ids[index],()=>enter(index+1));
    return enter(0);
  }

  assertOwner(sessionId,documentId='default'){
    this.assertDocumentAvailable(documentId);
    const id=normalizePiSessionId(sessionId);
    try{return ensurePiSessionOwner(path.join(this.options.sessionRoot,id),id,documentId);}catch(error){if(error instanceof PiSessionOwnershipError)throw new PiSessionError(error.code,error.message);throw error;}
  }
  async assertFreshDocument(documentId){
    this.activityDocument(documentId);if(!this.documentGuards.has(documentId))throw new PiSessionError('PI_DOCUMENT_TRANSFER_BUSY','新工程身份检查必须位于目标工作区互斥内。');
    try{await assertFreshPiDocument(this.options.sessionRoot,documentId,{isCancelled:()=>this.closing});}catch(error){if(error instanceof PiSessionOwnershipError)throw new PiSessionError(error.code,error.message);throw error;}
  }
  async ownership(sessionId,documentId,historyDigest,{preview=false}={}){
    const id=normalizePiSessionId(sessionId);if(this.closing)throw new PiSessionError('PI_SESSION_OWNER_STOPPING','Pi 运行时正在停止，未确认新归属。');
    if(historyDigest!==undefined)this.assertDocumentAvailable(documentId);
    if(this.ownershipBusy)throw new PiSessionError('PI_SESSION_OWNER_BUSY','另一个 Pi 归属核对正在进行，请稍后重试。');
    if(historyDigest!==undefined&&(this.sessions.has(id)||this.creating.has(id)||[...this.retiring].some(session=>session.sessionId===id)))throw new PiSessionError('PI_SESSION_OWNER_BUSY','Pi 会话仍在运行、启动或停止，不能改动归属记录。');
    this.ownershipBusy=true;
    try{const root=path.join(this.options.sessionRoot,id),options={isCancelled:()=>this.closing,includePreview:preview};if(historyDigest===undefined)return publicPiSessionOwner(await inspectPiSessionOwner(root,id,documentId,options));const owner=await adoptPiSessionOwner(root,id,documentId,historyDigest,options);return publicPiSessionOwner({state:'bound',owner});}
    catch(error){if(error instanceof PiSessionOwnershipError)throw new PiSessionError(error.code,error.message,{outcome:error.outcome});throw error;}finally{this.ownershipBusy=false;}
  }

  async create(input = {}) {
    if(this.closing)throw new Error('Pi runtime is shutting down.');
    this.assertDocumentAvailable(input.documentId||this.sessions.get(input.sessionId)?.documentId||'default');
    const sessionId = normalizePiSessionId(input.sessionId);
    for(const old of this.retiring)if(old.sessionId===sessionId){if(input.documentId&&input.documentId!==old.documentId)throw new PiSessionError('PI_SESSION_DOCUMENT_MISMATCH','旧会话尚在停止，不能绑定其他工程。');await old.stop();this.retiring.delete(old);}
    if(this.closing)throw new Error('Pi runtime is shutting down.');
    const reserved=this.creating.get(sessionId);
    if(reserved){if(input.documentId&&input.documentId!==reserved.documentId)throw new PiSessionError('PI_SESSION_DOCUMENT_MISMATCH','Pi 会话正在为另一个工程启动。');await reserved.promise;return this.create({...input,sessionId});}
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if(input.documentId&&input.documentId!==existing.documentId)throw new PiSessionError('PI_SESSION_DOCUMENT_MISMATCH','Pi 会话属于另一个工程，不能重新绑定；请为当前工程创建独立会话。');
      await existing.setContext({ documentId: input.documentId, mode: input.mode });
      return existing;
    }
    const launch=(async()=>{
    const sessionRoot = path.join(this.options.sessionRoot, sessionId);
    this.assertOwner(sessionId,input.documentId||'default');
    const resume = input.resume === true || await hasSavedPiSession(sessionRoot);
    if(this.closing)throw new Error('Pi runtime is shutting down.');
    this.assertDocumentAvailable(input.documentId||'default');
    const session = new PiRpcSession({
      ...this.options,
      ...input,
      sessionId,
      env: { ...this.options.env, ...input.env },
      agentConfigDir: input.agentConfigDir || path.join(this.options.agentConfigDir, sessionId),
      sessionRoot,
      documentId: input.documentId,
      mode: input.mode,
      commandGuard:command=>this.guardDocumentCommand(input.documentId||'default',command),
    });
    this.sessions.set(sessionId, session);
    try { await session.start({ resume }); return session; }
    catch (error) { if(this.sessions.get(sessionId)===session)this.sessions.delete(sessionId); throw error; }
    })();
    this.creating.set(sessionId,{documentId:input.documentId||'default',promise:launch});
    try{return await launch;}finally{if(this.creating.get(sessionId)?.promise===launch)this.creating.delete(sessionId);}
  }

  get(sessionId) { return this.sessions.get(sessionId); }

  async remove(sessionId) {
    if(this.creating.has(sessionId))try{await this.creating.get(sessionId).promise;}catch{ /* Failed startup has already cleaned up its child. */ }
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    session.emit('removed');
    this.retiring.add(session);await session.dispose();this.retiring.delete(session);
    return true;
  }

  async close() {
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    for(const session of this.sessions.values())session.emit('removed',{reason:'service-shutdown'});
    const stops=[...new Set([...this.sessions.values(),...this.retiring])].map(session=>session.dispose());
    this.closePromise=Promise.all([Promise.allSettled([...this.creating.values()].map(item=>item.promise)),Promise.all(stops)]).then(()=>{this.sessions.clear();this.retiring.clear();});return this.closePromise;
  }
}
