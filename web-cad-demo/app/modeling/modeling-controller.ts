import { useSyncExternalStore } from "react";
import type {DocumentLoadState} from './document-load';
import { AGENT_API_ROOT, AGENT_BACKEND, API_ROOT, type ModelingAgentBackend } from "../api-config.ts";
import type { ModelingAgentContext, ModelingAgentMode, ModelingAgentPlan } from "./modeling-agent.ts";
import { PythonAgentClient, PythonAgentClientError, pythonPlanFromStatus, pythonResultFromStatus, pythonStatusText, type PythonAgentStatus, type PythonAgentRecovery } from "./python-agent-client.ts";
import {activeStepImport,normalizeStepImportStatus,stepImportReport,type StepImportStatus} from '../../shared/step-import-status.mjs';
import {modelingTaskTerminal, type ModelingTaskStatus} from '../../shared/modeling-task-status.mjs';
import {ModelingTaskClient,ModelingTaskClientError,canTrackModelingTask,modelingTaskSourceDocument,modelingTaskTouchesDocument,type ModelingTaskObservation} from './modeling-task-client.ts';
import {normalizeProjectCreateInput} from '../../shared/project-create-input.mjs';
import {assertPiWorkspaceIdle} from './pi-workspace-activity.ts';
import {normalizeWorkspaceActivation,normalizeWorkspaceActivationProof} from '../../shared/workspace-activation.mjs';
import {normalizeWorkspaceRead,normalizeWorkspaceReadProof} from '../../shared/workspace-read.mjs';
import {type ProjectOpenInput} from '../../shared/project-open-input.mjs';
import {type ProjectSaveInput} from '../../shared/project-save-input.mjs';
import {ProjectBackupReadError,readProjectBackup} from './project-backup-read.ts';
import {listStoredProjectBackups,getStoredProjectBackup,deleteStoredProjectBackup} from './project-backup-catalog-client.ts';
import {BackupMaintenanceClient} from './project-backup-maintenance-client.ts';
import {normalizeBackupMaintenance,type BackupMaintenanceRecord} from '../../shared/project-backup-maintenance.mjs';
import {
  createRequestId,
  normalizeCommandRequest,
  type ModelingCommandErrorPayload,
  type ModelingCommandInput,
  type ModelingBatchRequest,
  type ModelingStepImportRequest,
  type ModelingCommandResponse,
  type ModelingHistoryState,
  type ModelingSelection,
} from "./command-contract.ts";

export type AgentProviderSummary = { id: string; name: string; baseUrl: string; model: string; protocol: "auto" | "responses" | "chat-completions"; priority?: number; toolCalling?: boolean; enabled: boolean; apiKeyConfigured: boolean };
export type AgentProviderInput = Omit<AgentProviderSummary, "apiKeyConfigured"> & { apiKey?: string };
export type AgentResourceSummary = { id: string; name: string; kind: "skill" | "knowledge"; bytes: number; updatedAt: string };
export type AgentConversationEntityRef = { kind: string; id: string; label?: string };
export type AgentConversationMessage = { id: string; role: "user" | "assistant" | "system" | "tool"; content: string; createdAt: string; planId?: string; revision?: number; toolCallId?: string; toolName?: string; toolArguments?: Record<string, unknown>; toolResult?: Record<string, unknown>; reasoningContent?: string; entityRefs?: AgentConversationEntityRef[] };
export type AgentConversation = { id: string; documentId: string; title: string; createdAt: string; updatedAt: string; messages: AgentConversationMessage[]; activePlan?: ModelingAgentPlan | null; pendingPrompt?: string | null; pendingToolCall?: Record<string, unknown> | null; contextSummary?: { version?: number; turns?: number; summarizedThroughTurnId?: string | null; text?: string; keyFacts?: string[]; } };
export type AgentConversationSummary = Omit<AgentConversation, "messages"> & { messageCount: number };
export type AgentModelQuery = { kind: "geometry-tree" | "body" | "feature" | "variables" | "coordinates" | "materials" | "history"; bodyId?: string; featureId?: string };
export type WorkspaceMetadata = {documentId:string;name:string;createdAt:string;updatedAt:string;token:string|null;hasChangesSinceExport:boolean;recoverable:boolean;lastGeneratedAt:string|null;recoveryWarning?:string|null;recoveryError?:string|null;load?:DocumentLoadState};
export function workspaceFileName(name?: string) {return `${(name || "工程").replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").replace(/[. ]+$/g,"").slice(0,120)||"工程"}.cadproj`;}

export type AgentRunResult = { status: string; text: string; turns: number; result?: ModelingCommandResponse | null; executed: boolean; plan?: ModelingAgentPlan | null; questions?: ModelingAgentPlan["questions"]; pendingToolCall?: Record<string, unknown> | null };

export type ModelingPlanExecutionState = {
  planId: string;
  mode: "preview" | "commit";
  stepIndex: number;
  totalSteps: number;
  status: "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  lastError?: string;
};

export type ModelingControllerState<TModel = unknown> = {
  documentId: string;
  revision: number | null;
  stateToken: string | null;
  stateSequence: number | null;
  history: ModelingHistoryState | null;
  model: TModel | null;
  currentBodyId: string | null;
  selection: ModelingSelection | null;
  activeOperation: string | null;
  operationWindow: string | null;
  pendingOperation: string | null;
  busy: boolean;
  lastRequestId: string | null;
  error: ModelingCommandErrorPayload | null;
  agentPlan: ModelingAgentPlan | null;
  agentMode: ModelingAgentMode;
  planExecution: ModelingPlanExecutionState | null;
  agentProviders: AgentProviderSummary[];
  agentProviderBusy: boolean;
  agentProviderError: string | null;
  agentResources: AgentResourceSummary[];
  agentResourceBusy: boolean;
  agentResourceError: string | null;
  agentConversation: AgentConversation | null;
  agentConversationList: AgentConversationSummary[];
  agentConversationBusy: boolean;
  agentConversationError: string | null;
  agentModelQuery: Record<string, unknown> | null;
  agentRun: PythonAgentStatus | null;
  commandLog: CommandLogEntry[];
  stepImportStatus:StepImportStatus|null;
  stepImportNotice:string|null;
  modelingTasks:ModelingTaskObservation[];
  modelingTaskNotice:string|null;
};

export class ModelingCommandError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldPath?: string;
  readonly recoverable: boolean;
  readonly requestId?: string;
  readonly details?:Record<string,unknown>;
  readonly modelingTask?:ModelingTaskStatus;

  constructor(payload: ModelingCommandErrorPayload, status: number) {
    super(payload.error || "Geometry command failed.");
    this.name = "ModelingCommandError";
    this.code = payload.code || "COMMAND_FAILED";
    this.status = status;
    this.fieldPath = payload.fieldPath;
    this.recoverable = payload.recoverable !== false;
    this.requestId = payload.requestId;
    this.details=payload.details;
    this.modelingTask=payload.modelingTask;
  }
}

type Listener = () => void;
type WorkspaceTransfer = {
  requestId:string;operation:'project.create'|'project.open'|'project.activate'|'project.save'|'project.backup.download'|'project.backup.delete'|'project.backup.maintenance';sourceDocumentId:string;
  revision:number|null;stateToken:string|null;stateSequence:number|null;targetDocumentId:string;sourceLoaded:boolean;
};
export type CommandLogEntry = {
  requestId: string; documentId: string; operation: string; startedAt: number;
  status: "running" | "success" | "error" | "cancelled"; durationMs?: number; revision?: number;
  code?: string; message?: string; warningCount?: number; warnings?: string[];
};

export type ModelingControllerOptions = {
  apiRoot?: string;
  documentId?: string;
  serverDocumentId?:string;
  fetchImpl?: typeof fetch;
  agentRetryDelayMs?: number;
  agentApiRoot?: string;
  agentBackend?: ModelingAgentBackend;
  projectId?: string;
  userId?: string;
  taskControl?:boolean;
};

type PythonAgentPersistence = {
  conversation?: AgentConversation | null;
  run?: PythonAgentStatus | null;
  recovery?:PythonAgentRecovery;
};

export class ModelingController<TModel = unknown> {
  private readonly apiRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly agentRetryDelayMs: number;
  private readonly agentBackend: ModelingAgentBackend;
  private readonly pythonAgent: PythonAgentClient | null;
  private pythonCacheInvalid=false;
  private pythonConversation: AgentConversation | null = null;
  private state: ModelingControllerState<TModel>;
  private readonly serverState:ModelingControllerState<TModel>;
  private readonly listeners = new Set<Listener>();
  private readonly pendingCommands = new Map<string, string>();
  private readonly taskClient:ModelingTaskClient|null;
  private workspaceTransfer:WorkspaceTransfer|null=null;
  private workspaceEpoch=0;
  private workspaceRead:{documentId:string;epoch:number;promise:Promise<ModelingCommandResponse>;abort:AbortController}|null=null;
  private archiveDownload:{taskId:string;abort:AbortController}|null=null;

  constructor(options: ModelingControllerOptions = {}) {
    this.apiRoot = (options.apiRoot || API_ROOT).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.agentRetryDelayMs = Math.max(0, options.agentRetryDelayMs ?? 1000);
    this.agentBackend = options.agentBackend || AGENT_BACKEND;
    const agentRoot = (options.agentApiRoot || AGENT_API_ROOT || this.apiRoot).replace(/\/+$/, "");
    this.pythonAgent = this.agentBackend === "python" ? new PythonAgentClient(agentRoot, this.fetchImpl, options.projectId, options.userId,()=>{this.persistPythonState();this.update({busy:this.pendingCommands.size>0||Boolean(this.hasPendingMutation())});},()=>{if(typeof window!=='undefined')this.persistPythonState(undefined,true);}) : null;
    this.state = {
      documentId: options.documentId || "default",
      revision: null,
      stateToken: null,
      stateSequence: null,
      history: null,
      model: null,
      currentBodyId: null,
      selection: null,
      activeOperation: null,
      operationWindow: null,
      pendingOperation: null,
      busy: false,
      lastRequestId: null,
      error: null,
      agentPlan: null,
      agentMode: "edit",
      planExecution: null,
      agentProviders: [],
      agentProviderBusy: false,
      agentProviderError: null,
      agentResources: [],
      agentResourceBusy: false,
      agentResourceError: null,
      agentConversation: null,
      agentConversationList: [],
      agentConversationBusy: false,
      agentConversationError: null,
      agentModelQuery: null,
      agentRun: null,
      commandLog: [],
      stepImportStatus:null,
      stepImportNotice:null,
      modelingTasks:[],
      modelingTaskNotice:null,
    };
    this.serverState={...this.state,documentId:options.serverDocumentId||this.state.documentId};
    this.pythonAgent?.setDocumentId(this.state.documentId);
    this.hydratePythonState();
    this.taskClient=options.taskControl?new ModelingTaskClient(this.apiRoot,this.fetchImpl,tasks=>{
      const step=this.state.stepImportStatus,linked=step?tasks.find(item=>item.task.documentId===step.documentId&&item.task.operation==='step.import'&&item.task.requestKey===step.requestId):undefined;
      this.update({modelingTasks:tasks,...(step&&linked?{stepImportStatus:{...step,taskId:linked.task.taskId}}:{}),busy:this.pendingCommands.size>0||tasks.some(item=>modelingTaskTouchesDocument(item,this.state.documentId)&&!modelingTaskTerminal(item.task.phase))||Boolean(step?.documentId===this.state.documentId&&activeStepImport(step.phase))});
    }):null;
  }

  getSnapshot = () => this.state;
  getServerSnapshot = () => this.serverState;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isPythonAgent() { return this.agentBackend === "python"; }

  setSelection(selection: ModelingSelection | null) {
    this.update({ selection, currentBodyId: selection?.bodyId || this.state.currentBodyId });
  }

  setAgentMode(mode: ModelingAgentMode) {
    this.update({ agentMode: mode });
  }
  setActiveOperation(activeOperation: string | null) {
    this.update({ activeOperation, operationWindow: activeOperation });
  }

