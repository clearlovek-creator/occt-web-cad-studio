import {piRpcBrowserTimeoutMs} from '../../shared/pi-rpc-timeouts.mjs';

export type PiConnectionPhase = "connecting" | "synchronizing" | "online" | "offline" | "interrupted";
export type PiRpcReply = { data?: Record<string, unknown>; success?: boolean };
type StampedReply = { response: PiRpcReply; streamId?: string; eventCursorBefore?: number; eventCursor?: number };
export type PiConnectionSnapshot = { messages: unknown; models: unknown[]; state: Record<string, unknown>; thinkingLevels: string[] };
type WireEvent = Record<string, unknown>;
type Options = {
  apiRoot: string; sessionId: string; documentId: string;
  onStatus: (phase: PiConnectionPhase) => void;
  onSnapshot: (snapshot: PiConnectionSnapshot) => void;
  onEvent: (event: WireEvent) => void;
  onNotice: (message: string) => void;
  /** Reconcile the viewport once after each connection, including manual recovery. Never replay prompts. */
  onSynchronized?: () => void | Promise<void>;
  onSession?: (id: string) => void;
  onOwnershipRequired?: (value:{sessionId:string;documentId:string})=>void;
  ownershipPending?:boolean;
  fetchImpl?: typeof fetch;
  eventSource?: (url: string) => EventSource;
  retryDelays?: number[];
};
class ConnectionFault extends Error { constructor(message: string, public reconnect = false,public code?:string) { super(message); } }
const stateEvents = new Set(["agent_start", "agent_end", "auto_compaction_start", "auto_compaction_end", "auto_retry_start", "auto_retry_end"]);

