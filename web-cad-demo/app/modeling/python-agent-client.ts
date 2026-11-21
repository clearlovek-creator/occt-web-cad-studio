import type { ModelingAgentPlan, ModelingAgentQuestion } from "./modeling-agent.ts";
import type { ModelingCommandResponse } from "./command-contract.ts";

export type PythonAgentStatus = {
  id?: string;
  run_id: string;
  project_id: string;
  document_id: string;
  user_id: string;
  status: string;
  current_stage?: string;
  actions?: Array<{ action_id?: string; task_id?: string; title?: string; tool_name?: string; arguments?: Record<string, unknown>; expected_document_revision?: number | null; risk_level?: string; reason?: string; status?: string; approval_group?: string; depends_on?: string[]; success_criteria?: Array<Record<string, unknown>> }>;
  progress?: { stage_index?: number; stage_count?: number; stage_percent?: number; completed_actions?: number; total_actions?: number; action_percent?: number };
  run_version?: number;
  document_revision?: number;
  waiting_request_id?: string | null;
  waiting_approval_id?: string | null;
  pending_input?: { request_id?: string; question?: string; expected_schema?: { fields?: string[] } } | null;
  pending_approval?: { approval_id?: string; summary?: string; impact?: string[] } | null;
  pending_action?: { action_id?: string; tool_name?: string; arguments?: Record<string, unknown>; expected_document_revision?: number | null; risk_level?: string; reason?: string } | null;
  latest_observation?: { success?: boolean; result?: Record<string, unknown>; after_revision?: number | null; error_code?: string | null } | null;
  last_error?: Record<string, unknown> | null;
  [key: string]: unknown;
};

type RequestOptions = { method?: string; body?: unknown; headers?: Record<string, string>;timeoutMs?:number };

type PythonAgentRun = {
  status: PythonAgentStatus;
  responseAction: "created" | "responded" | "approved" | "observed";
};
type PythonCreation={client_run_id:string;project_id:string;document_id:string;user_id:string;message:string;template_id:null;autonomy_level:'supervised'};
type PythonPending={runId:string;kind:'create'|'response'|'approval';creation?:PythonCreation;runVersion?:number};
export type PythonAgentRecovery={version:1;documentId:string;run:PythonAgentStatus|null;pending:PythonPending|null;unconfirmed?:boolean};
type PythonOwner={documentId:string;generation:number};
const terminal=(status:string)=>['completed','failed','cancelled'].includes(status);
const runIdPattern=/^[A-Za-z0-9_-]{1,100}$/;
const statuses=new Set(['created','running','waiting_user','waiting_approval','waiting_external','completed','failed','cancelled','paused']);
const copyStatus=(status:PythonAgentStatus)=>JSON.parse(JSON.stringify(status)) as PythonAgentStatus;
export class PythonAgentClientError extends Error{
  readonly code:string;readonly status:number;
  constructor(code:string,message:string,status=409){super(message);this.name='PythonAgentClientError';this.code=code;this.status=status;}
}

export class PythonAgentClient {
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly projectId: string;
  private readonly userId: string;
  private activeRunId: string | null = null;
  private activeStatus: PythonAgentStatus | null = null;
  private documentId = "default";
  private generation=0;
  private inFlight:PythonOwner|null=null;
  private pendingRequest:PythonPending|null=null;
  private refreshPromise:Promise<PythonAgentStatus|null>|null=null;
  private recoveryInvalid=false;
  private lastStatus:PythonAgentStatus|null=null;
  private readonly onChange:()=>void;
  private readonly beforeMutation:()=>void;

  constructor(root: string, fetchImpl: typeof fetch, projectId = "web-demo", userId = "web-user",onChange:()=>void=()=>{},beforeMutation:()=>void=()=>{}) {
    this.root = root.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.projectId = projectId;
    this.userId = userId;
    this.onChange=onChange;
    this.beforeMutation=beforeMutation;
  }

