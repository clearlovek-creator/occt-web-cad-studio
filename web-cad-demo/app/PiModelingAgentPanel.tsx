"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_ROOT } from "./api-config";
import type { ModelingCommandResponse, ModelingSelection } from "./modeling/command-contract";
import { useModelingController } from "./modeling/modeling-controller";
import { modelingController } from "./modeling/runtime";
import { applyNativePiMessage, applyPiToolEvent, piNativeMessageKey, flattenMessages, isNearPiConversationEnd, piRuntimeError, piThinkingSummary, piToolSummary, piToolNeedsReconcile, piDetailPage, shouldSubmitPiMessage, PI_IMAGE_TYPES, piImageType, piImageUrl, type PiImage, type PiMessage } from "./modeling/pi-messages";
import {PiEventConnection,type PiConnectionPhase} from './modeling/pi-event-connection';
import {PiStopCoordinator,type PiStopState} from './modeling/pi-stop-state';
import {modelingTaskTerminal} from '../shared/modeling-task-status.mjs';
import {modelingTaskTouchesDocument} from './modeling/modeling-task-client';
import {PiSessionOwnershipPanel} from './PiSessionOwnershipPanel';
import {piOwnershipPendingKey} from './modeling/pi-session-ownership-client';
import {PiWriteApprovalCard,type PiApprovalBinding} from './workbench/PiWriteApprovalCard';
import {WorkbenchDialog} from './workbench/WorkbenchDialog';
import {AgentProviderSettingsPanel,type PiModelConfiguration} from './AgentProviderSettingsPanel';

type PiModel = PiModelConfiguration & { name?: string };
type PiConversation = { id: string; title: string; updatedAt: string; active: boolean; deleted?: boolean };
type Attachment = { id: string; name: string; bytes: number; image: PiImage };
type Props = { revision: number | null; selection: ModelingSelection | null; onCommitted?: (result: ModelingCommandResponse) => void };
const imageBudget = 680 * 1024;
function readPiImage(file: File, mimeType: PiImage['mimeType']): Promise<Attachment> {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error(`无法读取图片 ${file.name}。`));
    reader.onload=()=>resolve({id:crypto.randomUUID(),name:file.name,bytes:file.size,image:{type:'image',mimeType,data:String(reader.result).split(',')[1]}});
    reader.readAsDataURL(file);
  });
}

function PiMessageDetails({item,onOpen}:{item:PiMessage;onOpen:()=>void}){
  const [expanded,setExpanded]=useState(false);
  const [requestedPage,setRequestedPage]=useState(0);
  const summary=item.role==='thinking'?piThinkingSummary(item):piToolSummary(item);
  const page=expanded?piDetailPage(item.content,requestedPage):null;
  return <details className="pi-agent-details" onToggle={event=>{const open=event.currentTarget.open;setExpanded(open);if(open)onOpen();}}><summary title={summary}>{summary}</summary>{page&&<>{page.pages>1&&<div className="pi-agent-detail-pages" aria-label="详情分段"><span role="status">第 {page.index+1} / {page.pages} 段 · 复制包含全文</span><button type="button" disabled={page.index===0} onClick={()=>setRequestedPage(0)}>首页</button><button type="button" disabled={page.index===0} onClick={()=>setRequestedPage(page.index-1)}>上一段</button><button type="button" disabled={page.index===page.pages-1} onClick={()=>setRequestedPage(page.index+1)}>下一段</button><button type="button" disabled={page.index===page.pages-1} onClick={()=>setRequestedPage(page.pages-1)}>末段</button></div>}<div key={page.index} className="pi-agent-message-content">{page.text}</div></>}</details>;
}