  adoptModel(model: TModel, revision?: number) {
    if(!this.acceptsState(model as ModelingCommandResponse))return false;
    const nextRevision = revision ?? this.readRevision(model);
    this.update({ model, revision: nextRevision, currentBodyId: this.readBodyId(model),history:(model as {history?:ModelingHistoryState}|null)?.history??this.state.history,...this.readStateStamp(model) });
    return true;
  }

  acceptsState(value: {documentId?:unknown;revision?:unknown;stateSequence?:unknown} | null | undefined) {
    if(!value || (value.documentId && value.documentId!==this.state.documentId))return false;
    if(value.stateSequence!==undefined && (!Number.isSafeInteger(value.stateSequence) || Number(value.stateSequence)<0))return false;
    if(Number.isSafeInteger(value.stateSequence))return this.state.stateSequence===null || Number(value.stateSequence)>=this.state.stateSequence;
    if(this.state.stateSequence!==null)return false;
    return typeof value.revision!=="number" || this.state.revision===null || value.revision>=this.state.revision;
  }
  private readStateStamp(value: unknown) {
    const stamp=value as {stateToken?:string;stateSequence?:number};
    return {...(typeof stamp?.stateToken==="string"?{stateToken:stamp.stateToken}:{}),...(Number.isSafeInteger(stamp?.stateSequence) && stamp.stateSequence!>=0?{stateSequence:stamp.stateSequence!}:{})};
  }
  private acceptResponse(result: ModelingCommandResponse,preserveCurrentBody=false) {
    if(!this.acceptsState(result))return;
    const modelPatch=this.isModelSnapshot(result)?{model:result as unknown as TModel,currentBodyId:preserveCurrentBody?this.state.currentBodyId??this.readBodyId(result as unknown as TModel):this.readBodyId(result as unknown as TModel)}:{};
    this.update({...modelPatch,revision:typeof result.revision==="number"?result.revision:this.state.revision,...this.readStateStamp(result),...(result.history?{history:result.history}:{})});
  }

  confirmPlan() {
    const plan = this.state.agentPlan;
    if (!plan || plan.status !== "awaiting-confirmation") return plan;
    const confirmed = { ...plan, status: "ready" as const, steps: plan.steps.map((step) => ({ ...step, status: "ready" as const })), confirmation: undefined };
    this.update({ agentPlan: confirmed });
    return confirmed;
  }
  async executePlan<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(
    plan: ModelingAgentPlan,
    mode: "preview" | "commit" | "cancel",
    agentMode: ModelingAgentMode = this.state.agentMode,
  ): Promise<TResponse | null> {
    if (mode === "commit" && agentMode === "plan") throw new Error("Plan 模式为只读模式，请切换到 Edit 模式后再执行几何修改。");
    if (mode === "cancel") {
      this.update({ planExecution: { planId: plan.planId, mode: "preview", stepIndex: 0, totalSteps: plan.steps.length, status: "cancelled", attempts: this.state.planExecution?.attempts || 0 }, busy: false, pendingOperation: null });
      this.clearPlan();
      return null;
    }
    if (!plan.steps.length) throw new Error("The modeling plan has no executable steps.");
    if (mode === "commit" && plan.status !== "ready") throw new Error("The modeling plan requires missing inputs or confirmation.");
    let revision = this.state.revision;
    let completed = 0;
    let lastResult: TResponse | null = null;
    const attempts = this.state.planExecution?.planId === plan.planId ? this.state.planExecution.attempts + 1 : 1;
    this.update({ planExecution: { planId: plan.planId, mode, stepIndex: 0, totalSteps: plan.steps.length, status: "running", attempts } });
    try {
      for (let index = 0; index < plan.steps.length; index += 1) {
        const step = plan.steps[index];
        const request: ModelingCommandInput = {
          ...step.request,
          baseRevision: revision ?? step.request.baseRevision,
          options: { ...step.request.options, preview: mode === "preview", agentPlanId: plan.planId, conversationId: this.state.agentConversation?.id },
        };
        lastResult = await this.execute<TResponse>(request);
        completed = index + 1;
        revision = typeof lastResult.revision === "number" ? lastResult.revision : revision;
        this.update({ planExecution: { planId: plan.planId, mode, stepIndex: completed, totalSteps: plan.steps.length, status: "running", attempts } });
      }
      this.update({ planExecution: { planId: plan.planId, mode, stepIndex: completed, totalSteps: plan.steps.length, status: "completed", attempts } });
      return lastResult;
    } catch (error) {
      const originalError = this.state.error;
      if (mode === "commit" && completed > 0) {
        for (let index = 0; index < completed; index += 1) {
          try { await this.execute({ operation: "document.undo" }); } catch { /* preserve the original failure for retry */ }
        }
      }
      this.update({ planExecution: { planId: plan.planId, mode, stepIndex: completed, totalSteps: plan.steps.length, status: "failed", attempts, lastError: error instanceof Error ? error.message : "Plan execution failed." }, error: originalError || this.state.error });
      throw error;
    }
  }