  private owner():PythonOwner{return {documentId:this.documentId,generation:this.generation};}
  private assertOwner(owner:PythonOwner){if(owner.documentId!==this.documentId||owner.generation!==this.generation)throw new PythonAgentClientError('PYTHON_AGENT_DOCUMENT_CHANGED','原 Python 请求属于其他工作区，未采用迟到结果或继续请求。');}
  private checkedStatus(value:unknown,owner:PythonOwner,runId?:string,creation?:PythonCreation):PythonAgentStatus{
    this.assertOwner(owner);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new PythonAgentClientError('PYTHON_AGENT_PROTOCOL','Python 状态响应无效，未继续执行。',502);
    const status={...value} as PythonAgentStatus;if(!status.run_id&&typeof status.id==='string')status.run_id=status.id;
    if(!runIdPattern.test(status.run_id)||runId!==undefined&&status.run_id!==runId||status.document_id!==owner.documentId||status.project_id!==this.projectId||status.user_id!==this.userId||!statuses.has(status.status)||!Number.isSafeInteger(status.run_version)||Number(status.run_version)<0||status.document_revision!==undefined&&(!Number.isSafeInteger(status.document_revision)||Number(status.document_revision)<0))throw new PythonAgentClientError('PYTHON_AGENT_SCOPE_MISMATCH','Python 状态不属于原工程、用户、项目或任务，未采用响应。',502);
    if(creation){const actual=status.client_creation;if(!actual||typeof actual!=='object'||Array.isArray(actual)||Object.keys(actual).length!==Object.keys(creation).length||Object.entries(creation).some(([key,value])=>(actual as Record<string,unknown>)[key]!==value))throw new PythonAgentClientError('PYTHON_AGENT_CREATION_MISMATCH','Python 原创建请求绑定不一致，未采用结果或重新创建。',502);}
    return status;
  }
  private accept(status:PythonAgentStatus,owner:PythonOwner){this.assertOwner(owner);if(this.lastStatus?.run_id===status.run_id){if(Number(this.lastStatus.run_version)>Number(status.run_version))return copyStatus(this.lastStatus);if(this.lastStatus.run_version===status.run_version&&this.lastStatus.status!==status.status)throw new PythonAgentClientError('PYTHON_AGENT_VERSION_CONFLICT','同一 Python 任务版本的状态互相矛盾，未采用响应。',502);}this.lastStatus=copyStatus(status);this.activeRunId=terminal(status.status)?null:status.run_id;this.activeStatus=terminal(status.status)?null:this.lastStatus;this.onChange();return copyStatus(status);}
  getRecoveryState():PythonAgentRecovery{return JSON.parse(JSON.stringify({version:1,documentId:this.documentId,run:this.activeStatus,pending:this.pendingRequest,unconfirmed:this.recoveryInvalid}));}
  restoreRecoveryState(value:PythonAgentRecovery){
    if(this.inFlight)throw new PythonAgentClientError('PYTHON_AGENT_BUSY','Python 请求尚未完成，不能替换恢复状态。');
    try{
      if(!value||value.version!==1||value.documentId!==this.documentId||value.unconfirmed!==undefined&&typeof value.unconfirmed!=='boolean')throw Error('scope');
      const status=value.run?this.checkedStatus(value.run,this.owner()):null,pending=value.pending;
      if(pending&&(!runIdPattern.test(pending.runId)||!['create','response','approval'].includes(pending.kind)||status&&status.run_id!==pending.runId||pending.kind!=='create'&&(!Number.isSafeInteger(pending.runVersion)||Number(pending.runVersion)<0)||pending.kind==='create'&&(!pending.creation||!/^py-run-[a-f0-9-]{36}$/.test(pending.runId)||pending.creation.client_run_id!==pending.runId||pending.creation.document_id!==this.documentId||pending.creation.project_id!==this.projectId||pending.creation.user_id!==this.userId||typeof pending.creation.message!=='string'||pending.creation.message.length>16000||pending.creation.template_id!==null||pending.creation.autonomy_level!=='supervised'||Object.keys(pending.creation).length!==7)))throw Error('pending scope');
      this.lastStatus=status?copyStatus(status):null;this.activeStatus=status&&!terminal(status.status)?this.lastStatus:null;this.activeRunId=this.activeStatus?.run_id||null;this.pendingRequest=pending?JSON.parse(JSON.stringify(pending)):null;this.recoveryInvalid=value.unconfirmed===true;
    }catch{this.recoveryInvalid=true;throw new PythonAgentClientError('PYTHON_AGENT_RECOVERY_INVALID','Python 缓存归属或恢复身份无效；保留原材料，未启动新任务。',502);}
  }
  blocksWorkspaceSwitch(){return Boolean(this.inFlight||this.pendingRequest||this.recoveryInvalid||this.activeStatus&&['created','running','waiting_external'].includes(this.activeStatus.status));}
  getOwnerKey(){return `${this.documentId}:${this.generation}`;}
  invalidateRecovery(){this.recoveryInvalid=true;}
  private prepareWrite(value:PythonPending){this.pendingRequest=value;try{this.beforeMutation();}catch{this.pendingRequest=null;throw new PythonAgentClientError('PYTHON_AGENT_RECOVERY_WRITE_FAILED','无法保存 Python 请求的恢复身份，命令尚未发送；请检查浏览器存储。',503);}this.onChange();}