export function PiModelingAgentPanel({ revision, selection, onCommitted }: Props) {
  const controller = useModelingController(modelingController);
  const documentId = controller.documentId;
  const storageKey = `web-cad-pi-session:${documentId}`;
  const [reconnect, setReconnect] = useState(0);
  const approvedConnection=useRef<{sessionId:string;documentId:string}|null>(null);
  const [messages, setMessages] = useState<PiMessage[]>([]);
  const [models, setModels] = useState<PiModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [activeModel, setActiveModel] = useState<PiModel>();
  const [imageDrafts,setImageDrafts]=useState<Record<string,Attachment[]>>({});
  const [readingDocument,setReadingDocument]=useState<string|null>(null);
  const readingImage=useRef<string|null>(null);
  const attached=imageDrafts[documentId]||[];
  const modelAcceptsImages=Boolean(activeModel?.input?.includes('image'));
  const fileInput=useRef<HTMLInputElement>(null);
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
  const [changingConversation,setChangingConversation]=useState(false);
  const [deleteConversationError,setDeleteConversationError]=useState<string|null>(null);
  const controlsBusy=busy||modelingPending||stopWaiting||transferring||changingConversation;
  const [connectionPhase,setConnectionPhase]=useState<PiConnectionPhase>('connecting');
  const [approvalBinding,setApprovalBinding]=useState<PiApprovalBinding|null>(null);
  const connected=connectionPhase==='online',connecting=connectionPhase==='connecting'||connectionPhase==='synchronizing';
  const [connectionNotice,setConnectionNotice]=useState<string|null>(null);
  const [ownershipBinding,setOwnershipBinding]=useState<{sessionId:string;documentId:string}|null>(null);
  const ownerRecovery=ownershipBinding?.documentId===documentId?ownershipBinding:null;
  const [error, setError] = useState<string | null>(null);
  const [pane,setPane]=useState<'history'|'settings'|null>(null);
  const [history, setHistory] = useState<PiConversation[] | null>(null);
  const [deleteCandidate,setDeleteCandidate]=useState<PiConversation|null>(null);
  const availableHistory=history?.filter(item=>!item.deleted)||[];
  const deletedHistory=history?.filter(item=>item.deleted)||[];
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
      setMessages([]);setModels([]);setSelectedModel('');setActiveModel(undefined);setHistory(null);setDeleteCandidate(null);setPane(null);setUnread(false);setConnectionNotice(null);
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
        setApprovalBinding(phase==='online'?connection.getApprovalBinding():null);
        if(phase==='offline'||phase==='interrupted'){
          setHistory(null);
          setBusy(false);setQueued(0);nativeBusy.current={streaming:false,compacting:false};
          setMessages(current=>current.map(item=>['running','streaming'].includes(item.status||'')?{...item,status:'interrupted'}:item));
        }
      },
      onNotice:setConnectionNotice,
      onSnapshot:snapshot=>{
        setMessages(flattenMessages(snapshot.messages));setModels(snapshot.models as PiModel[]);setError(null);setConnectionNotice(null);
        const selected=snapshot.state.model as PiModel|undefined;
        setActiveModel(selected?.id&&selected.provider?selected:undefined);
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

  const attach = async (files: File[]) => {
    if(!files.length || !modelAcceptsImages || readingImage.current)return;
    const owner=connectionRef.current;
    readingImage.current=documentId;setReadingDocument(documentId);
    try{
      let bytes=attached.reduce((size,item)=>size+item.bytes,0);
      const additions: Attachment[]=[];
      for(const file of files){
        if(!piImageType(file.type)||file.size===0)throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。');
        bytes+=file.size;
        if(bytes>imageBudget||attached.length+additions.length>=4)throw new Error('每条消息最多 4 张图片，合计不超过 680 KiB。');
        additions.push(await readPiImage(file,file.type));
      }
      setImageDrafts(current=>({...current,[documentId]:[...(current[documentId]||[]),...additions]}));
      if(owner===connectionRef.current)setError(null);
    }catch(reason){if(owner===connectionRef.current)setError(reason instanceof Error?reason.message:'读取图片失败。');}
    finally{readingImage.current=null;setReadingDocument(null);}
  };

  const submit = async () => {
    const message = input.trim();
    if ((!message && !attached.length) || !connected || changingConversation || readingImage.current) return;
    if(message==='/stop'){setInput('');await stopRef.current?.stop();return;}
    if(transferring||modelingController.hasWorkspaceTransfer()||stopWaiting||modelingPending&&!busy)return;
    if(['/compact','/new'].includes(message)&&controlsBusy){setError('请等待当前 Pi 与建模任务结束后，再压缩或新建会话。');return;}
    if(message==='/new'){await newSession();return;}
    if(attached.length&&!modelAcceptsImages){setError('请切换到支持图片的模型，或移除附件。');return;}
    const wasBusy = busy;
    const owner=connectionRef.current;
    const images=attached.map(item=>item.image);
    stopRef.current?.reset();
    showLatest();
    setInput(""); setError(null);setConnectionNotice(null); setBusy(true);
    const pendingId=`user-${crypto.randomUUID()}`;
    setMessages((current) => [...current, { id:pendingId, role: "user", content: message, images }]);
    try {
      const context = [`当前工程 documentId=${documentId}，revision=${revision ?? "unknown"}。`, activeSelection ? `当前选择=${activeSelection.kind} ${activeSelection.bodyId}${activeSelection.topologyId ? ` / ${activeSelection.topologyId}` : ""}。` : "当前没有选择几何。", "先通过 query_model 检查现状，按用户意图讨论方案或使用 CAD MCP 工具实施。"].join("\n");
      if (message === "/compact") { await owner?.request({ type: "compact" });if(owner!==connectionRef.current)return;await owner?.refresh();if(owner===connectionRef.current)setBusy(false);return; }
      await sendCommand({ type: "prompt", message: message.startsWith("/") ? message : `${context}\n\n用户请求：${message||'请查看附件图片。'}`, ...(images.length ? {images} : {}), ...(wasBusy ? { streamingBehavior } : {}) });
      if(images.length)setImageDrafts(current=>({...current,[documentId]:(current[documentId]||[]).filter(item=>!attached.includes(item))}));
      if (wasBusy) await refreshModels();
    } catch (reason) {setInput(current=>current||message);if(owner!==connectionRef.current)return;setMessages(current=>current.filter(item=>item.id!==pendingId));setBusy(false);setError(reason instanceof Error ? reason.message : "发送失败");}
  };

  const chooseModel = async (value: string) => {
    const slash = value.indexOf("/");
    if (slash < 1) return;
    try { await sendCommand({ type: "set_model", provider: value.slice(0, slash), modelId: value.slice(slash + 1) }); await refreshModels(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "模型切换失败"); }
  };

  const openPane = (next: 'history'|'settings') => {
    if(pane===next){setPane(null);return;}
    if(next==='history')setHistory(null);
    setPane(next);setError(null);
  };

  useEffect(()=>{
    if(pane!=='history'||!connected)return;
    let cancelled=false;
    void sendCommand({type:'list_conversations'}).then(({data})=>{
      if(!cancelled)setHistory(data?.conversations as PiConversation[]);
    }).catch(reason=>{
      if(!cancelled){setHistory([]);setError(reason instanceof Error?reason.message:'无法读取历史对话。');}
    });
    return()=>{cancelled=true;};
  },[pane,connected,documentId,sendCommand]);

  const changeConversation = async (id?: string) => {
    const owner=connectionRef.current;
    setChangingConversation(true);setError(null);
    try {
      await sendCommand(id?{ type:'resume_conversation',conversationId:id }:{ type:'new_session' });
      if(owner!==connectionRef.current)return;
      if(input.trim()==='/new')setInput('');
      showLatest();await refreshMessages();setPane(null);setHistory(null);
    } catch (reason) { if(owner===connectionRef.current)setError(reason instanceof Error ? reason.message : '无法切换会话。'); }
    finally{setChangingConversation(false);}
  };
  const newSession = () => changeConversation();

  const changeConversationDeletion = async (target: PiConversation, deleting: boolean) => {
    if(controlsBusy||!connected)return;
    const owner=connectionRef.current;
    setChangingConversation(true);setError(null);
    let deleted = false;
    try{
      await sendCommand({type:deleting?'delete_conversation':'restore_conversation',conversationId:target.id});
      deleted = deleting;
      if(owner!==connectionRef.current)return;
      if(deleting&&target.active)await refreshMessages();
      const {data}=await sendCommand({type:'list_conversations'});
      if(owner!==connectionRef.current)return;
      setHistory(data?.conversations as PiConversation[]);
    }catch(reason){
      if(owner!==connectionRef.current)return;
      const message=reason instanceof Error?reason.message:'操作结果未确认，请重新打开历史对话核对。';
      if(deleting&&!deleted)setDeleteConversationError(message);
      else setError(deleted?`对话已删除，但历史列表未刷新。请重新打开历史对话核对。 ${message}`:message);
    }
    finally{
      if(deleted||owner!==connectionRef.current)setDeleteCandidate(null);
      setChangingConversation(false);
    }
  };

  const applyConfiguration = async (providerId?: string) => {
    const owner=connectionRef.current;
    const binding=owner?.getApprovalBinding();
    if(!owner||!binding)throw new Error('请先连接 Pi 会话。');
    const response=await fetch(`${API_ROOT}/pi/sessions/${encodeURIComponent(binding.sessionId)}/configuration`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...binding,providerId}),signal:AbortSignal.timeout(65000),
    });
    const result=await response.json();
    if(!response.ok||!result.ok)throw new Error(result.error||'无法应用 Pi 配置。');
    if(owner!==connectionRef.current)throw new Error('已切换工程，请重新打开助手。');
    await owner.open();
  };

  const showRecovery = () => {
    const sessionId=connectionRef.current?.getBinding().sessionId||`webcad-${documentId}`;
    setPane(null);
    setOwnershipBinding({sessionId,documentId});
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
      <button type="button" aria-expanded={pane==='history'} disabled={transferring} onClick={()=>openPane('history')}>历史对话</button>
      <button type="button" title="新建 Pi 会话" disabled={!connected || controlsBusy} onClick={() => void newSession()}>新会话</button>
      <button type="button" aria-expanded={pane==='settings'} onClick={()=>openPane('settings')}>设置</button>
    </div>
    {pane==='history'&&<section className="pi-agent-options" aria-label="Pi 历史对话">
      {!connected?<p>连接 Pi 后可查看并恢复历史对话。</p>:history===null?<p role="status">正在读取历史对话…</p>:!availableHistory.length?<p>历史对话列表为空。</p>:
        <ul>{availableHistory.map(item=><li key={item.id}>
          <div><strong title={item.title}>{item.title||'未命名对话'}</strong><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString('zh-CN')}</time></div>
          <button type="button" disabled={item.active||controlsBusy} onClick={()=>void changeConversation(item.id)}>{item.active?'当前':'恢复对话'}</button>
          <button type="button" className="pi-history-delete" disabled={controlsBusy} onClick={()=>{setDeleteConversationError(null);setDeleteCandidate(item);}}>删除</button>
        </li>)}</ul>}
      {connected&&deletedHistory.length>0&&<details>
        <summary>已删除对话（{deletedHistory.length}）</summary>
        <ul>{deletedHistory.map(item=><li key={item.id}>
          <div><strong title={item.title}>{item.title||'未命名对话'}</strong><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString('zh-CN')}</time></div>
          <button type="button" disabled={controlsBusy} onClick={()=>void changeConversationDeletion(item,false)}>恢复到历史</button>
        </li>)}</ul>
      </details>}
      <button type="button" onClick={showRecovery}>会话归属与备份</button>
      {deleteCandidate&&<WorkbenchDialog title="删除历史对话" busy={changingConversation} onCancel={()=>setDeleteCandidate(null)} actions={<>
        <button type="button" data-initial-focus onClick={()=>setDeleteCandidate(null)}>{deleteConversationError?'关闭':'取消'}</button>
        <button type="button" className="feature-delete-confirm" disabled={controlsBusy||!connected||!!deleteConversationError} onClick={()=>void changeConversationDeletion(deleteCandidate,true)}>确认删除对话</button>
      </>}>
        <p><strong>{deleteCandidate.title||'未命名对话'}</strong></p>
        <p>对话和图片将移入「已删除对话」，可从那里恢复。</p>
        {deleteCandidate.active&&<p>删除当前对话后会进入新会话。</p>}
        {deleteConversationError&&<p className="property-error" role="alert">{deleteConversationError} 关闭弹窗后，请重新打开历史对话核对状态。</p>}
      </WorkbenchDialog>}
    </section>}
    {pane==='settings'&&<div className="pi-agent-options"><AgentProviderSettingsPanel activeModel={activeModel} disabled={controlsBusy||!connected} onApply={applyConfiguration}/></div>}
    <div ref={logRef} className="pi-agent-messages" aria-live="polite" onScroll={event => {
      followMessages.current = isNearPiConversationEnd(event.currentTarget);
      if (followMessages.current) setUnread(false);
    }}>
      {ownerRecovery&&<PiSessionOwnershipPanel key={`${documentId}:${ownerRecovery.sessionId}`} sessionId={ownerRecovery.sessionId} documentId={documentId} disabled={controlsBusy||transferring} onClose={()=>setOwnershipBinding(null)} onConnected={connectReviewedSession}/>}
      {!messages.length&&!ownerRecovery && <div className="pi-agent-empty"><strong>描述建模目标，或与 Pi Agent 讨论方案</strong><span>工具和思考默认折叠，点击查看详情。建模结果同步到当前工程。</span></div>}
      {messages.map((item) => <article key={item.id} className={`pi-agent-message ${item.role === "user" ? "user" : item.role === "tool" ? "tool" : item.role === "system" ? "system" : "assistant"}`}>
        <div className="pi-agent-message-meta"><span>{item.role === "user" ? "你" : item.role === "tool" ? item.toolName || "CAD MCP" : item.role === "system" ? "系统" : "Pi Agent"}</span><button type="button" onClick={() => void copy(item)} aria-label="复制消息">{copyId === item.id ? "已复制" : "复制"}</button></div>
        {item.role === "tool" || item.role === "thinking" ? <PiMessageDetails item={item} onOpen={()=>{followMessages.current=false;}}/> : <div className="pi-agent-message-content">{item.content}</div>}
        {/* eslint-disable-next-line @next/next/no-img-element -- native Pi history already contains the inline image. */}
        {item.images?.length ? <div className="pi-agent-images">{item.images.map((image,index)=><img key={index} src={piImageUrl(image)} alt={`消息图片 ${index+1}`} loading="lazy"/>)}</div> : null}
      </article>)}
      {busy && !messages.some((item) => item.role === "assistant" && item.status === "streaming") && <div className="pi-agent-thinking">Pi Agent 正在运行<span>…</span></div>}
    </div>
    {unread && <button type="button" className="pi-agent-show-latest" onClick={showLatest}>有新消息 · 回到最新 ↓</button>}
    {connected && approvalBinding?.documentId===documentId && <PiWriteApprovalCard key={approvalBinding.streamId} {...approvalBinding} disabled={transferring||stopWaiting}/>}
    {connectionNotice&&!ownerRecovery&&<p className="pi-agent-connection-note" role="status">{connectionNotice}</p>}
    {currentStop?.notice&&<div className="pi-agent-connection-note pi-agent-stop-note" role="status" data-testid="pi-stop-status" data-phase={currentStop.phase}><span>{currentStop.notice}</span>{['uncertain','refreshing'].includes(currentStop.phase)&&<button type="button" disabled={!connected||currentStop.phase==='refreshing'} onClick={()=>void stopRef.current?.check()}>{currentStop.phase==='refreshing'?'检查中':'检查停止状态'}</button>}</div>}
    {error && <div className="pi-agent-error" role="alert">{error}</div>}
    {!connected && !connecting&&!ownerRecovery && <button type="button" onClick={() => setReconnect((value) => value + 1)}>重新连接已有会话</button>}
    <form className="pi-agent-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <input ref={fileInput} type="file" hidden multiple aria-label="选择图片" accept={PI_IMAGE_TYPES.join(',')} onChange={event=>{const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value='';void attach(files);}} />
      {attached.length>0&&<div className="pi-agent-images">{attached.map(item=><div key={item.id}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local attachment preview before submission. */}
        <img src={piImageUrl(item.image)} alt={item.name}/><button type="button" aria-label={`移除图片 ${item.name}`} disabled={readingDocument===documentId} onClick={()=>setImageDrafts(current=>({...current,[documentId]:(current[documentId]||[]).filter(value=>value.id!==item.id)}))}>×</button>
      </div>)}</div>}
      <textarea aria-label="发送给 Pi Agent" placeholder="讨论方案，或描述要创建、修改的几何…" value={input} onChange={(event) => setInput(event.target.value)} onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.some(file=>file.type.startsWith('image/'))){event.preventDefault();if(modelAcceptsImages)void attach(files);else setError('当前模型不支持图片，请在设置中切换模型。');}}} onKeyDown={(event) => { if (shouldSubmitPiMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) { event.preventDefault(); void submit(); } }} disabled={!connected || connecting||transferring||stopWaiting||changingConversation||modelingPending&&!busy} />
      <div className="pi-agent-composer-footer"><button type="button" title={modelAcceptsImages?'选择图片，也可以粘贴截图':'当前模型不支持图片'} disabled={!connected||!modelAcceptsImages||transferring||stopWaiting||changingConversation||readingDocument!==null} onClick={()=>fileInput.current?.click()}>添加图片</button><span>{transferring?'工程切换中 · 原会话保留':stopWaiting?'停止中 · 请查看建模任务终态':modelingPending&&!busy?'建模任务尚未结束':attached.length&&!modelAcceptsImages?'当前模型不支持图片':queued ? `${queued} 条待处理` : "Enter 发送 · Shift+Enter 换行"}</span>{(busy||stopWaiting) && <><select aria-label="Pi 运行中消息方式" disabled={stopWaiting} value={streamingBehavior} onChange={event => setStreamingBehavior(event.target.value as "steer" | "followUp")}><option value="steer">引导当前任务</option><option value="followUp">完成后继续</option></select><button type="button" disabled={stopWaiting} onClick={() => void stopRef.current?.stop()}>{stopWaiting?'正在停止':'停止'}</button></>}<button type="submit" disabled={(!input.trim()&&!attached.length)||Boolean(attached.length&&!modelAcceptsImages)||!connected||transferring||stopWaiting||changingConversation||readingDocument!==null||modelingPending&&!busy}>{busy ? "追加" : "发送"}</button></div>
    </form>
  </section>;
}
