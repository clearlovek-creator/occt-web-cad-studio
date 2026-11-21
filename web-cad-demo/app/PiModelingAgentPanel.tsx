"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_ROOT } from "./api-config";
import type { ModelingCommandResponse, ModelingSelection } from "./modeling/command-contract";
import { useModelingController } from "./modeling/modeling-controller";
import { modelingController } from "./modeling/runtime";
import { applyNativePiMessage, applyPiToolEvent, piNativeMessageKey, flattenMessages, isNearPiConversationEnd, piRuntimeError, piThinkingSummary, piToolSummary, piToolNeedsReconcile, piDetailPage, shouldSubmitPiMessage, type PiMessage } from "./modeling/pi-messages";
import {PiEventConnection,type PiConnectionPhase} from './modeling/pi-event-connection';
import {PiStopCoordinator,type PiStopState} from './modeling/pi-stop-state';
import {modelingTaskTerminal} from '../shared/modeling-task-status.mjs';
import {modelingTaskTouchesDocument} from './modeling/modeling-task-client';
import {PiSessionOwnershipPanel} from './PiSessionOwnershipPanel';
import {piOwnershipPendingKey} from './modeling/pi-session-ownership-client';

type PiModel = { id: string; name?: string; provider: string; contextWindow?: number; reasoning?: boolean };
type Props = { revision: number | null; selection: ModelingSelection | null; onCommitted?: (result: ModelingCommandResponse) => void; onOpenSettings?: () => void };

function PiMessageDetails({item,onOpen}:{item:PiMessage;onOpen:()=>void}){
  const [expanded,setExpanded]=useState(false);
  const [requestedPage,setRequestedPage]=useState(0);
  const summary=item.role==='thinking'?piThinkingSummary(item):piToolSummary(item);
  const page=expanded?piDetailPage(item.content,requestedPage):null;
  return <details className="pi-agent-details" onToggle={event=>{const open=event.currentTarget.open;setExpanded(open);if(open)onOpen();}}><summary title={summary}>{summary}</summary>{page&&<>{page.pages>1&&<div className="pi-agent-detail-pages" aria-label="详情分段"><span role="status">第 {page.index+1} / {page.pages} 段 · 复制包含全文</span><button type="button" disabled={page.index===0} onClick={()=>setRequestedPage(0)}>首页</button><button type="button" disabled={page.index===0} onClick={()=>setRequestedPage(page.index-1)}>上一段</button><button type="button" disabled={page.index===page.pages-1} onClick={()=>setRequestedPage(page.index+1)}>下一段</button><button type="button" disabled={page.index===page.pages-1} onClick={()=>setRequestedPage(page.pages-1)}>末段</button></div>}<div key={page.index} className="pi-agent-message-content">{page.text}</div></>}</details>;
}