  async run(message: string, confirmed = false): Promise<PythonAgentRun> {
    if(typeof message!=='string'||message.length>16000)throw new PythonAgentClientError('PYTHON_AGENT_MESSAGE_INVALID','Python 消息长度不得超过 16000 字符。',400);
    if(this.inFlight||this.refreshPromise)throw new PythonAgentClientError('PYTHON_AGENT_BUSY','当前 Python 请求尚未完成，未重复发送。');
    if(this.pendingRequest||this.recoveryInvalid)throw new PythonAgentClientError('PYTHON_AGENT_RESULT_UNCONFIRMED','原 Python 请求结果尚未确认，请只读检查原任务；不会自动重发。');
    if(this.activeStatus&&!['waiting_user','waiting_approval'].includes(this.activeStatus.status))throw new PythonAgentClientError('PYTHON_AGENT_BUSY','原 Python 任务尚未到达可输入状态，未创建第二个任务。');
    const owner=this.owner();this.inFlight=owner;
    try{
    let responseAction: PythonAgentRun["responseAction"] = "created";
    let status: PythonAgentStatus;
    if (this.activeStatus?.status === "waiting_user" && this.activeRunId) {
      const requestId = this.activeStatus.waiting_request_id || this.activeStatus.pending_input?.request_id;
      if (!requestId) throw new Error("Python Agent is waiting for input but did not return a request id.");
      const runId=this.activeRunId;this.prepareWrite({runId,kind:'response',runVersion:this.activeStatus.run_version});
      status = await this.request(`/runs/${encodeURIComponent(runId)}/responses`,owner,runId, {
        method: "POST",
        body: { request_id: requestId, response: message, expected_run_version: this.activeStatus.run_version },
      });
      responseAction = "responded";
    } else if (this.activeStatus?.status === "waiting_approval" && this.activeRunId) {
      if (!confirmed) return { status: copyStatus(this.activeStatus), responseAction: "observed" };
      const approvalId = this.activeStatus.waiting_approval_id || this.activeStatus.pending_approval?.approval_id;
      if (!approvalId) throw new Error("Python Agent is waiting for approval but did not return an approval id.");
      const runId=this.activeRunId;this.prepareWrite({runId,kind:'approval',runVersion:this.activeStatus.run_version});
      status = await this.request(`/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/decision`,owner,runId, {
        method: "POST",
        body: { decision: "approve", expected_run_version: this.activeStatus.run_version },
      });
      responseAction = "approved";
    } else {
      const creation:PythonCreation={client_run_id:'py-run-'+crypto.randomUUID(),project_id:this.projectId,document_id:owner.documentId,user_id:this.userId,message,template_id:null,autonomy_level:'supervised'};
      this.prepareWrite({runId:creation.client_run_id,kind:'create',creation});
      status = await this.request("/runs",owner,creation.client_run_id, {
        method: "POST",
        body: creation,
      },creation);
    }
    this.assertOwner(owner);this.pendingRequest=null;status=this.accept(status,owner);
    // Response/approval endpoints return the bare Run model. Refresh through
    // the status endpoint so the browser receives pending_action,
    // pending_approval and latest_observation consistently.
    status = await this.request(`/runs/${encodeURIComponent(status.run_id)}`,owner,status.run_id);
    status = await this.waitForBoundary(status,owner);status=this.accept(status,owner);
    return { status, responseAction };
    }catch(error){this.assertOwner(owner);if(this.pendingRequest){try{const recovered=await this.readOriginal(owner);if(recovered)return {status:recovered,responseAction:'observed'};}catch{/* Preserve the exact pending identity; no POST retry. */}this.assertOwner(owner);throw new PythonAgentClientError('PYTHON_AGENT_RESULT_UNCONFIRMED','Python 原请求结果尚未确认；可只读检查原任务，不会重复发送创建、回答或审批。',503);}throw error;}
    finally{if(this.inFlight===owner){this.inFlight=null;this.onChange();}}
  }