  async streamAgentPlan(prompt: string, context: ModelingAgentContext = {}, providerId?: string, onDelta: (delta: string) => void = () => {}) {
    this.update({ agentProviderBusy: true, agentProviderError: null });
    const requestId = createRequestId("agent-stream");
    const maxAttempts = 3;
    const isRetryable = (error: unknown) => {
      if (error instanceof TypeError) return true;
      const message = error instanceof Error ? error.message : String(error);
      return /fetch failed|network|timed out|timeout|HTTP (?:408|429|5\d\d)\b/i.test(message);
    };
    const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    try {
      let response: Response | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const candidate = await this.fetchImpl(this.apiRoot + "/agent/plan/stream", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Request-Id": requestId }, body: JSON.stringify({ requestId, documentId: this.state.documentId, conversationId: this.state.agentConversation?.id, providerId, prompt, context: { ...context, revision: context.revision ?? this.state.revision, selections: context.selections || (this.state.selection ? [this.state.selection] : []) } }) });
          if (!candidate.ok) {
            const error = new Error("Agent stream failed with HTTP " + candidate.status + ".");
            if (!isRetryable(error)) throw error;
            throw error;
          }
          if (!candidate.body) throw new Error("Agent stream did not return a response body.");
          response = candidate;
          break;
        } catch (error) {
          lastError = error;
          if (!isRetryable(error) || attempt >= maxAttempts - 1) throw error;
          this.update({ agentProviderBusy: true, agentProviderError: "大模型暂时不可用，正在重试 " + (attempt + 1) + "/" + (maxAttempts - 1) + "…" });
          await wait(this.agentRetryDelayMs * (2 ** attempt));
        }
      }
      if (!response) throw (lastError instanceof Error ? lastError : new Error("Agent stream failed."));
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Agent stream did not return a response body.");
      const decoder = new TextDecoder();
      let buffer = "";
      let plan: ModelingAgentPlan | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        for (const event of events) {
          const line = event.split(/\r?\n/).find((item) => item.startsWith("data:"));
          if (!line) continue;
          const payload = JSON.parse(line.slice(5).trim()) as { delta?: string; plan?: ModelingAgentPlan; error?: string };
          if (payload.delta) onDelta(payload.delta);
          if (payload.error) throw new Error(payload.error);
          if (payload.plan) plan = payload.plan;
        }
      }
      if (!plan) throw new Error("Agent stream did not return a plan.");
      this.update({ agentPlan: plan, agentProviderBusy: false, agentProviderError: null });
      return plan;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent streaming failed.";
      this.update({ agentProviderBusy: false, agentProviderError: message });
      throw error;
    }
  }

  private async streamPythonAgentRun(prompt: string, confirmed: boolean, onDelta: (delta: string) => void, onEvent: (event: string, payload: unknown) => void): Promise<AgentRunResult> {
    if (!this.pythonAgent) throw new Error("Python Agent backend is not configured.");
    const owner=this.pythonAgent.getOwnerKey(),documentId=this.state.documentId;
    const { status } = await this.pythonAgent.run(prompt, confirmed);
    if(owner!==this.pythonAgent.getOwnerKey()||documentId!==this.state.documentId||status.document_id!==documentId)throw new PythonAgentClientError('PYTHON_AGENT_DOCUMENT_CHANGED','原 Python 结果不属于当前工作区，未更新页面。');
    this.persistPythonState(status);
    const plan = pythonPlanFromStatus(status, prompt);
    const result = pythonResultFromStatus(status);
    const text = pythonStatusText(status);
    const mappedStatus = status.status === "waiting_user" ? "needs-input" : status.status === "waiting_approval" ? "waiting-approval" : status.status;
    const payload = { status: mappedStatus, text, turns: 1, result, executed: Boolean(result), plan: plan || undefined, questions: plan?.questions || [], pendingToolCall: undefined };
    onDelta(text);
    onEvent("run", payload);
    this.update({ agentPlan: plan, agentRun: status, agentProviderBusy: false, agentProviderError: null, revision: typeof status.document_revision === "number" ? status.document_revision : this.state.revision });
    return { ...payload, executed: Boolean(result) };
  }

  async streamAgentRun(prompt: string, context: ModelingAgentContext = {}, providerId?: string, confirmed = false, onDelta: (delta: string) => void = () => {}, onEvent: (event: string, payload: unknown) => void = () => {}) : Promise<AgentRunResult> {
    this.assertNoWorkspaceTransfer();
    if (this.pythonAgent) {
      const owner=this.pythonAgent.getOwnerKey(),documentId=this.state.documentId;
      this.update({ agentProviderBusy: true, agentProviderError: null });
      try { return await this.streamPythonAgentRun(prompt, confirmed, onDelta, onEvent); }
      catch (error) { const message = error instanceof Error ? error.message : "Python Agent run failed."; if(owner===this.pythonAgent.getOwnerKey()&&documentId===this.state.documentId)this.update({ agentProviderBusy: false, agentProviderError: message }); throw error; }
    }
    this.update({ agentProviderBusy: true, agentProviderError: null });
    const requestId = createRequestId("agent-run");
    const response = await this.fetchImpl(this.apiRoot + "/agent/run/stream", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-Request-Id": requestId }, body: JSON.stringify({ requestId, documentId: this.state.documentId, conversationId: this.state.agentConversation?.id, providerId, prompt, confirmed, context: { ...context, revision: context.revision ?? this.state.revision, selections: context.selections || (this.state.selection ? [this.state.selection] : []) } }) });
    try {
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `Agent run failed with HTTP ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let plan: ModelingAgentPlan | null = null;
      let run: AgentRunResult | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";
        for (const eventBlock of events) {
          const eventName = eventBlock.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
          const line = eventBlock.split(/\r?\n/).find((item) => item.startsWith("data:"));
          if (!line) continue;
          const payload = JSON.parse(line.slice(5).trim()) as { delta?: string; plan?: ModelingAgentPlan; error?: string; status?: string; text?: string; turns?: number; result?: ModelingCommandResponse | null; executed?: boolean; questions?: ModelingAgentPlan["questions"]; pendingToolCall?: Record<string, unknown> | null };
          onEvent(eventName, payload);
          if (payload.delta) onDelta(payload.delta);
          if (payload.error) throw new Error(payload.error);
          if (payload.plan) plan = payload.plan;
          if (eventName === "run") run = { status: payload.status || "completed", text: payload.text || "", turns: payload.turns || 0, result: payload.result || null, executed: payload.executed === true, questions: payload.questions || [], pendingToolCall: payload.pendingToolCall || null, plan: plan || undefined };
        }
      }
      if (!run) throw new Error("Agent run did not return a final state.");
      this.update({ agentPlan: plan || run.plan || null, agentProviderBusy: false, agentProviderError: null, revision: typeof run.result?.revision === "number" ? run.result.revision : this.state.revision });
      const conversationId = this.state.agentConversation?.id;
      if (conversationId) await this.loadAgentConversation(conversationId).catch(() => undefined);
      return { ...run, plan: plan || run.plan };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent run failed.";
      this.update({ agentProviderBusy: false, agentProviderError: message });
      throw error;
    }
  }
  clearPlan() {
    if (this.state.agentPlan) this.update({ agentPlan: null });
  }

  private pythonStorage(): Storage | null {
    try {
      return typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      return null;
    }
  }

  private readPythonState(documentId=this.state.documentId): PythonAgentPersistence | null {
    const storage = this.pythonStorage();
    if (!storage) return null;
    const raw = storage.getItem(`modeling-agent:python:${documentId}`);
    if (!raw) return null;
    if(raw.length>4*1024*1024)throw new PythonAgentClientError('PYTHON_AGENT_RECOVERY_INVALID','Python 缓存超过读取预算，未覆盖原缓存。',502);
    const parsed = JSON.parse(raw) as PythonAgentPersistence;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.conversation&&(parsed.conversation.documentId!==documentId||typeof parsed.conversation.id!=='string'||!Array.isArray(parsed.conversation.messages)))throw new PythonAgentClientError('PYTHON_AGENT_RECOVERY_INVALID','Python 对话缓存归属无效，未覆盖原缓存。',502);
    return parsed;
  }

  private persistPythonState(run: PythonAgentStatus | null = this.pythonAgent?.getActiveStatus() || null,requireWrite=false) {
    if (!this.pythonAgent) return;
    const unavailable=()=>new PythonAgentClientError('PYTHON_AGENT_RECOVERY_WRITE_FAILED','Python 请求恢复身份无法保存，未发送修改请求。',503);
    if(this.pythonCacheInvalid||this.pythonConversation&&this.pythonConversation.documentId!==this.state.documentId||run&&run.document_id!==this.state.documentId){if(requireWrite)throw unavailable();return;}
    const storage = this.pythonStorage();
    if (!storage){if(requireWrite)throw unavailable();return;}
    try {
      const activeRun = run && !["completed", "failed", "cancelled"].includes(run.status) ? run : null;
      const recovery=this.pythonAgent.getRecoveryState(),key=`modeling-agent:python:${this.state.documentId}`;
      if(recovery.documentId!==this.state.documentId){if(requireWrite)throw unavailable();return;}
      if (!this.pythonConversation && !activeRun&&!recovery.pending) {
        storage.removeItem(key);
        return;
      }
      const bytes=JSON.stringify({ conversation: this.pythonConversation, run: activeRun,recovery } satisfies PythonAgentPersistence);
      storage.setItem(key,bytes);if(requireWrite&&storage.getItem(key)!==bytes)throw unavailable();
    } catch {
      if(requireWrite)throw unavailable();
      // Storage can be disabled or full; the server-side Run remains authoritative.
    }
  }

  private hydratePythonState() {
    if (!this.pythonAgent) return;
    this.state={...this.state,...this.activatePythonWorkspace(this.state.documentId)};
  }
  private activatePythonWorkspace(documentId:string){
    if(!this.pythonAgent)return {};
    this.pythonAgent.setDocumentId(documentId);this.pythonCacheInvalid=false;this.pythonConversation=null;
    try{const persisted=this.readPythonState(documentId);this.pythonConversation=persisted?.conversation||null;if(persisted?.recovery)this.pythonAgent.restoreRecoveryState(persisted.recovery);else this.pythonAgent.restoreStatus(persisted?.run||null);
      const conversation=this.pythonConversation,summaries:AgentConversationSummary[]=[];
      if(conversation){const {messages,...fields}=conversation;summaries.push({...fields,messageCount:messages.length});}
      return {agentRun:this.pythonAgent.getActiveStatus(),agentConversation:conversation,agentPlan:conversation?.activePlan||null,agentConversationList:summaries,agentConversationError:null};
    }catch{this.pythonCacheInvalid=true;this.pythonAgent.invalidateRecovery();return {agentRun:null,agentConversation:null,agentPlan:null,agentConversationList:[],agentConversationError:'Python 缓存状态尚未核对，原材料已保留；未启动或迁移旧任务。'};}
  }

  private async refreshPythonRun() {
    if (!this.pythonAgent) return null;
    const owner=this.pythonAgent.getOwnerKey(),documentId=this.state.documentId;
    try {
      const status = await this.pythonAgent.refreshActiveRun();
      if(owner!==this.pythonAgent.getOwnerKey()||documentId!==this.state.documentId)throw new PythonAgentClientError('PYTHON_AGENT_DOCUMENT_CHANGED','原 Python 状态属于其他工作区，未更新页面。');
      this.persistPythonState(status);
      this.update({ agentRun: status });
      return status;
    } catch (error) {
      // Missing/failed reads do not prove a prior Run never existed. Keep its
      // exact identity and recovery marker instead of silently starting again.
      throw error;
    }
  }

  private ensurePythonConversation(title = "建模会话") {
    if(this.pythonCacheInvalid)throw new PythonAgentClientError('PYTHON_AGENT_RECOVERY_INVALID','Python 缓存尚未核对，未覆盖原材料或启动新任务。',502);
    if(this.pythonConversation&&this.pythonConversation.documentId!==this.state.documentId)throw new PythonAgentClientError('PYTHON_AGENT_DOCUMENT_CHANGED','Python 会话不属于当前工程，未采用旧会话。');
    if (this.pythonConversation) return this.pythonConversation;
    const now = new Date().toISOString();
    this.pythonConversation = { id: `python-conversation-${this.state.documentId}`, documentId: this.state.documentId, title, createdAt: now, updatedAt: now, messages: [], activePlan: null, pendingPrompt: null, pendingToolCall: null };
    this.persistPythonState();
    return this.pythonConversation;
  }

  async compactAgentConversation() {
    if (this.pythonAgent) {
      const conversation = this.ensurePythonConversation();
      const keepRecent = 8;
      const messages = conversation.messages || [];
      if (messages.length <= keepRecent) {
        const tokenEstimate = Math.ceil(JSON.stringify(messages).length / 4);
        const context = { compacted: false, tokenEstimate, recentCount: messages.length, summary: conversation.contextSummary };
        this.update({ agentConversation: conversation, agentConversationBusy: false });
        this.refreshConversationSummary(conversation);
        return { conversation, context };
      }
      const archived = messages.slice(0, -keepRecent);
      const keyFacts = archived
        .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
        .map((message) => `${message.role}: ${message.content}`.replace(/\\s+/g, " ").trim().slice(0, 220))
        .filter(Boolean)
        .slice(-12);
      const summaryText = [
        conversation.contextSummary?.text,
        `已压缩 ${archived.length} 条较早消息，保留最近 ${keepRecent} 条。`,
        ...keyFacts,
      ].filter(Boolean).join("\\n");
      const summary = {
        version: (conversation.contextSummary?.version || 0) + 1,
        turns: (conversation.contextSummary?.turns || 0) + archived.length,
        summarizedThroughTurnId: archived[archived.length - 1]?.id || null,
        text: summaryText,
        keyFacts,
      };
      const updated: AgentConversation = {
        ...conversation,
        messages: messages.slice(-keepRecent),
        contextSummary: summary,
        updatedAt: new Date().toISOString(),
      };
      this.pythonConversation = updated;
      this.persistPythonState();
      const tokenEstimate = Math.ceil(JSON.stringify(updated.messages).length / 4);
      const context = { compacted: true, tokenEstimate, recentCount: updated.messages.length, summary };
      this.update({ agentConversation: updated, agentConversationBusy: false });
      this.refreshConversationSummary(updated);
      return { conversation: updated, context };
    }
    const conversation = this.state.agentConversation || await this.loadAgentConversation();
    if (!conversation) throw new Error("Agent conversation is not available.");
    const response = await this.fetchImpl(`${this.apiRoot}/agent/conversations/${encodeURIComponent(conversation.id)}/compact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: this.state.documentId }) });
    const payload = await response.json() as { ok?: boolean; conversation?: AgentConversation; context?: { compacted?: boolean; tokenEstimate?: number; recentCount?: number; summary?: AgentConversation["contextSummary"] }; error?: string };
    if (!response.ok || !payload.ok || !payload.conversation) throw new Error(payload.error || "Could not compact Agent conversation context.");
    this.update({ agentConversation: payload.conversation, agentPlan: payload.conversation.activePlan || null });
    this.refreshConversationSummary(payload.conversation);
    return { conversation: payload.conversation, context: payload.context || {} };
  }
  async persistAgentConversationState(activePlan: ModelingAgentPlan | null, pendingPrompt: string | null = null, pendingToolCall: Record<string, unknown> | null = null) {
    if (this.pythonAgent) {
      const conversation = this.ensurePythonConversation();
      const updated = { ...conversation, activePlan, pendingPrompt, pendingToolCall, updatedAt: new Date().toISOString() };
      this.pythonConversation = updated;
      this.persistPythonState();
      this.update({ agentConversation: updated, agentPlan: activePlan });
      this.refreshConversationSummary(updated);
      return updated;
    }
    const conversation = this.state.agentConversation;
    if (!conversation) return null;
    const response = await this.fetchImpl(`${this.apiRoot}/agent/conversations/${encodeURIComponent(conversation.id)}/state`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: this.state.documentId, activePlan, pendingPrompt, pendingToolCall }) });
    const payload = await response.json() as { ok?: boolean; conversation?: AgentConversation; error?: string };
    if (!response.ok || !payload.ok || !payload.conversation) throw new Error(payload.error || "Could not save Agent conversation state.");
    this.update({ agentConversation: payload.conversation, agentPlan: activePlan });
    this.refreshConversationSummary(payload.conversation);
    return payload.conversation;
  }

  private refreshConversationSummary(conversation: AgentConversation) {
    const { messages, ...fields } = conversation;
    const summary: AgentConversationSummary = { ...fields, messageCount: messages.length };
    const list = this.state.agentConversationList.filter((item) => item.id !== conversation.id);
    this.update({ agentConversationList: [summary, ...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  }

  async loadAgentConversations() {
    if (this.pythonAgent) {
      const conversation = this.ensurePythonConversation();
      this.refreshConversationSummary(conversation);
      return this.state.agentConversationList;
    }
    const response = await this.fetchImpl(`${this.apiRoot}/agent/conversations?documentId=${encodeURIComponent(this.state.documentId)}`, { headers: { Accept: "application/json" } });
    const payload = await response.json() as { ok?: boolean; conversations?: AgentConversationSummary[]; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not list Agent conversations.");
    const conversations = payload.conversations || [];
    this.update({ agentConversationList: conversations });
    return conversations;
  }
  async loadAgentResources() {
    if (this.pythonAgent) {
      const resources: AgentResourceSummary[] = [];
      this.update({ agentResources: resources, agentResourceBusy: false, agentResourceError: null });
      return resources;
    }
    this.update({ agentResourceBusy: true, agentResourceError: null });
    try {
      const response = await this.fetchImpl(`${this.apiRoot}/agent/resources`, { headers: { Accept: "application/json" } });
      const payload = await response.json() as { ok?: boolean; resources?: AgentResourceSummary[]; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load Agent resources.");
      const resources = payload.resources || [];
      this.update({ agentResources: resources, agentResourceBusy: false });
      return resources;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load Agent resources.";
      this.update({ agentResourceBusy: false, agentResourceError: message });
      throw error;
    }
  }

  async reloadAgentResources() {
    if (this.pythonAgent) return this.loadAgentResources();
    const response = await this.fetchImpl(`${this.apiRoot}/agent/resources/reload`, { method: "POST", headers: { Accept: "application/json" } });
    const payload = await response.json() as { ok?: boolean; resources?: AgentResourceSummary[]; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not reload Agent resources.");
    const resources = payload.resources || [];
    this.update({ agentResources: resources, agentResourceError: null });
    return resources;
  }
  async loadAgentConversation(conversationId?: string): Promise<AgentConversation | null> {
    if (this.pythonAgent) {
      const conversation = this.ensurePythonConversation();
      const owner=this.pythonAgent.getOwnerKey(),documentId=this.state.documentId;
      await this.refreshPythonRun();
      if(owner!==this.pythonAgent.getOwnerKey()||documentId!==this.state.documentId)throw new PythonAgentClientError('PYTHON_AGENT_DOCUMENT_CHANGED','原 Python 会话读取已过期，未替换当前对话。');
      this.update({ agentConversation: conversation, agentPlan: conversation.activePlan || null, agentConversationBusy: false, agentConversationError: null });
      this.refreshConversationSummary(conversation);
      return conversation;
    }
    this.update({ agentConversationBusy: true, agentConversationError: null });
    try {
      let conversation: AgentConversation | null = null;
      if (conversationId) {
        const response = await this.fetchImpl(`${this.apiRoot}/agent/conversations/${encodeURIComponent(conversationId)}?documentId=${encodeURIComponent(this.state.documentId)}`, { headers: { Accept: "application/json" } });
        const payload = await response.json() as { ok?: boolean; conversation?: AgentConversation; error?: string };
        if (!response.ok || !payload.ok || !payload.conversation) throw new Error(payload.error || "Could not load Agent conversation.");
        conversation = payload.conversation;
      } else {
        const conversations = await this.loadAgentConversations();
        const existing = conversations[0];
        if (existing) return this.loadAgentConversation(existing.id);
        const createResponse = await this.fetchImpl(`${this.apiRoot}/agent/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: this.state.documentId }) });
        const createPayload = await createResponse.json() as { ok?: boolean; conversation?: AgentConversation; error?: string };
        if (!createResponse.ok || !createPayload.ok || !createPayload.conversation) throw new Error(createPayload.error || "Could not create Agent conversation.");
        conversation = createPayload.conversation;
      }
      this.update({ agentConversation: conversation, agentPlan: conversation.activePlan || null, agentConversationBusy: false });
      this.refreshConversationSummary(conversation);
      return conversation;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load Agent conversation.";
      this.update({ agentConversationBusy: false, agentConversationError: message });
      throw error;
    }
  }

  async createAgentConversation(title = "建模会话") {
    if (this.pythonAgent) {
      this.pythonAgent.clear();
      this.persistPythonState(null);
      const now = new Date().toISOString();
      const conversation: AgentConversation = { id: `python-conversation-${this.state.documentId}-${Date.now()}`, documentId: this.state.documentId, title, createdAt: now, updatedAt: now, messages: [], activePlan: null, pendingPrompt: null, pendingToolCall: null };
      this.pythonConversation = conversation;
      this.persistPythonState();
      this.update({ agentConversation: conversation, agentPlan: null, agentConversationError: null });
      this.refreshConversationSummary(conversation);
      return conversation;
    }
    const response = await this.fetchImpl(`${this.apiRoot}/agent/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: this.state.documentId, title }) });
    const payload = await response.json() as { ok?: boolean; conversation?: AgentConversation; error?: string };
    if (!response.ok || !payload.ok || !payload.conversation) throw new Error(payload.error || "Could not create Agent conversation.");
    this.update({ agentConversation: payload.conversation, agentPlan: payload.conversation.activePlan || null, agentConversationError: null });
    this.refreshConversationSummary(payload.conversation);
    return payload.conversation;
  }
  async deleteAgentConversation(conversationId: string) {
    if (this.pythonAgent) {
      this.pythonAgent.clear();
      if (this.pythonConversation?.id === conversationId) this.pythonConversation = null;
      this.persistPythonState(null);
      await this.createAgentConversation();
      return;
    }
    const response = await this.fetchImpl(`${this.apiRoot}/agent/conversations/${encodeURIComponent(conversationId)}?documentId=${encodeURIComponent(this.state.documentId)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not delete Agent conversation.");
    const remaining = this.state.agentConversationList.filter((item) => item.id !== conversationId);
    if (this.state.agentConversation?.id === conversationId) {
      this.update({ agentConversation: null, agentPlan: null, agentConversationList: remaining });
      if (remaining[0]) await this.loadAgentConversation(remaining[0].id);
      else await this.createAgentConversation();
    } else this.update({ agentConversationList: remaining });
  }

  async appendAgentMessage(message: Omit<AgentConversationMessage, "id" | "createdAt">) {
    if (this.pythonAgent) {
      const conversation = this.ensurePythonConversation();
      const now = new Date().toISOString();
      const updated: AgentConversation = { ...conversation, messages: [...conversation.messages, { ...message, id: createRequestId("message"), createdAt: now }], updatedAt: now };
      this.pythonConversation = updated;
      this.persistPythonState();
      this.update({ agentConversation: updated });
      this.refreshConversationSummary(updated);
      return updated;
    }
    const conversation = this.state.agentConversation || await this.loadAgentConversation();
    if (!conversation) throw new Error("Agent conversation is not available.");
    const response = await this.fetchImpl(`${this.apiRoot}/agent/conversations/${encodeURIComponent(conversation.id)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: this.state.documentId, message }) });
    const payload = await response.json() as { ok?: boolean; conversation?: AgentConversation; error?: string };
    if (!response.ok || !payload.ok || !payload.conversation) throw new Error(payload.error || "Could not save Agent conversation message.");
    this.update({ agentConversation: payload.conversation });
    return payload.conversation;
  }

  async queryAgentModel(query: AgentModelQuery = { kind: "geometry-tree" }): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.apiRoot}/agent/model/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: this.state.documentId, ...query }) });
    const payload = await response.json() as { ok?: boolean; query?: unknown; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not query the CAD model.");
    const result = (payload.query && typeof payload.query === "object" ? payload.query : {}) as Record<string, unknown>;
    this.update({ agentModelQuery: result });
    return result;
  }
  async loadAgentProviders() {
    if (this.pythonAgent) {
      const providers: AgentProviderSummary[] = [{ id: "python-langgraph", name: "Python LangGraph Agent", baseUrl: "python://langgraph", model: "LangGraph", protocol: "auto", priority: 100, toolCalling: true, enabled: true, apiKeyConfigured: true }];
      this.update({ agentProviders: providers, agentProviderBusy: false, agentProviderError: null });
      return providers;
    }
    this.update({ agentProviderBusy: true, agentProviderError: null });
    try {
      const response = await this.fetchImpl(`${this.apiRoot}/agent/providers`, { headers: { Accept: "application/json" } });
      const payload = await response.json() as { ok?: boolean; providers?: AgentProviderSummary[]; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load Agent providers.");
      const providers = payload.providers || [];
      this.update({ agentProviders: providers, agentProviderBusy: false });
      return providers;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load Agent providers.";
      this.update({ agentProviderBusy: false, agentProviderError: message });
      throw error;
    }
  }

  async saveAgentProvider(provider: AgentProviderInput) {
    if (this.pythonAgent) throw new Error("Python Agent model configuration is managed by the Python service.");
    this.update({ agentProviderBusy: true, agentProviderError: null });
    try {
      const response = await this.fetchImpl(`${this.apiRoot}/agent/providers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(provider) });
      const payload = await response.json() as { ok?: boolean; provider?: AgentProviderSummary; error?: string };
      if (!response.ok || !payload.ok || !payload.provider) throw new Error(payload.error || "Could not save Agent provider.");
      const providers = this.state.agentProviders.filter((item) => item.id !== payload.provider?.id).concat(payload.provider);
      this.update({ agentProviders: providers, agentProviderBusy: false });
      return payload.provider;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save Agent provider.";
      this.update({ agentProviderBusy: false, agentProviderError: message });
      throw error;
    }
  }

  async deleteAgentProvider(id: string) {
    if (this.pythonAgent) throw new Error("Python Agent model configuration is managed by the Python service.");
    const response = await this.fetchImpl(`${this.apiRoot}/agent/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    const payload = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not delete Agent provider.");
    this.update({ agentProviders: this.state.agentProviders.filter((item) => item.id !== id) });
  }

  async testAgentProvider(id: string) {
    if (this.pythonAgent) return { ok: true, protocol: "python-api", model: "LangGraph" };
    const response = await this.fetchImpl(`${this.apiRoot}/agent/providers/${encodeURIComponent(id)}/test`, { method: "POST" });
    const payload = await response.json() as { ok?: boolean; protocol?: string; model?: string; error?: string };
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Agent provider connection failed.");
    return payload;
  }

  async generateAgentPlan(prompt: string, context: ModelingAgentContext = {}, providerId?: string) {
    this.update({ agentProviderBusy: true, agentProviderError: null });
    const requestId = createRequestId("agent-plan");
    try {
      const response = await this.fetchImpl(`${this.apiRoot}/agent/plan`, { method: "POST", headers: { "Content-Type": "application/json", "X-Request-Id": requestId }, body: JSON.stringify({ requestId, documentId: this.state.documentId, conversationId: this.state.agentConversation?.id, providerId, prompt, context: { ...context, revision: context.revision ?? this.state.revision, selections: context.selections || (this.state.selection ? [this.state.selection] : []) } }) });
      const payload = await response.json() as { ok?: boolean; plan?: ModelingAgentPlan; error?: string; code?: string; requestId?: string };
      if (!response.ok || !payload.ok || !payload.plan) {
        const errorPayload: ModelingCommandErrorPayload = { ok: false, requestId: payload.requestId || requestId, documentId: this.state.documentId, code: payload.code || "AGENT_PLAN_FAILED", error: payload.error || "Agent planning failed.", recoverable: true };
        this.update({ agentProviderBusy: false, agentProviderError: errorPayload.error, error: errorPayload });
        throw new ModelingCommandError(errorPayload, response.status);
      }
      this.update({ agentPlan: payload.plan, agentProviderBusy: false, agentProviderError: null });
      return payload.plan;
    } catch (error) {
      if (error instanceof ModelingCommandError) throw error;
      const message = error instanceof Error ? error.message : "Agent planning failed.";
      this.update({ agentProviderBusy: false, agentProviderError: message });
      throw error;
    }
  }
  clearError() {
    if (this.state.error) this.update({ error: null });
  }

  async execute<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(
    input: ModelingCommandInput,
  ): Promise<TResponse> {
    const request = normalizeCommandRequest(input, this.state.documentId);
    if(!this.isReadOnlyOperation(request.operation))this.assertNoWorkspaceTransfer();
    const requestId = request.requestId!;
    this.pendingCommands.set(requestId, request.operation);
    this.update({
      commandLog: [...this.state.commandLog, { requestId, documentId: request.documentId!, operation: request.operation, startedAt: Date.now(), status: "running" as const }].slice(-200),
      pendingOperation: request.operation,
      lastRequestId: request.requestId || null,
      error: null,
      busy: true,
    });
    try {
      const submit=async(headers:Record<string,string>,frozen=request)=>{
        const response=await this.fetchImpl(`${this.apiRoot}/commands`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(frozen)});
        let payload:ModelingCommandResponse|ModelingCommandErrorPayload;
        try{payload=await response.json();}catch{throw new ModelingCommandError({ok:false,requestId,code:'INVALID_RESPONSE',error:`几何服务返回非 JSON 响应（HTTP ${response.status}），请检查服务地址或代理。`,recoverable:true},response.status);}
        if(!payload||typeof payload!=='object'||typeof payload.ok!=='boolean')throw new ModelingCommandError({ok:false,requestId,code:'INVALID_RESPONSE',error:'几何服务响应不符合命令协议。',recoverable:true},response.status);
        return {ok:response.ok,status:response.status,payload};
      };
      const packet=this.taskClient&&canTrackModelingTask(request)?await this.taskClient.run(request,submit):await submit({});
      const payload=packet.payload;
      if (!packet.ok || !payload.ok) {
        const errorPayload = payload as ModelingCommandErrorPayload;
        throw new ModelingCommandError(errorPayload, packet.status);
      }
      const result = payload as TResponse;
      this.finishCommandLog(requestId, { status: "success", revision: result.revision, warningCount: result.warnings?.length || 0, warnings:result.warnings?.slice(0,20).map(value=>String(value).slice(0,1000)) });
      if(request.documentId===this.state.documentId && !request.options?.preview)this.acceptResponse(result);
      return result;
    } catch (caught) {
      const reason=caught instanceof ModelingTaskClientError?new ModelingCommandError(caught.payload,caught.status):caught;
      if (reason instanceof ModelingCommandError) {
        const cancelled=reason.modelingTask?.phase==='cancelled';
        this.finishCommandLog(requestId, { status:cancelled?'cancelled':"error", code:reason.code, message:reason.message });
        if (request.documentId === this.state.documentId) this.update({error:cancelled?null:{ok:false,code:reason.code,error:reason.message,requestId,recoverable:reason.recoverable,fieldPath:reason.fieldPath}});
        throw reason;
      }
      const errorPayload: ModelingCommandErrorPayload = {
        ok: false,
        requestId: request.requestId,
        documentId: request.documentId,
        code: "NETWORK_ERROR",
        error: reason instanceof Error ? reason.message : "Geometry command failed.",
        recoverable: true,
      };
      this.finishCommandLog(requestId, {status:"error",code:errorPayload.code,message:errorPayload.error});
      if (request.documentId === this.state.documentId) this.update({ error: errorPayload });
      throw new ModelingCommandError(errorPayload, 0);
    } finally {
      this.pendingCommands.delete(requestId);
      this.update({ busy: this.pendingCommands.size > 0||this.hasPendingMutation(), pendingOperation: [...this.pendingCommands.values()].at(-1) || null });
    }
  }

  private finishCommandLog(requestId: string, patch: Partial<CommandLogEntry>) {
    this.update({ commandLog: this.state.commandLog.map((entry) => entry.requestId === requestId ? { ...entry, ...patch, durationMs: Math.max(0, Date.now() - entry.startedAt) } : entry) });
  }

  async executeBatch<TResponse extends ModelingCommandResponse=ModelingCommandResponse>(steps:ModelingCommandInput[], precondition:{baseRevision?:number;baseStateToken?:string}={}):Promise<TResponse> {
    this.assertNoWorkspaceTransfer();
    const documentId=this.state.documentId,requestId=createRequestId("project-batch"),operation="project.batch";
    const request:ModelingBatchRequest={protocolVersion:1,operation,documentId,batchId:requestId,requestId,...precondition,steps};
    this.pendingCommands.set(requestId,operation);
    this.update({busy:true,pendingOperation:operation,error:null,lastRequestId:requestId,commandLog:[...this.state.commandLog,{requestId,documentId,operation,startedAt:Date.now(),status:"running" as const}].slice(-200)});
    try{
      const submit=async(headers:Record<string,string>,frozen=request)=>{
        const response=await this.fetchImpl(`${this.apiRoot}/command-batches`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(frozen)});
        let payload:ModelingCommandResponse|ModelingCommandErrorPayload;
        try{payload=await response.json();}catch{throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:'工程事务服务返回了非 JSON 响应。'},response.status);}
        if(!payload||typeof payload!=='object'||typeof payload.ok!=='boolean')throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:'工程事务响应不符合协议。'},response.status);
        return {ok:response.ok,status:response.status,payload};
      };
      const packet=this.taskClient?await this.taskClient.run(request,submit):await submit({}),payload=packet.payload;
      if(!packet.ok || payload.ok!==true)throw new ModelingCommandError(payload as ModelingCommandErrorPayload,packet.status);
      const result=payload as TResponse;this.finishCommandLog(requestId,{status:"success",revision:result.revision});
      if(documentId===this.state.documentId)this.acceptResponse(result);
      return result;
    }catch(caught){
      const reason=caught instanceof ModelingTaskClientError?new ModelingCommandError(caught.payload,caught.status):caught;
      const error=reason instanceof ModelingCommandError?reason:new ModelingCommandError({ok:false,code:"NETWORK_ERROR",error:reason instanceof Error?reason.message:"工程事务请求失败。"},0),cancelled=error.modelingTask?.phase==='cancelled';
      this.finishCommandLog(requestId,{status:cancelled?'cancelled':"error",code:error.code,message:error.message});
      if(documentId===this.state.documentId)this.update({error:cancelled?null:{ok:false,code:error.code,error:error.message,requestId}});
      throw error;
    }finally{this.pendingCommands.delete(requestId);this.update({busy:this.pendingCommands.size>0||this.hasPendingMutation(),pendingOperation:[...this.pendingCommands.values()].at(-1)||null});}
  }

  clearCommandLog(documentId?: string) {
    const keep = (entry: CommandLogEntry) => entry.status === "running" || (documentId !== undefined && entry.documentId !== documentId);
    const activeErrorRequest = this.state.error?.requestId;
    const clearsActiveError = activeErrorRequest && this.state.commandLog.some(entry => entry.requestId === activeErrorRequest && !keep(entry));
    this.update({ commandLog: this.state.commandLog.filter(keep), ...(clearsActiveError ? { error: null } : {}) });
  }
  async discoverModelingTasks(documentId=this.state.documentId){if(!this.taskClient)return;await Promise.all([this.taskClient.restore(documentId),this.taskClient.restoreProjectCreates(documentId)]);}
  async refreshModelingTasks(documentId=this.state.documentId){if(!this.taskClient)return;try{await this.taskClient.restore(documentId);const incoming=await this.taskClient.restoreProjectOpens(documentId),created=await this.taskClient.restoreProjectCreates(documentId);if(this.state.documentId===documentId)this.update({modelingTaskNotice:incoming.omitted||created.omitted?'还有较早的工程任务尚未载入，请通过恢复工程列表核对。':null});}catch(reason){if(this.state.documentId===documentId)this.update({modelingTaskNotice:reason instanceof Error?reason.message:'任务状态暂不可用。'});throw reason;}}
  private ownedTask(taskId:string){const item=this.state.modelingTasks.find(item=>item.task.taskId===taskId);if(!item||modelingTaskSourceDocument(item)!==this.state.documentId)throw new ModelingCommandError({ok:false,code:'MODELING_TASK_DOCUMENT_CHANGED',error:'任务不属于当前工程，未发送控制请求。'},409);return item;}
  async cancelModelingTask(taskId:string){this.ownedTask(taskId);if(!this.taskClient)throw new Error('任务控制未启用。');try{return await this.taskClient.cancel(taskId);}catch(reason){if(reason instanceof ModelingTaskClientError)throw new ModelingCommandError(reason.payload,reason.status);throw reason;}}
  async checkModelingTask(taskId:string){this.ownedTask(taskId);if(!this.taskClient)throw new Error('任务控制未启用。');return this.taskClient.check(taskId);}
  async readModelingTaskResult(taskId:string){const documentId=this.state.documentId;this.ownedTask(taskId);if(!this.taskClient)throw new Error('任务控制未启用。');const result=await this.taskClient.readResult(taskId);this.ownedTask(taskId);if(this.state.documentId!==documentId)throw new ModelingCommandError({ok:false,code:'MODELING_TASK_DOCUMENT_CHANGED',error:'核对期间工程已变化，未采用原任务回执。'},409);return result;}
  cancelProjectBackupDownload(taskId:string){if(this.archiveDownload?.taskId===taskId){this.archiveDownload.abort.abort();return true;}this.ownedTask(taskId);return this.taskClient?.cancelBackupDownload(taskId)||false;}
  listProjectBackups(options:{after?:string;signal?:AbortSignal}={}){return listStoredProjectBackups(this.apiRoot,this.fetchImpl,this.state.documentId,options);}
  listBackupMaintenance(signal?:AbortSignal){return new BackupMaintenanceClient(this.apiRoot,this.fetchImpl).list(this.state.documentId,signal);}
  checkBackupMaintenance(reviewId:string,signal?:AbortSignal){return new BackupMaintenanceClient(this.apiRoot,this.fetchImpl).get(this.state.documentId,reviewId,signal);}
  private async runBackupMaintenance<T>(action:(client:BackupMaintenanceClient,documentId:string)=>Promise<T>){
    const transfer=this.beginWorkspaceTransfer('project.backup.maintenance',this.state.documentId);
    try{const result=await action(new BackupMaintenanceClient(this.apiRoot,this.fetchImpl),transfer.sourceDocumentId);if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'维护回复已收到，但当前工程状态已变化，未采用旧页面结果；请在原工程核对清单，不会重发。'},409);this.finishCommandLog(transfer.requestId,{status:'success',message:'维护回复已核对，未将任何历史模型作为当前几何采用。'});return result;}catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
  }
  previewBackupMaintenance(entryId:string){return this.runBackupMaintenance((client,id)=>client.preview(id,entryId));}
  commitBackupMaintenance(record:BackupMaintenanceRecord){const original=normalizeBackupMaintenance(record,this.state.documentId);return this.runBackupMaintenance((client,id)=>client.commit(id,original));}
  discardBackupMaintenance(reviewId:string){return this.runBackupMaintenance((client,id)=>client.discard(id,reviewId));}
  async downloadStoredProjectBackup(taskId:string,onProgress?:(received:number,total:number)=>void){
    const transfer=this.beginWorkspaceTransfer('project.backup.download',this.state.documentId),abort=new AbortController();this.archiveDownload={taskId,abort};
    try{
      const entry=await getStoredProjectBackup(this.apiRoot,this.fetchImpl,transfer.sourceDocumentId,taskId,abort.signal);
      if(!entry.canDownload||!entry.receipt)throw new ProjectBackupReadError('PROJECT_BACKUP_UNAVAILABLE','该条目未完成发布或材料异常，不能下载；原材料已保留。');
      const file=await readProjectBackup(this.apiRoot,this.fetchImpl,entry.receipt,{signal:abort.signal,onProgress});
      if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'当前工程状态已变化，未启动旧页面的下载；原备份仍保留。'},409);
      this.finishCommandLog(transfer.requestId,{status:'success',message:'原备份已读取并校验，尚不代表本地保存完成。'});return file;
    }catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{if(this.archiveDownload?.abort===abort)this.archiveDownload=null;this.endWorkspaceTransfer(transfer);}
  }
  async deleteProjectBackup(taskId:string){
    const transfer=this.beginWorkspaceTransfer('project.backup.delete',this.state.documentId);
    try{const result=await deleteStoredProjectBackup(this.apiRoot,this.fetchImpl,transfer.sourceDocumentId,taskId);this.finishCommandLog(transfer.requestId,{status:'success',message:'已删除指定备份文件，未删除工程几何或建模历史。'});return result;}catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
  }
  async downloadProjectBackupTask(taskId:string){
    const item=this.ownedTask(taskId);if(item.task.operation!=='project.save'||!this.taskClient)throw new Error('这不是可下载的保存任务。');
    const transfer=this.beginWorkspaceTransfer('project.backup.download',this.state.documentId);
    try{const file=await this.taskClient.downloadBackup(taskId);if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'备份已读取，但当前工程状态已变化；未启动旧页面的下载。可从原任务再次下载。'},409);this.finishCommandLog(transfer.requestId,{status:'success',message:'原备份已读取并校验，尚不代表本地保存完成。'});return file;}
    catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
  }
  async openCompletedProjectTask(taskId:string){
    const item=this.ownedTask(taskId),source=this.state;
    if(!item.projectOpen&&!item.projectCreate)throw new Error('这不是工程创建或打开任务。');
    const task=await this.checkModelingTask(taskId);
    if(task.phase!=='succeeded')throw new Error('打开结果尚未确认，请先检查任务状态；不会重新上传文件。');
    this.ownedTask(taskId);
    if(this.state.documentId!==source.documentId||this.state.revision!==source.revision||this.state.stateToken!==source.stateToken||this.state.stateSequence!==source.stateSequence)throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'检查任务期间当前工程已变化，未切换页面。请确认当前工作后再次打开目标工程。'},409);
    return this.restoreWorkspace(item.task.documentId);
  }
  disposeTaskTracking(){this.workspaceEpoch++;this.workspaceRead?.abort.abort();this.workspaceRead=null;this.archiveDownload?.abort.abort();this.taskClient?.dispose();}
  async clearCompletedModelingTasks(){if(!this.taskClient)return {deleted:0,retained:0};return this.taskClient.clearCompleted(this.state.documentId);}
  private persistWorkspaceChoice() {if(typeof window!=="undefined"){try{window.sessionStorage.setItem("occt.activeDocumentId",this.state.documentId);}catch{}try{window.localStorage.setItem("occt.activeDocumentId",this.state.documentId);}catch{/* Storage can be disabled by the browser. */}}}
  private isReadOnlyOperation(operation:string){return operation.endsWith('.list')||['document.view','document.summary','document.preview','document.naming.preview','body.presentation','geometry.check','geometry.measure','geometry.relation'].includes(operation);}
  hasPendingMutation() {
    return Boolean(this.workspaceTransfer)||Boolean(this.pythonAgent?.blocksWorkspaceSwitch())||[...this.pendingCommands.values()].some(operation=>!this.isReadOnlyOperation(operation))||Boolean(this.taskClient?.hasPending(this.state.documentId))||(this.state.stepImportStatus?.documentId===this.state.documentId&&activeStepImport(this.state.stepImportStatus.phase));
  }
  hasWorkspaceTransfer(){return Boolean(this.workspaceTransfer);}
  private assertNoWorkspaceTransfer(){if(this.workspaceTransfer||this.state.modelingTasks.some(item=>((item.projectOpen||item.projectCreate)&&modelingTaskSourceDocument(item)===this.state.documentId||item.task.operation==='project.save'&&item.task.documentId===this.state.documentId)&&!modelingTaskTerminal(item.task.phase)))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_BUSY',documentId:this.state.documentId,error:'工程文件操作尚未完成，请等待后再修改或切换工程。',recoverable:true},409);}
  private assertWorkspaceSwitchable() {this.assertNoWorkspaceTransfer();if(this.pythonAgent?.blocksWorkspaceSwitch())throw new PythonAgentClientError('PYTHON_AGENT_BUSY','Python 请求仍在运行或结果尚未确认，请先核对原任务后再切换工程。');if(this.hasPendingMutation()||this.state.pendingOperation==='step.export')throw new Error("当前工程命令尚未完成，请等待后再切换工程。");}
  private beginWorkspaceTransfer(operation:WorkspaceTransfer['operation'],targetDocumentId:string){
    this.assertWorkspaceSwitchable();const transfer:WorkspaceTransfer=Object.freeze({requestId:createRequestId(operation.replace('.','-')),operation,targetDocumentId,sourceDocumentId:this.state.documentId,revision:this.state.revision,stateToken:this.state.stateToken,stateSequence:this.state.stateSequence,sourceLoaded:this.state.model!==null});
    this.workspaceTransfer=transfer;this.pendingCommands.set(transfer.requestId,operation);
    this.update({busy:true,pendingOperation:operation,lastRequestId:transfer.requestId,error:null,commandLog:[...this.state.commandLog,{requestId:transfer.requestId,documentId:transfer.sourceDocumentId,operation,startedAt:Date.now(),status:'running' as const}].slice(-200)});return transfer;
  }
  private ownsWorkspaceTransfer(transfer:WorkspaceTransfer){return this.workspaceTransfer===transfer&&this.state.documentId===transfer.sourceDocumentId&&(!transfer.sourceLoaded&&transfer.operation==='project.activate'&&transfer.sourceDocumentId===transfer.targetDocumentId||this.state.revision===transfer.revision&&this.state.stateToken===transfer.stateToken&&this.state.stateSequence===transfer.stateSequence);}
  private endWorkspaceTransfer(transfer:WorkspaceTransfer){this.pendingCommands.delete(transfer.requestId);if(this.workspaceTransfer===transfer)this.workspaceTransfer=null;this.update({busy:this.pendingCommands.size>0||this.hasPendingMutation(),pendingOperation:[...this.pendingCommands.values()].at(-1)||null});}
  private workspaceTransferFailure(transfer:WorkspaceTransfer,reason:unknown){
    const error=reason instanceof ModelingCommandError?reason:reason instanceof ModelingTaskClientError?new ModelingCommandError(reason.payload,reason.status):reason instanceof ProjectBackupReadError?new ModelingCommandError({ok:false,code:reason.code,error:reason.message,documentId:transfer.sourceDocumentId,requestId:transfer.requestId},reason.code==='PROJECT_BACKUP_DOWNLOAD_CANCELLED'?409:502):new ModelingCommandError({ok:false,requestId:transfer.requestId,documentId:transfer.sourceDocumentId,code:'NETWORK_ERROR',error:'工程文件操作结果尚未确认，请通过原任务或恢复工程列表核对；不会自动重传或重复执行。',recoverable:true,details:{targetDocumentId:transfer.targetDocumentId}},0);
    const cancelled=error.modelingTask?.phase==='cancelled'||error.code==='PROJECT_BACKUP_DOWNLOAD_CANCELLED';
    this.finishCommandLog(transfer.requestId,{status:cancelled?'cancelled':error.code==='WORKSPACE_TRANSFER_SUPERSEDED'?'success':'error',code:error.code,message:error.message,warningCount:error.code==='WORKSPACE_TRANSFER_SUPERSEDED'?1:0});
    if(this.ownsWorkspaceTransfer(transfer))this.update({error:cancelled?null:{ok:false,requestId:transfer.requestId,documentId:transfer.sourceDocumentId,code:error.code,error:error.message,recoverable:error.recoverable,details:error.details}});return error;
  }
  private async readWorkspaceResponse<TResponse extends ModelingCommandResponse>(response:Response,transfer:WorkspaceTransfer):Promise<TResponse>{
    let payload:unknown;try{payload=await response.json();}catch{throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:`工程服务返回非 JSON 响应（HTTP ${response.status}）；结果未确认，请核对工程列表，不会自动重传。`},response.status);}
    if(!payload||typeof payload!=='object'||typeof (payload as {ok?:unknown}).ok!=='boolean')throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:'工程服务响应不符合协议，未切换当前工程。'},response.status);
    const result=payload as TResponse|ModelingCommandErrorPayload;
    if(!response.ok||!result.ok)throw new ModelingCommandError(result.ok?{ok:false,code:'INVALID_RESPONSE',error:'工程服务 HTTP 状态与结果不一致，未切换当前工程。'}:result,response.status);
    const validArrays=['positions','features','bodyPresentations'].filter(key=>result[key]!==undefined);
    if(result.documentId!==transfer.targetDocumentId||!Number.isSafeInteger(result.revision)||Number(result.revision)<0||!validArrays.length||validArrays.some(key=>!Array.isArray(result[key]))||result.stateSequence!==undefined&&(!Number.isSafeInteger(result.stateSequence)||result.stateSequence<0)||result.stateToken!==undefined&&!/^[a-f0-9]{64}$/.test(result.stateToken))throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:'打开结果的工程身份、版本或模型快照无效，未切换当前工程。'},response.status);
    if(!this.ownsWorkspaceTransfer(transfer)||!transfer.sourceLoaded&&transfer.sourceDocumentId===transfer.targetDocumentId&&!this.acceptsState(result))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'目标工程已打开，但当前工程状态已变化；未切换页面。请从恢复工程列表进入，不要重新上传。',details:{targetDocumentId:transfer.targetDocumentId}},409);
    return result as TResponse;
  }
  private adoptWorkspaceResult(result:ModelingCommandResponse,documentId:string){this.workspaceEpoch++;this.workspaceRead=null;const python=this.activatePythonWorkspace(documentId);this.update({documentId,model:result as unknown as TModel,currentBodyId:this.readBodyId(result as unknown as TModel),activeOperation:null,operationWindow:null,selection:null,agentPlan:null,planExecution:null,agentConversation:null,agentConversationList:[],agentModelQuery:null,agentRun:null,agentProviderBusy:false,agentProviderError:null,stepImportStatus:null,stepImportNotice:null,revision:result.revision??null,history:result.history??null,stateToken:result.stateToken??null,stateSequence:result.stateSequence??null,error:null,...python});this.persistWorkspaceChoice();}
  private async preflightWorkspaceTransfer(transfer:WorkspaceTransfer){
    try{await Promise.all([...new Set([transfer.sourceDocumentId,transfer.targetDocumentId])].map(id=>assertPiWorkspaceIdle(this.apiRoot,this.fetchImpl,id)));}catch(reason){throw new ModelingCommandError({ok:false,code:'PI_DOCUMENT_NOT_IDLE',error:reason instanceof Error?reason.message:'相关工程的 AI 状态尚未确认，未切换工程。'},409);}
    if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'核对助手期间来源工程已变化，未采用旧切换请求。'},409);
  }
  private async activateWorkspaceView<TResponse extends ModelingCommandResponse>(transfer:WorkspaceTransfer):Promise<TResponse>{
    let input;try{input=normalizeWorkspaceActivation({protocolVersion:1,operation:'project.activate',documentId:transfer.targetDocumentId,sourceDocumentId:transfer.sourceDocumentId,requestId:createRequestId('workspace-view'),sourceRevision:transfer.sourceLoaded?transfer.revision:null,sourceStateToken:transfer.sourceLoaded?transfer.stateToken:null,sourceStateSequence:transfer.sourceLoaded?transfer.stateSequence:null});}catch{throw new ModelingCommandError({ok:false,code:'WORKSPACE_SOURCE_UNCONFIRMED',error:'来源模型的版本信息不完整，请先载入当前工程，再切换。'},409);}
    await this.preflightWorkspaceTransfer(transfer);
    const response=await this.fetchImpl(`${this.apiRoot}/projects/${encodeURIComponent(transfer.targetDocumentId)}/activate`,{method:'POST',headers:{'Content-Type':'application/json','X-Request-Id':input.requestId},body:JSON.stringify({command:input})});
    const result=await this.readWorkspaceResponse<TResponse>(response,transfer);
    try{normalizeWorkspaceActivationProof(result.workspaceActivation,input);if(typeof result.stateToken!=='string'||!Number.isSafeInteger(result.stateSequence))throw Error();}catch{throw new ModelingCommandError({ok:false,code:'WORKSPACE_ACTIVATION_UNCONFIRMED',error:'服务未返回匹配来源、目标与原请求的切换证明，原工程未被替换。'},502);}
    return result;
  }
  async getWorkspaceMetadata(id=this.state.documentId):Promise<WorkspaceMetadata>{
    const response=await this.fetchImpl(`${this.apiRoot}/projects/${encodeURIComponent(id)}`),payload=await response.json();if(!response.ok || !payload.ok)throw new Error(payload.error || "工程状态读取失败");return payload.project;
  }
  async listWorkspaces(query=""):Promise<WorkspaceMetadata[]>{
    const response=await this.fetchImpl(`${this.apiRoot}/projects?q=${encodeURIComponent(query)}`),payload=await response.json();if(!response.ok || !payload.ok)throw new Error(payload.error || "恢复工程列表读取失败");return payload.projects;
  }
  async renameWorkspace(name:string):Promise<WorkspaceMetadata>{
    this.assertNoWorkspaceTransfer();
    const response=await this.fetchImpl(`${this.apiRoot}/projects/${encodeURIComponent(this.state.documentId)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})}),payload=await response.json();if(!response.ok || !payload.ok)throw new Error(payload.error || "工程重命名失败");return payload.project;
  }
  async restoreWorkspace<TResponse extends ModelingCommandResponse=ModelingCommandResponse>(id:string):Promise<TResponse>{
    if(id===this.state.documentId)return this.readCurrentWorkspace<TResponse>();
    const transfer=this.beginWorkspaceTransfer('project.activate',id);
    try{const result=await this.activateWorkspaceView<TResponse>(transfer);this.adoptWorkspaceResult(result,id);this.finishCommandLog(transfer.requestId,{status:'success',revision:result.revision});return result;}catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
  }

  readCurrentWorkspace<TResponse extends ModelingCommandResponse=ModelingCommandResponse>():Promise<TResponse>{
    this.assertNoWorkspaceTransfer();
    const documentId=this.state.documentId,epoch=this.workspaceEpoch;
    if(this.workspaceRead?.documentId===documentId&&this.workspaceRead.epoch===epoch)return this.workspaceRead.promise as Promise<TResponse>;
    const command=normalizeWorkspaceRead({protocolVersion:1,operation:'project.read',documentId,requestId:createRequestId('project-read')}),requestId=command.requestId;
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),60000);
    const owns=()=>this.state.documentId===documentId&&this.workspaceEpoch===epoch&&!this.workspaceTransfer;
    this.pendingCommands.set(requestId,'document.view');
    // Defer the transport so synchronous fetch failures also settle the coalesced record.
    const promise=Promise.resolve().then(async()=>{
      try{
        if(!owns())throw new ModelingCommandError({ok:false,code:'WORKSPACE_READ_SUPERSEDED',error:'工程已变化，未发起旧读取。'},409);
        const response=await this.fetchImpl(`${this.apiRoot}/projects/${encodeURIComponent(documentId)}/view`,{method:'GET',headers:{'X-Request-Id':requestId},cache:'no-store',signal:abort.signal});
        let payload:unknown;try{payload=await response.json();}catch{throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:`工程读取返回非 JSON 响应（HTTP ${response.status}），未替换模型。`},response.status);}
        if(!payload||typeof payload!=='object'||typeof (payload as {ok?:unknown}).ok!=='boolean')throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:'工程读取响应不符合协议，未替换模型。'},response.status);
        const result=payload as ModelingCommandResponse;
        if(!response.ok||!result.ok)throw new ModelingCommandError(result.ok?{ok:false,code:'INVALID_RESPONSE',error:'工程读取 HTTP 状态与结果不一致。'}:result as unknown as ModelingCommandErrorPayload,response.status);
        try{normalizeWorkspaceReadProof(result.workspaceRead,command);if(result.documentId!==documentId||!Number.isSafeInteger(result.revision)||Number(result.revision)<0||!Number.isSafeInteger(result.stateSequence)||Number(result.stateSequence)<0||typeof result.stateToken!=='string'||!/^[a-f0-9]{64}$/.test(result.stateToken)||!['positions','features','bodyPresentations'].some(key=>Array.isArray(result[key]))||['positions','features','bodyPresentations'].some(key=>result[key]!==undefined&&!Array.isArray(result[key])))throw Error();}catch{throw new ModelingCommandError({ok:false,code:'WORKSPACE_READ_UNCONFIRMED',error:'工程读取回复缺少匹配的身份、状态或模型证明，未替换模型。'},502);}
        if(!owns()||!this.acceptsState(result)||result.stateSequence===this.state.stateSequence&&(result.revision!==this.state.revision||this.state.stateToken!==null&&result.stateToken!==this.state.stateToken))throw new ModelingCommandError({ok:false,code:'WORKSPACE_READ_SUPERSEDED',error:'工程或模型状态已变化，未采用旧读取结果。'},409);
        this.acceptResponse(result,true);this.finishCommandLog(requestId,{status:'success',revision:result.revision});return result;
      }catch(reason){
        const error=reason instanceof ModelingCommandError?reason:new ModelingCommandError({ok:false,code:'NETWORK_ERROR',error:'工程读取未完成，请检查后台连接后重试；未修改几何或助手会话。'},0);
        this.finishCommandLog(requestId,{status:error.code==='WORKSPACE_READ_SUPERSEDED'?'cancelled':'error',code:error.code,message:error.message});
        if(owns()&&this.state.lastRequestId===requestId&&error.code!=='WORKSPACE_READ_SUPERSEDED')this.update({error:{ok:false,documentId,requestId,code:error.code,error:error.message,recoverable:error.recoverable}});
        throw error;
      }finally{
        clearTimeout(timer);
        if(this.workspaceRead?.promise===promise)this.workspaceRead=null;
        this.pendingCommands.delete(requestId);this.update({busy:this.pendingCommands.size>0||this.hasPendingMutation(),pendingOperation:[...this.pendingCommands.values()].at(-1)||null});
      }
    });
    this.workspaceRead={documentId,epoch,promise,abort};
    this.update({busy:true,pendingOperation:'document.view',lastRequestId:requestId,error:null,commandLog:[...this.state.commandLog,{requestId,documentId,operation:'project.read',startedAt:Date.now(),status:'running' as const}].slice(-200)});
    return promise as Promise<TResponse>;
  }

  async createNewProject<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(): Promise<TResponse> {
    const documentId=`project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,transfer=this.beginWorkspaceTransfer('project.create',documentId);
    try{
      if(!this.taskClient)throw new ModelingCommandError({ok:false,code:'PROJECT_CREATE_TASK_REQUIRED',error:'当前服务未启用新建工程任务协议，未清空或切换原工程。'},409);
      let input;try{input=normalizeProjectCreateInput({protocolVersion:1,operation:'project.create',documentId,sourceDocumentId:transfer.sourceDocumentId,requestId:transfer.requestId,name:'未命名工程',sourceRevision:transfer.revision,sourceStateToken:transfer.stateToken,sourceStateSequence:transfer.stateSequence});}catch{throw new ModelingCommandError({ok:false,code:'PROJECT_CREATE_SOURCE_UNCONFIRMED',error:'原工程版本尚未读取完整，请先载入当前工程，再新建。'},409);}
      try{await assertPiWorkspaceIdle(this.apiRoot,this.fetchImpl,transfer.sourceDocumentId);}catch(reason){throw new ModelingCommandError({ok:false,code:'PI_DOCUMENT_NOT_IDLE',error:reason instanceof Error?reason.message:'AI 助手状态尚未确认，未创建新工程。'},409);}
      if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'核对助手期间原工程已变化，未提交新建任务。'},409);
      const packet=await this.taskClient.run(input,async(headers,frozen)=>{
        const response=await this.fetchImpl(`${this.apiRoot}/documents/${encodeURIComponent(documentId)}/project/create`,{method:'POST',headers:{'Content-Type':'application/json',...headers,'X-Request-Id':transfer.requestId},body:JSON.stringify({command:frozen})});
        return {ok:response.ok,status:response.status,payload:await response.json()};
      });
      if(!packet.ok||!packet.payload.ok)throw new ModelingCommandError(packet.payload as ModelingCommandErrorPayload,packet.status);
      let result:TResponse;
      try{
        result=await this.activateWorkspaceView<TResponse>(transfer);
      }catch(reason){
        if(reason instanceof ModelingCommandError&&reason.code==='WORKSPACE_TRANSFER_SUPERSEDED')throw reason;
        throw new ModelingCommandError({ok:false,code:'PROJECT_CREATE_VIEW_UNAVAILABLE',error:'新工程已创建，但当前状态暂未载入，原工程仍保留。请在任务条选择“打开目标工程”；不要重复新建。',details:{targetDocumentId:documentId}},503);
      }
      this.adoptWorkspaceResult(result,documentId);this.finishCommandLog(transfer.requestId,{status:'success',revision:result.revision});return result;
    }catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
  }
  async importStep<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(file: Blob): Promise<TResponse> {
    this.assertWorkspaceSwitchable();
    const documentId=this.state.documentId,requestId=createRequestId('step-import'),operation='step.import',now=new Date().toISOString();
    const suppliedName=(file as Blob&{name?:unknown}).name,fileName=typeof suppliedName==='string'?[...suppliedName].slice(0,120).join(''):'import.step';
    const initial:StepImportStatus={version:1,documentId,requestId,fileName,phase:'receiving',sequence:0,createdAt:now,updatedAt:now};
    const headers:Record<string,string>={'Content-Type':'application/step','X-Request-Id':requestId,'X-File-Name':encodeURIComponent(fileName)};
    if(this.state.stateToken)headers['X-Base-State-Token']=this.state.stateToken;
    if(this.state.revision!==null)headers['X-Base-Revision']=String(this.state.revision);
    const transfer:ModelingStepImportRequest={protocolVersion:1,operation,documentId,requestId,fileName,expectedBytes:file.size,...(this.state.stateToken?{baseStateToken:this.state.stateToken}:{}),...(this.state.revision!==null?{baseRevision:this.state.revision}:{})};
    this.pendingCommands.set(requestId,operation);
    this.update({pendingOperation:operation,lastRequestId:requestId,error:null,busy:true,stepImportStatus:initial,stepImportNotice:null,commandLog:[...this.state.commandLog,{requestId,documentId,operation,startedAt:Date.now(),status:'running' as const}].slice(-200)});
    let receivedStatus:StepImportStatus|null=null;
    try {
      const submit=async(taskHeaders:Record<string,string>)=>{
        const response=await this.fetchImpl(`${this.apiRoot}/documents/${encodeURIComponent(documentId)}/imports/step`,{method:'POST',headers:{...headers,...taskHeaders},body:file});
        let payload:ModelingCommandResponse|ModelingCommandErrorPayload;
        try{payload=await response.json();}catch{throw new ModelingCommandError({ok:false,documentId,requestId,code:'STEP_IMPORT_RESULT_UNKNOWN',error:`导入响应未确认（HTTP ${response.status}）；不要重复上传，请查看导入记录并核对工程。`,recoverable:false},response.status);}
        if(!payload||typeof payload!=='object'||typeof payload.ok!=='boolean')throw new ModelingCommandError({ok:false,documentId,requestId,code:'STEP_IMPORT_RESULT_UNKNOWN',error:'导入响应不符合协议；不要重复上传，请核对工程。',recoverable:false},response.status);
        return {ok:response.ok,status:response.status,payload};
      };
      const packet=this.taskClient?await this.taskClient.run(transfer,submit):await submit({}),payload=packet.payload;
      try{receivedStatus=normalizeStepImportStatus((payload as {stepImportStatus?:unknown}).stepImportStatus??null,documentId,requestId);}catch{/* Geometry outcome and phase-report transport are independently verified. */}
      if(!packet.ok||!payload.ok)throw new ModelingCommandError(payload as ModelingCommandErrorPayload,packet.status);
      if(payload.documentId!==documentId||!Number.isSafeInteger(payload.revision)||Number(payload.revision)<0||typeof payload.stateToken!=='string'||!/^[a-f0-9]{64}$/.test(payload.stateToken)||!Number.isSafeInteger(payload.stateSequence)||Number(payload.stateSequence)<0)throw new ModelingCommandError({ok:false,documentId,requestId,code:'STEP_IMPORT_RESULT_UNKNOWN',error:'导入结果缺少当前工程的有效状态证明；不要重复上传，请核对工程。',recoverable:false},packet.status);
      const result=payload as TResponse;
      this.finishCommandLog(requestId,{status:'success',revision:result.revision,warningCount:result.warnings?.length||0,warnings:result.warnings?.slice(0,20).map(value=>String(value).slice(0,1000))});
      if(documentId===this.state.documentId){
        this.acceptResponse(result);
        let status:StepImportStatus|null=null;try{status=normalizeStepImportStatus(result.stepImportStatus??null,documentId,requestId);}catch{/* A valid committed command is not undone by an unavailable phase report. */}
        this.update({stepImportStatus:status||{...initial,...(result.modelingTask?{taskId:(result.modelingTask as ModelingTaskStatus).taskId}:{}),phase:'complete',updatedAt:new Date().toISOString(),revision:result.revision,stateToken:result.stateToken,report:stepImportReport(result.stepImport)},stepImportNotice:status?null:'导入已完成；阶段报告暂不可用，完整工程结果已接收。'});
      }
      return result;
    } catch (caught) {
      const reason=caught instanceof ModelingTaskClientError?new ModelingCommandError(caught.payload,caught.status):caught;
      const error=reason instanceof ModelingCommandError?reason:new ModelingCommandError({ok:false,requestId,documentId,code:'STEP_IMPORT_RESULT_UNKNOWN',error:'连接中断，导入结果尚未确认；不要重复上传，请查询导入记录并核对工程。',recoverable:false},0);
      const cancelled=error.modelingTask?.phase==='cancelled';
      this.finishCommandLog(requestId,{status:cancelled?'cancelled':'error',code:error.code,message:error.message});
      if(documentId===this.state.documentId){const uncertain=error.modelingTask?.phase==='unknown'||['STEP_IMPORT_RESULT_UNKNOWN','FRONTEND_GATEWAY_UNAVAILABLE','PROJECT_ROLLBACK_FAILED','PROJECT_RECOVERY_REQUIRED','WORKER_TIMEOUT','SERVICE_STOPPING'].includes(error.code);const previous=this.state.stepImportStatus?.requestId===requestId?this.state.stepImportStatus:initial;this.update({error:cancelled?null:{ok:false,documentId,requestId,code:error.code,error:error.message,recoverable:error.recoverable},stepImportStatus:previous.phase==='complete'?previous:receivedStatus&&receivedStatus.phase!=='complete'?receivedStatus:{...previous,phase:uncertain?'unknown':'failed',sequence:0,updatedAt:new Date().toISOString(),code:error.code,error:error.message},...(previous.phase==='complete'?{stepImportNotice:'导入响应未完整接收，但后台记录显示已完成；请核对当前工程。'}:{})});}
      throw error;
    }finally{this.pendingCommands.delete(requestId);this.update({busy:this.pendingCommands.size>0||this.hasPendingMutation(),pendingOperation:[...this.pendingCommands.values()].at(-1)||null});}
  }

  async refreshStepImportStatus(requestId?:string,documentId=this.state.documentId){
    const requestedFrom=this.state.stepImportStatus?.requestId;
    try{
      const response=await this.fetchImpl(`${this.apiRoot}/documents/${encodeURIComponent(documentId)}/imports/step/status${requestId?'?requestId='+encodeURIComponent(requestId):''}`,{signal:AbortSignal.timeout(15000)}),payload=await response.json();
      if(!response.ok||!payload?.ok)throw new Error(payload?.error||'无法读取 STEP 导入记录。');
      if(payload.documentId!==documentId)throw new Error('STEP 导入记录不属于当前工程，未采用该结果。');
      const status=normalizeStepImportStatus(payload.stepImportStatus??null,documentId,requestId);
      if(documentId===this.state.documentId){
        const previous=this.state.stepImportStatus;
        if(previous?.documentId===documentId){
          if(!requestId&&previous.requestId!==requestedFrom)return previous;
          if(status&&previous.requestId!==status.requestId&&(requestId||Date.parse(status.createdAt)<Date.parse(previous.createdAt)))return previous;
          if(status&&previous.requestId===status.requestId&&(status.sequence<previous.sequence||previous.phase==='complete'&&status.phase!=='complete'))return previous;
        }
        if(status||!requestId)this.update({stepImportStatus:status,stepImportNotice:null,busy:this.pendingCommands.size>0||Boolean(this.taskClient?.hasPending(documentId))||Boolean(status&&activeStepImport(status.phase))});
      }
      return status;
    }catch(error){const current=this.state.stepImportStatus;if(documentId===this.state.documentId&&(requestId?(!current||current.requestId===requestId):current?.requestId===requestedFrom))this.update({stepImportNotice:error instanceof Error?error.message:'导入记录连接暂不可用。'});throw error;}
  }

  async loadBodyPresentation<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(bodyId: string): Promise<TResponse> {
    const request = normalizeCommandRequest({ operation: "body.presentation", inputs: { bodyId } }, this.state.documentId);
    const response = await this.fetchImpl(`${this.apiRoot}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload = await response.json() as TResponse | ModelingCommandErrorPayload;
    if (!response.ok || !payload.ok) {
      const errorPayload = payload as ModelingCommandErrorPayload;
      throw new ModelingCommandError(errorPayload, response.status);
    }
    return payload as TResponse;
  }

  async loadAssemblyPreview<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(offset = 0, limit = 0): Promise<TResponse> {
    const request = normalizeCommandRequest({ operation: "document.preview", inputs: {}, parameters: { offset, limit } }, this.state.documentId);
    const response = await this.fetchImpl(`${this.apiRoot}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload = await response.json() as TResponse | ModelingCommandErrorPayload;
    if (!response.ok || !payload.ok) {
      const errorPayload = payload as ModelingCommandErrorPayload;
      throw new ModelingCommandError(errorPayload, response.status);
    }
    return payload as TResponse;
  }

  async exportStep(): Promise<string> {
    this.assertNoWorkspaceTransfer();
    const requestId = createRequestId("step-export");
    this.update({ pendingOperation: "step.export", lastRequestId: requestId, error: null, busy: true });
    try {
      const response = await this.fetchImpl(`${this.apiRoot}/documents/${encodeURIComponent(this.state.documentId)}/exports/step`, {
        method: "POST",
        headers: { "X-Request-Id": requestId },
      });
      const payload = await response.json() as ModelingCommandResponse & { downloadUrl?: string } | ModelingCommandErrorPayload;
      if (!response.ok || !payload.ok || !("downloadUrl" in payload) || !payload.downloadUrl) {
        const errorPayload = payload as ModelingCommandErrorPayload;
        this.update({ error: errorPayload, pendingOperation: null, busy: false });
        throw new ModelingCommandError(errorPayload, response.status);
      }
      this.update({ pendingOperation: null, busy: false });
      const downloadUrl = payload.downloadUrl;
      return downloadUrl.startsWith("http") ? downloadUrl : `${this.apiRoot.replace(/\/api$/, "")}${downloadUrl}`;
    } catch (reason) {
      if (reason instanceof ModelingCommandError) throw reason;
      const errorPayload: ModelingCommandErrorPayload = { ok: false, requestId, documentId: this.state.documentId, code: "NETWORK_ERROR", error: reason instanceof Error ? reason.message : "STEP export failed.", recoverable: true };
      this.update({ pendingOperation: null, busy: false, error: errorPayload });
      throw new ModelingCommandError(errorPayload, 0);
    }
  }
  async saveProject(): Promise<Blob> {
    const transfer=this.beginWorkspaceTransfer('project.save',this.state.documentId);
    if(this.taskClient){
      try{
        const input:ProjectSaveInput={protocolVersion:1,operation:'project.save',documentId:transfer.sourceDocumentId,requestId:transfer.requestId,...(transfer.revision===null?{}:{baseRevision:transfer.revision}),...(transfer.stateToken?{baseStateToken:transfer.stateToken}:{}),...(transfer.stateSequence===null?{}:{baseStateSequence:transfer.stateSequence})};
        const packet=await this.taskClient.run(input,async(headers,command)=>{const response=await this.fetchImpl(`${this.apiRoot}/documents/${encodeURIComponent(transfer.sourceDocumentId)}/project/save`,{method:'POST',headers:{'Content-Type':'application/json','X-Request-Id':transfer.requestId,...headers},body:JSON.stringify({command})});let payload;try{payload=await response.json();}catch{throw new Error('保存回复不是有效 JSON，请检查原任务；不会重新生成。');}return {ok:response.ok,status:response.status,payload};});
        if(!packet.ok||!packet.payload.ok)throw new ModelingCommandError(packet.payload as ModelingCommandErrorPayload,packet.status);
        if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'备份已生成，但当前工程状态已变化；未启动下载。请从原保存任务下载，不要重新生成。'},409);
        const task=this.state.modelingTasks.find(item=>item.task.documentId===transfer.sourceDocumentId&&item.task.requestKey===transfer.requestId)?.task;if(!task)throw new Error('未持有原保存任务身份，未开始下载。');
        const file=await this.taskClient.downloadBackup(task.taskId);
        if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'备份已生成并读取，但当前工程状态已变化；未启动旧页面的下载。可从原任务再次下载。'},409);
        this.finishCommandLog(transfer.requestId,{status:'success',revision:task.revision,message:'后台已生成固定备份，文件已读取并校验；浏览器下载不代表本地保存完成。'});return file;
      }catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
    }
    try{const response=await this.fetchImpl(`${this.apiRoot}/documents/${encodeURIComponent(transfer.sourceDocumentId)}/project/save`,{method:'POST',headers:{'X-Request-Id':transfer.requestId}});
      if(!response.ok){const payload=await response.json().catch(()=>({ok:false,code:'INVALID_RESPONSE',error:'工程备份服务返回非 JSON 错误。'})) as ModelingCommandErrorPayload;throw new ModelingCommandError(payload,response.status);}
      if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/vnd.webcad.project')throw new ModelingCommandError({ok:false,code:'INVALID_RESPONSE',error:'工程备份响应不是工程文件，未下载。'},response.status);
      const file=await response.blob();if(!this.ownsWorkspaceTransfer(transfer))throw new ModelingCommandError({ok:false,code:'WORKSPACE_TRANSFER_SUPERSEDED',error:'备份已生成，但工程状态已变化；未将旧文件作为当前工程备份下载。'},409);
      this.finishCommandLog(transfer.requestId,{status:'success',message:'后台已生成工程备份；浏览器下载不代表本地保存已完成。'});return file;
    }catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
  }

  async openProject<TResponse extends ModelingCommandResponse = ModelingCommandResponse>(file: Blob): Promise<TResponse> {
    // Do not replace the visible workspace identity until the complete file is accepted.
    const documentId = `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
    const transfer=this.beginWorkspaceTransfer('project.open',documentId);
    try{
      if(!this.taskClient)throw new ModelingCommandError({ok:false,code:'PROJECT_OPEN_TASK_REQUIRED',error:'工程文件打开需要任务协议，未上传文件或切换原工程。'},409);
      await this.preflightWorkspaceTransfer(transfer);
      const submit=async(headers:Record<string,string>,fileName?:string)=>this.fetchImpl(`${this.apiRoot}/documents/${encodeURIComponent(documentId)}/project/open`,{method:'POST',headers:{'Content-Type':'application/vnd.webcad.project','X-Request-Id':transfer.requestId,...(fileName?{'X-File-Name':encodeURIComponent(fileName)}:{}),...headers},body:file});
      let result:TResponse;
      if(this.taskClient){
        const suppliedName=(file as Blob&{name?:unknown}).name,fileName=typeof suppliedName==='string'?suppliedName:'工程.cadproj';
        const input:ProjectOpenInput={protocolVersion:1,operation:'project.open',documentId,sourceDocumentId:transfer.sourceDocumentId,requestId:transfer.requestId,fileName,expectedBytes:file.size,...(transfer.revision!==null?{sourceRevision:transfer.revision}:{}),...(transfer.stateToken?{sourceStateToken:transfer.stateToken}:{}),...(transfer.stateSequence!==null?{sourceStateSequence:transfer.stateSequence}:{})};
        const packet=await this.taskClient.run(input,async(headers,frozen)=>{const response=await submit(headers,frozen.fileName);let payload;try{payload=await response.json();}catch{throw new Error('工程服务返回非 JSON 响应，请核对原任务。');}return {ok:response.ok,status:response.status,payload};});
        if(!packet.ok||!packet.payload.ok)throw new ModelingCommandError(packet.payload as ModelingCommandErrorPayload,packet.status);
        // A receipt proves the original commit, not the target's current view.
        await this.readWorkspaceResponse<TResponse>(new Response(JSON.stringify(packet.payload),{headers:{'Content-Type':'application/json'}}),transfer);
        try{
          result=await this.activateWorkspaceView<TResponse>(transfer);
        }catch(reason){
          if(reason instanceof ModelingCommandError&&reason.code==='WORKSPACE_TRANSFER_SUPERSEDED')throw reason;
          throw new ModelingCommandError({ok:false,code:'PROJECT_OPEN_VIEW_UNAVAILABLE',error:'目标工程已创建，但最新模型暂未载入。请使用任务条的“打开目标工程”或恢复工程列表；不要再次上传。',documentId,requestId:transfer.requestId,modelingTask:this.state.modelingTasks.find(item=>item.task.documentId===documentId&&item.task.requestKey===transfer.requestId)?.task,details:{targetDocumentId:documentId}},503);
        }
      }else throw new ModelingCommandError({ok:false,code:'PROJECT_OPEN_TASK_REQUIRED',error:'工程文件打开需要任务协议，未切换原工程。'},409);
      this.adoptWorkspaceResult(result,documentId);this.finishCommandLog(transfer.requestId,{status:'success',revision:result.revision});return result;
    }catch(reason){throw this.workspaceTransferFailure(transfer,reason);}finally{this.endWorkspaceTransfer(transfer);}
  }

  private readRevision(model: TModel) {
    if (typeof model === "object" && model !== null && "revision" in model) {
      const revision = (model as { revision?: unknown }).revision;
      return typeof revision === "number" ? revision : this.state.revision;
    }
    return this.state.revision;
  }

  private isModelSnapshot(value: unknown): value is TModel {
    return typeof value === "object" && value !== null && ("bodyPresentations" in value || "positions" in value || "features" in value);
  }

  private readBodyId(model: TModel) {
    if (typeof model === "object" && model !== null && "bodyId" in model) {
      const bodyId = (model as { bodyId?: unknown }).bodyId;
      return typeof bodyId === "string" ? bodyId : null;
    }
    return null;
  }
  private update(patch: Partial<ModelingControllerState<TModel>>) {
    this.state = { ...this.state, ...(patch.documentId&&patch.documentId!==this.state.documentId?{modelingTaskNotice:null}:{}), ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export function useModelingController<TModel>(controller: ModelingController<TModel>) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
}