export function PiModelingAgentPanel({ revision, selection, onCommitted, onOpenSettings }: Props) {
  const controller = useModelingController(modelingController);
  const documentId = controller.documentId;
  const storageKey = `web-cad-pi-session:${documentId}`;
  const [reconnect, setReconnect] = useState(0);
  const approvedConnection=useRef<{sessionId:string;documentId:string}|null>(null);
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [models, setModels] = useState<PiModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const input=drafts[documentId]||'';
  const setInput=useCallback((value:string|((previous:string)=>string))=>setDrafts(current=>({...current,[documentId]:typeof value==='function'?value(current[documentId]||''):value})),[documentId]);
  const [busy, setBusy] = useState(false);
  const [stopState,setStopState]=useState<(PiStopState&{documentId:string})|null>(null);
  const stopRef=useRef<PiStopCoordinator|null>(null);
  const transferring=modelingController.hasWorkspaceTransfer();
  const modelingPending=controller.modelingTasks.some(item=>modelingTaskTouchesDocument(item,documentId)&&!modelingTaskTerminal(item.task.phase));
  const currentStop=stopState?.documentId===documentId?stopState:null;
  const stopWaiting=Boolean(currentStop&&(['sending','uncertain','refreshing'].includes(currentStop.phase)||currentStop.phase==='checking'&&(busy||modelingPending)));
  const controlsBusy=busy||modelingPending||stopWaiting||transferring;
  const [connectionPhase,setConnectionPhase]=useState<PiConnectionPhase>('connecting');
  const connected=connectionPhase==='online',connecting=connectionPhase==='connecting'||connectionPhase==='synchronizing';
  const [connectionNotice,setConnectionNotice]=useState<string|null>(null);
  const [ownershipBinding,setOwnershipBinding]=useState<{sessionId:string;documentId:string}|null>(null);
  const ownerRecovery=ownershipBinding?.documentId===documentId?ownershipBinding:null;
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[] | null>(null);
  const [copyId, setCopyId] = useState<string | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [streamingBehavior, setStreamingBehavior] = useState<"steer" | "followUp">("steer");
  const [queued, setQueued] = useState(0);
  const [unread, setUnread] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const connectionRef=useRef<PiEventConnection|null>(null);
  const ownerDocument=useRef<string|null>(null);
  const refreshedCalls=useRef(new Set<string>());
  const nativeBusy=useRef({streaming:false,compacting:false});
  const geometryRefresh=useRef<{documentId:string;again:boolean;promise:Promise<void>}|null>(null);
  const committedRef = useRef(onCommitted);
  useEffect(() => { committedRef.current = onCommitted; }, [onCommitted]);
  const activeSelection = useMemo(() => selection, [selection]);

  const sendCommand = useCallback(async (command: Record<string, unknown>) => {
    const connection=connectionRef.current;if(!connection)throw new Error('Pi 会话尚未就绪');
    return connection.request(command);
  }, []);
  const refreshMessages = useCallback(async () => {await connectionRef.current?.refresh();}, []);
  const refreshModels=refreshMessages;
  const refreshGeometry=useCallback(()=>{
    if(modelingController.getSnapshot().documentId!==documentId)return Promise.resolve();
    const pending=geometryRefresh.current;
    if(pending?.documentId===documentId){pending.again=true;return pending.promise;}
    const owned={documentId,again:false,promise:Promise.resolve()};
    const running=(async()=>{
      do{
        owned.again=false;
        const view=await modelingController.execute<ModelingCommandResponse>({operation:'document.view'});
        if(modelingController.getSnapshot().documentId!==documentId)return;
        committedRef.current?.(view);
      }while(owned.again);
    })();owned.promise=running.finally(()=>{if(geometryRefresh.current===owned)geometryRefresh.current=null;});geometryRefresh.current=owned;return owned.promise;
  },[documentId]);
  const refreshToolGeometry=useCallback((callId:string,name:string)=>{
    if(!piToolNeedsReconcile(name)||refreshedCalls.current.has(callId))return;
    if(callId)refreshedCalls.current.add(callId);
    while(refreshedCalls.current.size>512)refreshedCalls.current.delete(refreshedCalls.current.values().next().value!);
    void refreshGeometry().catch(()=>{if(modelingController.getSnapshot().documentId===documentId)setError('工具已返回，但工程显示核对失败，请刷新工程确认结果。');});
  },[documentId,refreshGeometry]);

  const applyPiEvent = useCallback((event: Record<string, unknown>) => {
    if (event.type === "runtime_ready") return;
    if(event.type==='runtime_snapshot_required'){
      if(event.nativeEventType==='tool_execution_end'||event.nativeRole==='toolResult')refreshToolGeometry(String(event.toolCallId||''),String(event.toolName||''));
      return;
    }
    if (event.type === "runtime_error" || event.type === "runtime_exit") {
      setBusy(false);
      setMessages(current => current.map(item => ["running", "streaming"].includes(item.status || "") ? { ...item, status: "interrupted" } : item));
      void refreshGeometry().catch(()=>{});
      setError(piRuntimeError(event)); return;
    }
    if (event.type === "agent_start") nativeBusy.current.streaming=true;
    if (event.type === "agent_end") {nativeBusy.current.streaming=false;void refreshMessages();}
    if (event.type === "auto_compaction_start") nativeBusy.current.compacting=true;
    if (event.type === "auto_compaction_end") {nativeBusy.current.compacting=false;void refreshMessages();}
    if(['agent_start','agent_end','auto_compaction_start','auto_compaction_end'].includes(String(event.type)))setBusy(nativeBusy.current.streaming||nativeBusy.current.compacting);
    if(['message_start','message_update','message_end'].includes(String(event.type))&&event.message&&typeof event.message==='object'){
      const native=event.message as Record<string,unknown>;
      if(native.role==='assistant'&&piNativeMessageKey(native)||native.role==='toolResult'&&event.type==='message_end'){
        setMessages(current=>applyNativePiMessage(current,event)||current);
        if(native.role==='toolResult')refreshToolGeometry(String(native.toolCallId||''),String(native.toolName||''));
        return;
      }
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent && typeof event.assistantMessageEvent === "object" ? event.assistantMessageEvent as Record<string, unknown> : {};
      if (["text_delta", "thinking_delta"].includes(String(update.type)) && typeof update.delta === "string") {
        const delta = update.delta;
        const role = update.type === "thinking_delta" ? "thinking" : "assistant";
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === role && last.status === "streaming") return [...current.slice(0, -1), { ...last, content: last.content + delta }];
          return [...current, { id: `stream-${crypto.randomUUID()}`, role, content: delta, status: "streaming" }];
        });
      }
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(event.type))) {
      setMessages(current => applyPiToolEvent(current, event));
    }
    if (event.type === "tool_execution_end") {
      refreshToolGeometry(String(event.toolCallId||''),String(event.toolName||''));
    }
  }, [refreshMessages,refreshToolGeometry,refreshGeometry]);

  useEffect(() => {
    if(ownerDocument.current!==documentId){
      ownerDocument.current=documentId;refreshedCalls.current.clear();followMessages.current=true;
      setMessages([]);setModels([]);setSelectedModel('');setHistory(null);setUnread(false);setConnectionNotice(null);
    }
    const approved=approvedConnection.current;approvedConnection.current=null;
    let id=approved?.documentId===documentId?approved.sessionId:localStorage.getItem(storageKey);
    if(!id){id=`webcad-${documentId}`;localStorage.setItem(storageKey,id);}
    const connection=new PiEventConnection({
      apiRoot:API_ROOT,sessionId:id,documentId,
      ownershipPending:localStorage.getItem(piOwnershipPendingKey(API_ROOT,id,documentId))!==null,
      onSession:remoteId=>localStorage.setItem(storageKey,remoteId),
      onStatus:phase=>{
        setConnectionPhase(phase);
        if(phase==='offline'||phase==='interrupted'){
          setBusy(false);setQueued(0);nativeBusy.current={streaming:false,compacting:false};
          setMessages(current=>current.map(item=>['running','streaming'].includes(item.status||'')?{...item,status:'interrupted'}:item));
        }
      },
      onNotice:setConnectionNotice,
      onSnapshot:snapshot=>{
        setMessages(flattenMessages(snapshot.messages));setModels(snapshot.models as PiModel[]);setError(null);setConnectionNotice(null);
        const selected=snapshot.state.model as PiModel|undefined;
        setSelectedModel(selected?.provider&&selected?.id?`${selected.provider}/${selected.id}`:'');
        nativeBusy.current={streaming:Boolean(snapshot.state.isStreaming),compacting:Boolean(snapshot.state.isCompacting)};setBusy(nativeBusy.current.streaming||nativeBusy.current.compacting);
        setQueued(Number(snapshot.state.pendingMessageCount||0));
        setThinkingLevel(String(snapshot.state.thinkingLevel||'off'));setThinkingLevels(snapshot.thinkingLevels);
      },
      onEvent:applyPiEvent,onSynchronized:refreshGeometry,onOwnershipRequired:binding=>{if(binding.documentId===documentId)setOwnershipBinding(binding);},
    });
    connectionRef.current=connection;
    const stop=new PiStopCoordinator(connection,()=>modelingController.discoverModelingTasks(documentId),state=>{if(connectionRef.current===connection)setStopState({...state,documentId});});stopRef.current=stop;stop.reset();
    void connection.open();
    return()=>{stop.close();if(stopRef.current===stop)stopRef.current=null;connection.close();if(connectionRef.current===connection)connectionRef.current=null;};
  },[applyPiEvent,documentId,reconnect,refreshGeometry,storageKey]);

  useEffect(() => {
    if (!logRef.current) return;
    if (followMessages.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    else setUnread(true);
  }, [messages]);

  const showLatest = () => {
    followMessages.current = true; setUnread(false);
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  };

  const submit = async () => {
    const message = input.trim();
    if (!message || !connected) return;
    if(message==='/stop'){setInput('');await stopRef.current?.stop();return;}
    if(transferring||modelingController.hasWorkspaceTransfer()||stopWaiting||modelingPending&&!busy)return;
    if(['/compact','/new'].includes(message)&&controlsBusy){setError('请等待当前 Pi 与建模任务结束后，再压缩或新建会话。');return;}
    const wasBusy = busy;
    const owner=connectionRef.current;
    stopRef.current?.reset();
    showLatest();
    setInput(""); setError(null);setConnectionNotice(null); setBusy(true);
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", content: message }]);
    try {
      const context = [`当前工程 documentId=${documentId}，revision=${revision ?? "unknown"}。`, activeSelection ? `当前选择=${activeSelection.kind} ${activeSelection.bodyId}${activeSelection.topologyId ? ` / ${activeSelection.topologyId}` : ""}。` : "当前没有选择几何。", "先通过 query_model 检查现状，按用户意图讨论方案或使用 CAD MCP 工具实施。"].join("\n");
      if (message === "/compact") { await owner?.request({ type: "compact" });if(owner!==connectionRef.current)return;await owner?.refresh();if(owner===connectionRef.current)setBusy(false);return; }
      if (message === "/new") { await owner?.request({ type: "new_session" });if(owner!==connectionRef.current)return;await owner?.refresh();if(owner===connectionRef.current)setBusy(false);return; }
      await sendCommand({ type: "prompt", message: message.startsWith("/") ? message : `${context}\n\n用户请求：${message}`, ...(wasBusy ? { streamingBehavior } : {}) });
      if (wasBusy) await refreshModels();
    } catch (reason) {setInput(current=>current||message);if(owner!==connectionRef.current)return;setBusy(false);setError(reason instanceof Error ? reason.message : "发送失败");}
  };

  const chooseModel = async (value: string) => {
    const slash = value.indexOf("/");
    if (slash < 1) return;
    try { await sendCommand({ type: "set_model", provider: value.slice(0, slash), modelId: value.slice(slash + 1) }); await refreshModels(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "模型切换失败"); }
  };

  const toggleHistory = async () => {
    if (history) { setHistory(null); return; }
    try {
      const result = await sendCommand({ type: "get_entries" });
      const entries = Array.isArray(result.data?.entries) ? result.data.entries as Array<Record<string, unknown>> : [];
      setHistory(entries.slice(-60).map((entry) => `${String(entry.type || "entry")} · ${String(entry.id || "")} · ${String(entry.timestamp || "")}`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取 Pi 会话历史"); }
  };

  const newSession = async () => {
    try { await sendCommand({ type: "new_session" });await refreshMessages();setHistory(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法新建会话"); }
  };

  const copy = async (item: PiMessage) => {
    try { await navigator.clipboard.writeText(item.content); setCopyId(item.id); window.setTimeout(() => setCopyId(null), 1000); }
    catch { setError("复制失败，请手动选择文字复制"); }
  };
  const connectReviewedSession=()=>{
    if(!ownerRecovery)return;
    try{
      const target={sessionId:ownerRecovery.sessionId,documentId};
      localStorage.setItem(storageKey,target.sessionId);
      if(localStorage.getItem(storageKey)!==target.sessionId)throw Error();
      approvedConnection.current=target;setOwnershipBinding(null);setReconnect(value=>value+1);
    }catch{setError('已核对的会话身份无法保存，未连接其他会话；请允许本站存储后重试。');}
  };

  return <section className="pi-agent-panel" data-testid="pi-agent-panel" aria-label="Pi 建模助手">
    <header className="pi-agent-header">
      <div><span className="pi-agent-eyebrow">PI RPC · CAD MCP</span><strong>建模助手</strong><small>{connected ? `${models.length} 个模型 · ${revision == null ? "工程载入中" : `R${revision}`}` : connectionPhase==='synchronizing'?'正在同步原生历史与事件…':connecting ? "正在连接 Pi Agent…" : "Pi Agent 未连接"}</small></div>
      <span title="会话在线表示 Pi 与事件流已同步，不代表大模型服务已经通过可用性验证。" className={`pi-agent-status ${connected ? "online" : connecting?'connecting':"offline"}`}>{connected ? "会话在线" : connectionPhase==='synchronizing'?'同步中':connecting ? "连接中" : connectionPhase==='interrupted'?'已中断':"离线"}</span>
    </header>
    <div className="pi-agent-toolbar">
      <label className="pi-agent-model"><span>模型</span><select aria-label="Pi 模型" value={selectedModel} onChange={(event) => void chooseModel(event.target.value)} disabled={!connected || controlsBusy}><option value="">选择模型</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name || model.id} · {model.provider}</option>)}</select></label>
      {thinkingLevels.length > 1 && <label className="pi-agent-model"><span>思考</span><select aria-label="Pi 思考级别" value={thinkingLevel} disabled={!connected || controlsBusy} onChange={event => { const level = event.target.value; void sendCommand({ type: "set_thinking_level", level }).then(() => setThinkingLevel(level)).catch(reason => setError(reason.message)); }}>{thinkingLevels.map(level => <option key={level} value={level}>{level}</option>)}</select></label>}
      <button type="button" title="压缩 Pi 会话上下文" disabled={!connected || controlsBusy} onClick={() => void sendCommand({ type: "compact" }).then(() => refreshMessages()).catch((reason) => setError(reason.message))}>压缩</button>
      <button type="button" title="查看 Pi 会话历史" disabled={!connected} onClick={() => void toggleHistory()}>历史</button>
      <button type="button" title="核对会话归属和导出本地恢复备份，不会改写历史" disabled={transferring} onClick={()=>{try{const current=connectionRef.current?.getBinding(),sessionId=current?.documentId===documentId?current.sessionId:localStorage.getItem(storageKey)||`webcad-${documentId}`;setOwnershipBinding({sessionId,documentId});}catch{setError('浏览器存储不可读取，原恢复材料未修改；请允许本站存储后重试。');}}}>恢复记录</button>
      <button type="button" title="新建 Pi 会话" disabled={!connected || controlsBusy} onClick={() => void newSession()}>新会话</button>
      <button type="button" title="大模型设置" onClick={onOpenSettings}>设置</button>
    </div>
    {history && <div className="pi-agent-history" aria-label="Pi 会话历史">{history.length ? history.map((line, index) => <div key={`${index}-${line}`}>{line}</div>) : <span>当前会话还没有历史条目</span>}</div>}
    <div ref={logRef} className="pi-agent-messages" aria-live="polite" onScroll={event => {
      followMessages.current = isNearPiConversationEnd(event.currentTarget);
      if (followMessages.current) setUnread(false);
    }}>
      {ownerRecovery&&<PiSessionOwnershipPanel key={`${documentId}:${ownerRecovery.sessionId}`} sessionId={ownerRecovery.sessionId} documentId={documentId} disabled={controlsBusy||transferring} onClose={()=>setOwnershipBinding(null)} onConnected={connectReviewedSession}/>}
      {!messages.length&&!ownerRecovery && <div className="pi-agent-empty"><strong>描述建模目标，或与 Pi Agent 讨论方案</strong><span>工具和思考默认折叠，点击查看详情。建模结果同步到当前工程。</span></div>}
      {messages.map((item) => <article key={item.id} className={`pi-agent-message ${item.role === "user" ? "user" : item.role === "tool" ? "tool" : item.role === "system" ? "system" : "assistant"}`}>
        <div className="pi-agent-message-meta"><span>{item.role === "user" ? "你" : item.role === "tool" ? item.toolName || "CAD MCP" : item.role === "system" ? "系统" : "Pi Agent"}</span><button type="button" onClick={() => void copy(item)} aria-label="复制消息">{copyId === item.id ? "已复制" : "复制"}</button></div>
        {item.role === "tool" || item.role === "thinking" ? <PiMessageDetails item={item} onOpen={()=>{followMessages.current=false;}}/> : <div className="pi-agent-message-content">{item.content}</div>}
      </article>)}
      {busy && !messages.some((item) => item.role === "assistant" && item.status === "streaming") && <div className="pi-agent-thinking">Pi Agent 正在运行<span>…</span></div>}
    </div>
    {unread && <button type="button" className="pi-agent-show-latest" onClick={showLatest}>有新消息 · 回到最新 ↓</button>}
    {connectionNotice&&!ownerRecovery&&<p className="pi-agent-connection-note" role="status">{connectionNotice}</p>}
    {currentStop?.notice&&<div className="pi-agent-connection-note pi-agent-stop-note" role="status" data-testid="pi-stop-status" data-phase={currentStop.phase}><span>{currentStop.notice}</span>{['uncertain','refreshing'].includes(currentStop.phase)&&<button type="button" disabled={!connected||currentStop.phase==='refreshing'} onClick={()=>void stopRef.current?.check()}>{currentStop.phase==='refreshing'?'检查中':'检查停止状态'}</button>}</div>}
    {error && <div className="pi-agent-error" role="alert">{error}</div>}
    {!connected && !connecting&&!ownerRecovery && <button type="button" onClick={() => setReconnect((value) => value + 1)}>重新连接已有会话</button>}
    <form className="pi-agent-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea aria-label="发送给 Pi Agent" placeholder="讨论方案，或描述要创建、修改的几何…" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (shouldSubmitPiMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); void submit(); } }} disabled={!connected || connecting||transferring||stopWaiting||modelingPending&&!busy} />
      <div className="pi-agent-composer-footer"><span>{transferring?'工程切换中 · 原会话保留':stopWaiting?'停止中 · 请查看建模任务终态':modelingPending&&!busy?'建模任务尚未结束':queued ? `${queued} 条待处理` : "Enter 发送 · Shift+Enter 换行"}</span>{(busy||stopWaiting) && <><select aria-label="Pi 运行中消息方式" disabled={stopWaiting} value={streamingBehavior} onChange={event => setStreamingBehavior(event.target.value as "steer" | "followUp")}><option value="steer">引导当前任务</option><option value="followUp">完成后继续</option></select><button type="button" disabled={stopWaiting} onClick={() => void stopRef.current?.stop()}>{stopWaiting?'正在停止':'停止'}</button></>}<button type="submit" disabled={!input.trim() || !connected||transferring||stopWaiting||modelingPending&&!busy}>{busy ? "追加" : "发送"}</button></div>
    </form>
  </section>;
}