  setDocumentId(documentId: string) {
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(documentId))throw new PythonAgentClientError('PYTHON_AGENT_DOCUMENT_INVALID','Python 工程身份无效。',400);
    if(documentId===this.documentId)return;
    this.generation++;this.activeRunId=null;this.activeStatus=null;this.lastStatus=null;this.pendingRequest=null;this.inFlight=null;this.refreshPromise=null;this.recoveryInvalid=false;
    this.documentId = documentId;
  }

  clear() {
    if(this.inFlight||this.pendingRequest||this.recoveryInvalid||this.activeStatus)throw new PythonAgentClientError('PYTHON_AGENT_BUSY','原 Python 任务仍存在或结果未确认，不能通过清空会话遗忘任务。');
    this.generation++;
    this.lastStatus=null;this.refreshPromise=null;
    this.activeRunId = null;
    this.activeStatus = null;
  }

  getActiveStatus() {
    return this.activeStatus?copyStatus(this.activeStatus):null;
  }

  restoreStatus(status: PythonAgentStatus | null) {
    this.restoreRecoveryState({version:1,documentId:this.documentId,run:status,pending:null});
  }

  refreshActiveRun():Promise<PythonAgentStatus|null> {
    if(this.refreshPromise)return this.refreshPromise;
    const owner=this.owner(),pending=this.readOriginal(owner);this.refreshPromise=pending;
    void pending.finally(()=>{if(this.refreshPromise===pending)this.refreshPromise=null;}).catch(()=>{});return pending;
  }
  private async readOriginal(owner:PythonOwner){
    const pending=this.pendingRequest,runId=pending?.runId||this.activeRunId;if(!runId)return null;
    try{const status=await this.request(`/runs/${encodeURIComponent(runId)}`,owner,runId,{},pending?.creation);this.assertOwner(owner);if(pending&&this.pendingRequest===pending&&pending.kind!=='create'&&Number(status.run_version)<=Number(pending.runVersion))throw new PythonAgentClientError('PYTHON_AGENT_RESULT_UNCONFIRMED','Python 任务仍是提交前版本，不能据此判断请求未执行；未重发原请求。');const accepted=this.accept(status,owner);if(this.pendingRequest===pending)this.pendingRequest=null;this.recoveryInvalid=false;this.onChange();return accepted;}
    catch(error){if(owner.documentId===this.documentId&&owner.generation===this.generation&&(this.activeRunId===runId||this.pendingRequest)){this.recoveryInvalid=true;this.onChange();}throw error;}
  }

  private async waitForBoundary(initial: PythonAgentStatus,owner:PythonOwner): Promise<PythonAgentStatus> {
    let status = initial;
    const deadline=performance.now()+30000;
    for (let attempt = 0; attempt < 120 && status.status === "running"&&performance.now()<deadline; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.assertOwner(owner);const left=Math.floor(deadline-performance.now());if(left<=0)break;status = this.accept(await this.request(`/runs/${encodeURIComponent(status.run_id)}`,owner,status.run_id,{timeoutMs:left}),owner);
    }
    if (status.status === "running") throw new PythonAgentClientError('PYTHON_AGENT_STILL_RUNNING','Python 任务仍在运行，已暂停页面轮询；可只读核对原任务，不会重新创建。',503);
    return status;
  }

  private async request(path: string,owner:PythonOwner,runId:string,options: RequestOptions = {},creation?:PythonCreation): Promise<PythonAgentStatus> {
    this.assertOwner(owner);
    const query=options.method==='POST'?'':`?project_id=${encodeURIComponent(this.projectId)}&document_id=${encodeURIComponent(owner.documentId)}&user_id=${encodeURIComponent(this.userId)}`;
    const response = await this.fetchImpl(`${this.root}${path}${query}`, {
      method: options.method || "GET",
      headers: { Accept: "application/json", ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal:AbortSignal.timeout(options.method==='POST'?30000:Math.max(1,Math.min(options.timeoutMs??5000,5000))),
    });
    this.assertOwner(owner);const reader=response.body?.getReader();if(!reader)throw new PythonAgentClientError('PYTHON_AGENT_PROTOCOL','Python 响应为空，原请求不会重发。',502);
    const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const part=await reader.read();this.assertOwner(owner);if(part.done)break;bytes+=part.value.byteLength;if(bytes>4*1024*1024){void reader.cancel().catch(()=>{});throw new PythonAgentClientError('PYTHON_AGENT_RESPONSE_LIMIT','Python 响应超过 4 MiB，原请求结果需核对。',502);}chunks.push(part.value);}}finally{reader.releaseLock();}
    const all=new Uint8Array(bytes);let at=0;for(const part of chunks){all.set(part,at);at+=part.byteLength;}let payload;
    try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{throw new PythonAgentClientError('PYTHON_AGENT_PROTOCOL','Python 响应不是有效 JSON；原请求不会重发。',502);}
    if(!response.ok)throw new PythonAgentClientError('PYTHON_AGENT_HTTP',typeof payload?.detail==='string'?payload.detail:typeof payload?.error==='string'?payload.error:`Python Agent request failed with HTTP ${response.status}.`,response.status);
    return this.checkedStatus(payload,owner,runId,creation);
  }
}