/** Browser transport only. Native Pi remains the sole conversation and agent runtime. */
export class PiEventConnection {
  private epoch = 0;
  private disposed = false;
  private source: EventSource | null = null;
  private streamId: string | undefined;
  private remoteId: string;
  private controllers = new Set<AbortController>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private phase: PiConnectionPhase = "offline";
  private readyChannel = false;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private buffered: WireEvent[] = [];
  private bufferedBytes = 0;
  private lastEvent = 0;
  private messageFloor = 0;
  private stateFloor = 0;
  private recovering = false;
  private reconciledEpoch = -1;
  private waiters = new Set<{ check: () => void; cancel: () => void }>();
  private readonly fetcher: typeof fetch;
  constructor(private options: Options) {
    this.remoteId = options.sessionId;
    // Browser fetch must retain its native Window receiver. Calling a copied
    // function as this.fetcher() can fail with "Illegal invocation" in Chrome.
    this.fetcher = options.fetchImpl || ((input, init) => fetch(input, init));
  }
  private status(phase: PiConnectionPhase) { this.phase = phase; this.options.onStatus(phase); }
  private alive(epoch: number) { return !this.disposed && this.epoch === epoch; }
  private invalidate() {
    this.epoch++; this.source?.close(); this.source = null; this.readyChannel = false;
    for(const waiter of [...this.waiters])waiter.cancel();this.waiters.clear();
    for (const controller of this.controllers) controller.abort(); this.controllers.clear();
    this.buffered = []; this.bufferedBytes = 0; this.syncing = null; this.syncAgain = false;
  }
  close() { this.disposed = true; clearTimeout(this.retryTimer); this.invalidate(); }
  getBinding(){return Object.freeze({sessionId:this.remoteId,documentId:this.options.documentId});}
  getApprovalBinding(){return this.streamId ? {...this.getBinding(),streamId:this.streamId} : null;}
  private async json(route: string, body: Record<string, unknown>, epoch: number, timeoutMs = piRpcBrowserTimeoutMs('request')) {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(`${this.options.apiRoot}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      const payload = await response.json();
      if (!this.alive(epoch)) throw new ConnectionFault("Pi 连接已切换，旧回复未采用。");
      if (!response.ok || !payload?.ok) throw new ConnectionFault(payload?.error || "Pi 服务请求失败。", ["PI_SESSION_NOT_FOUND", "PI_SESSION_NOT_RUNNING", "PI_STREAM_CHANGED"].includes(payload?.code),payload?.code);
      return payload;
    } catch (error) {
      if (error instanceof ConnectionFault) throw error;
      throw new ConnectionFault("Pi 连接中断或请求未确认。不会自动重发建模命令；请核对当前工程。", true);
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private async rpc(command: Record<string, unknown>, epoch: number): Promise<StampedReply> {
    const payload = await this.json(`/pi/sessions/${encodeURIComponent(this.remoteId)}/commands`, { command, documentId: this.options.documentId, ...(this.streamId ? { streamId: this.streamId } : {}) }, epoch,piRpcBrowserTimeoutMs(String(command.type)));
    if (this.streamId && (payload.streamId !== this.streamId || payload.documentId !== this.options.documentId)) throw new ConnectionFault("Pi 事件流身份已变化，旧回复未采用。", true);
    if(this.streamId&&(!Number.isSafeInteger(payload.eventCursor)||payload.eventCursor<0))throw new ConnectionFault('Pi 回复缺少有效事件游标，未采用该结果。',true);
    if(this.streamId&&payload.eventCursorBefore!==undefined&&(!Number.isSafeInteger(payload.eventCursorBefore)||payload.eventCursorBefore<0||payload.eventCursorBefore>payload.eventCursor))throw new ConnectionFault('Pi 回复的快照区间无效，未采用该结果。',true);
    return { response: payload.response, streamId: payload.streamId,eventCursorBefore:payload.eventCursorBefore, eventCursor: payload.eventCursor };
  }
  async request(command: Record<string, unknown>): Promise<PiRpcReply> {
    if (this.phase !== "online" && !(command.type === "abort" && this.phase === "synchronizing")) throw new ConnectionFault("Pi 尚未完成会话同步，请等待连接就绪。");
    const epoch = this.epoch;
    try { return (await this.rpc(command, epoch)).response; }
    catch (error) { if (this.alive(epoch) && error instanceof ConnectionFault && error.reconnect) this.recover(error.message); throw error; }
  }
  private recover(message: string) {
    if (this.disposed || this.phase === "interrupted") return;
    this.recovering = true; this.invalidate(); clearTimeout(this.retryTimer); this.status("offline"); this.options.onNotice(message);
    const delays = this.options.retryDelays || [500, 1000, 2000, 4000, 8000];
    if (this.retries >= delays.length) { this.options.onNotice("自动恢复连接未成功。历史和输入仍保留，请手动重新连接；建模请求没有重发。"); return; }
    this.retryTimer = setTimeout(() => { void this.open(true); }, delays[this.retries++]);
  }
  async open(resume = false) {
    if (this.disposed) return;
    if(this.options.ownershipPending){this.status('offline');this.options.onOwnershipRequired?.({sessionId:this.options.sessionId,documentId:this.options.documentId});return;}
    clearTimeout(this.retryTimer); this.invalidate(); const epoch = this.epoch;
    this.recovering ||= resume; this.status("connecting");
    try {
      const payload = await this.json("/pi/sessions", { sessionId: this.options.sessionId, documentId: this.options.documentId }, epoch, piRpcBrowserTimeoutMs('startup'));
      if (payload.documentId !== undefined && payload.documentId !== this.options.documentId) throw new ConnectionFault("Pi 会话不属于当前工程。");
      this.remoteId = String(payload.sessionId || this.options.sessionId); this.streamId = typeof payload.streamId === "string" ? payload.streamId : undefined;
      this.options.onSession?.(this.remoteId);
      this.lastEvent = Number.isSafeInteger(payload.eventCursor) ? payload.eventCursor : 0;
      this.messageFloor = 0; this.stateFloor = 0;
      this.status("synchronizing");
      const query = new URLSearchParams({ after: String(this.lastEvent), documentId: this.options.documentId, ...(this.streamId ? { streamId: this.streamId } : {}) });
      const source = this.options.eventSource ? this.options.eventSource(`${this.options.apiRoot}/pi/sessions/${encodeURIComponent(this.remoteId)}/events?${query}`) : new EventSource(`${this.options.apiRoot}/pi/sessions/${encodeURIComponent(this.remoteId)}/events?${query}`);
      this.source = source;
      source.onopen = () => { if (this.alive(epoch) && !this.streamId) { this.readyChannel = true; this.onlineIfReady(); } };
      source.onerror = () => { if (this.alive(epoch)) this.recover("Pi 事件连接中断，正在恢复原会话；不会重发上一条请求。"); };
      source.addEventListener("pi", message => {
        if (!this.alive(epoch)) return;
        try { this.receive(JSON.parse((message as MessageEvent).data), epoch); } catch { /* Invalid diagnostics must not execute anything. */ }
      });
      await this.refresh();
    } catch (error) {
      if (!this.alive(epoch)) return;
      if (error instanceof ConnectionFault && error.reconnect) this.recover(error.message);
      else { this.invalidate(); this.status("offline"); this.options.onNotice(error instanceof Error ? error.message : "无法连接 Pi。");if(error instanceof ConnectionFault&&error.code==='PI_SESSION_OWNER_REQUIRED')this.options.onOwnershipRequired?.({sessionId:this.options.sessionId,documentId:this.options.documentId}); }
    }
  }
  private onlineIfReady() {
    if (this.readyChannel && !this.syncing && this.phase !== "online") {
      this.retries = 0; this.status("online");
      if (this.recovering) { this.recovering = false; this.options.onNotice("连接已恢复，原生会话已同步；没有重发建模命令。"); }
      const epoch = this.epoch;
      if (this.reconciledEpoch !== epoch) {
        this.reconciledEpoch = epoch;
        void Promise.resolve().then(() => {
          if (this.alive(epoch)) return this.options.onSynchronized?.();
        }).catch(() => {
          if (this.alive(epoch)) this.options.onNotice("会话已同步，但工程显示核对未完成，请刷新工程后检查结果。");
        });
      }
    }
  }
  private receive(event: WireEvent, epoch: number) {
    if (event.type === "stream_reset") { this.recover("事件流已更新或回放存在缺口，正在重新同步原生历史；不会重发命令。"); return; }
    if (this.streamId && (event.streamId !== this.streamId || event.documentId !== this.options.documentId)) { this.recover("收到不同工程或进程的事件，已停止采用旧流并重新连接。"); return; }
    if (event.type === "stream_connected") { this.readyChannel = true;this.notify(); this.onlineIfReady(); return; }
    if (event.type === "runtime_exit" || event.type === "runtime_error") {
      this.options.onEvent(event); this.invalidate(); this.status("interrupted"); return;
    }
    if (this.streamId) {
      if (!Number.isSafeInteger(event.eventCursor) || Number(event.eventCursor) <= this.lastEvent) return;
      if (Number(event.eventCursor) !== this.lastEvent + 1) { this.recover("Pi 事件序列出现缺口，正在重新同步历史。"); return; }
      this.lastEvent = Number(event.eventCursor);
    }
    if (this.syncing || this.phase !== "online") {
      const bytes = JSON.stringify(event).length * 2;
      this.buffered.push(event); this.bufferedBytes += bytes;
      if (this.buffered.length > 2000 || this.bufferedBytes > 4 * 1024 * 1024) this.recover("同步期间事件量超出缓冲限制，正在重新读取原生会话。");
    } else if (this.alive(epoch)) this.deliver(event);
    this.notify();
  }
  private notify(){for(const waiter of [...this.waiters])waiter.check();}
  private catchUp(cursor:number,epoch:number):Promise<void>{
    if(!this.streamId)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const finish=(error?:Error)=>{clearTimeout(timer);this.waiters.delete(waiter);if(error)reject(error);else resolve();};
      const waiter={check:()=>{if(!this.alive(epoch))finish(new ConnectionFault('Pi 连接已切换。'));else if(this.readyChannel&&this.lastEvent>=cursor)finish();},cancel:()=>finish(new ConnectionFault('Pi 同步连接已失效。'))};
      const timer=setTimeout(()=>finish(new ConnectionFault('Pi 事件回放未追上原生快照，正在重新同步。',true)),10000);
      this.waiters.add(waiter);waiter.check();
    });
  }
  private deliver(event: WireEvent) {
    const snapshotHint=event.type==='runtime_snapshot_required';
    if (this.streamId) {
      const cursor=Number(event.eventCursor),isState=stateEvents.has(String(event.type));
      if(cursor<=(isState?this.stateFloor:this.messageFloor)){
        // A history snapshot may already contain this tool result, but it
        // cannot itself prove the CAD viewport adopted the mutation.
        const native=event.message&&typeof event.message==='object'?event.message as WireEvent:event;
        if(snapshotHint||event.type==='tool_execution_end'||event.type==='message_end'&&native.role==='toolResult')this.options.onEvent(snapshotHint?event:{type:'runtime_snapshot_required',nativeEventType:event.type,nativeRole:native.role,toolCallId:event.toolCallId||native.toolCallId,toolName:event.toolName||native.toolName});
        if(isState&&cursor>this.messageFloor&&['agent_end','auto_compaction_end'].includes(String(event.type))){if(this.syncing)this.syncAgain=true;else void this.refresh();}
        return;
      }
    }
    if(snapshotHint){
      this.options.onEvent(event);
      this.options.onNotice('工具或消息内容较大，正在读取完整原生历史；没有重发建模命令。');
      if(this.syncing)this.syncAgain=true;else void this.refresh();
      return;
    }
    this.options.onEvent(event);
  }
  refresh(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    const epoch = this.epoch;
    if (this.disposed || !this.remoteId || ["offline", "interrupted"].includes(this.phase)) return Promise.resolve();
    this.status("synchronizing");
    const sync = (async () => {
      const [history, models] = await Promise.all([this.rpc({ type: "get_messages" }, epoch), this.rpc({ type: "get_available_models" }, epoch)]);
      if (!this.alive(epoch)) return;
      const state = await this.rpc({ type: "get_state" }, epoch);
      const levels = await this.rpc({ type: "get_available_thinking_levels" }, epoch);
      if (!this.alive(epoch)) return;
      await this.catchUp(Math.max(history.eventCursor||0,models.eventCursor||0,state.eventCursor||0,levels.eventCursor||0),epoch);
      if(!this.alive(epoch))return;
      this.messageFloor=history.eventCursorBefore??history.eventCursor??0;this.stateFloor=state.eventCursorBefore??state.eventCursor??0;
      this.options.onSnapshot({ messages: history.response.data?.messages, models: Array.isArray(models.response.data?.models) ? models.response.data.models : [], state: state.response.data || {}, thinkingLevels: Array.isArray(levels.response.data?.levels) ? levels.response.data.levels as string[] : [] });
      const queued = this.buffered; this.buffered = []; this.bufferedBytes = 0;
      for (const event of queued) {
        if (!this.alive(epoch)) return;
        this.deliver(event);
      }
      this.messageFloor=this.lastEvent;this.stateFloor=this.lastEvent;
    })().catch(error => { if (this.alive(epoch)) this.recover(error instanceof Error ? error.message : "Pi 会话同步失败。"); }).finally(() => {
      if (!this.alive(epoch) || this.syncing !== sync) return;
      this.syncing = null;
      if (this.syncAgain) { this.syncAgain = false; void this.refresh(); } else this.onlineIfReady();
    });
    this.syncing = sync; return sync;
  }
}