function operationForTool(toolName: string) {
  return toolName === "geometry.create_box" ? "primitive.box" : toolName;
}

export function pythonPlanFromStatus(status: PythonAgentStatus, prompt: string): ModelingAgentPlan | null {
  if (status.status !== "waiting_user" && status.status !== "waiting_approval") return null;
  const action = status.pending_action;
  const steps = action?.tool_name ? [{
    id: action.action_id || `action-${status.run_id}`,
    operation: operationForTool(action.tool_name) as ModelingAgentPlan["steps"][number]["operation"],
    request: {
      operation: operationForTool(action.tool_name),
      baseRevision: action.expected_document_revision ?? status.document_revision,
      parameters: action.arguments || {},
    },
    status: "ready" as const,
    selection: "none" as const,
    risk: "confirmation" as const,
    explanation: status.pending_approval?.summary || action.reason || "Python LangGraph Agent generated a supervised modeling action.",
  }] : [];
  const pending = status.pending_input;
  const questions: ModelingAgentQuestion[] = pending?.question ? [{
    questionId: pending.request_id || status.waiting_request_id || undefined,
    fieldPath: (pending.expected_schema?.fields || ["requirements"]).join(","),
    prompt: pending.question,
  }] : [];
  return {
    planId: `python-${status.run_id}`,
    prompt,
    source: "python-langgraph",
    providerId: "python-langgraph",
    model: "LangGraph",
    protocol: "python-api",
    allowed: true,
    status: status.status === "waiting_user" ? "needs-input" : "ready",
    steps,
    questions,
    summary: status.pending_approval?.summary || pending?.question || "Python LangGraph Agent has prepared a supervised modeling action.",
  };
}

export function pythonResultFromStatus(status: PythonAgentStatus): ModelingCommandResponse | null {
  const observation = status.latest_observation;
  if (status.status !== "completed" || !observation?.success) return null;
  const raw = observation.result && typeof observation.result === "object" ? { ...observation.result } : {};
  const nested = raw.result && typeof raw.result === "object" ? raw.result as Record<string, unknown> : {};
  const result: Record<string, unknown> = { ...nested, ...raw };
  result.ok = true;
  result.documentId = status.document_id;
  result.revision = observation.after_revision ?? status.document_revision;
  return result as ModelingCommandResponse;
}

export function pythonStatusText(status: PythonAgentStatus) {
  if (status.status === "waiting_user") return status.pending_input?.question || "Python Agent is waiting for more requirements.";
  if (status.status === "waiting_approval") return status.pending_approval?.summary || "Python Agent is waiting for approval before writing geometry.";
  if (status.status === "completed") return "Python LangGraph Agent completed the modeling workflow.";
  if (status.status === "failed") return String(status.last_error?.detail || status.last_error?.code || "Python Agent failed.");
  return `Python Agent status: ${status.status}`;
}
