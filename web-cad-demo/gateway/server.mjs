import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { projectStateToken, mutationFingerprint } from "./project-state.mjs";
import { selectionStateProblem, selectionBindingPaths, SELECTION_STATE_POLICY } from "./selection-precondition.mjs";
import {nativeGeometryFeatures,capabilitySnapshot,validateCapabilityPrecondition,assertCapabilityPrecondition,assertImportedNamingUpgrade,WorkerCapabilityError} from './worker-capabilities.mjs';
import { validateBatchSelectionProvenance } from "./batch-selection-provenance.mjs";
import { failedBatchResults } from "./batch-outcome.mjs";
import {StepImportTasks} from './step-import-tasks.mjs';
import {ProjectOpenTasks} from './project-open-tasks.mjs';
import {ProjectCreateTasks} from './project-create-tasks.mjs';
import {ProjectSaveTasks} from './project-save-tasks.mjs';
import {normalizeWorkspaceActivation} from '../shared/workspace-activation.mjs';
import {normalizeWorkspaceRead} from '../shared/workspace-read.mjs';
import {ProjectBackupStore,ProjectBackupError} from './project-backup-store.mjs';
import {ProjectBackupCatalog} from './project-backup-catalog.mjs';
import {ProjectBackupMaintenance} from './project-backup-maintenance.mjs';
import {streamProjectBackup} from './project-backup-download.mjs';
import {SpatialMeasurementCache,compactSpatialMeasurement} from './spatial-cache.mjs';
import {nearestBoundsRelations} from './spatial-relations.mjs';
import {DocumentLoader,DocumentLoadError} from './document-loader.mjs';
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistentHistoryStore,historyRecoveryWarning } from "./history-store.mjs";
import {IdempotencyOutcomeError} from './idempotency-outcome-store.mjs';
import { ProviderStore, assertProviderUrl, selectProvider } from "./llm/provider-config.mjs";
import { requestModelingPlan, streamModelingPlan, requestCadToolTurn, testProvider } from "./llm/openai-compatible-client.mjs";
import { agentSystemPrompt, normalizeOperation, validateModelingPlan } from "./llm/plan-validator.mjs";
import { toolCallsToModelingPlan, isCadQueryToolCall, isCadMutationTool } from "./llm/cad-tools.mjs";
import { buildConversationContext } from "./llm/context-manager.mjs";
import { AgentResourceStore, resourceDirectories } from "./llm/agent-resources.mjs";
import { AgentConversationStore } from "./agent-conversation-store.mjs";
import { AgentRunStore } from "./agent-run-store.mjs";
import { AgentAuditStore } from "./llm/agent-audit-store.mjs";
import { buildValidatedAgentPlan, reportAgentPlan } from "./llm/agent-plan-pipeline.mjs";
import { resolveAgentPlan } from "./llm/agent-resolver.mjs";
import { CAD_OPERATION_NAMES, isReadOnlyCadOperation } from "./llm/command-catalog.mjs";
import { ProviderHealthRegistry } from "./llm/provider-health.mjs";
import { confirmationFingerprint, sameConfirmationFingerprint } from "./llm/agent-confirmation.mjs";
import { resolveWritableDataDir } from "./data-dir.mjs";
import {acquireDataDirectoryWriter} from './data-directory-writer.mjs';
import {childExit,waitChildExit} from './child-exit.mjs';
import {NativeRequestChannel,NativeChannelError} from './native-request-channel.mjs';
import {geometryMemoryPolicy,meshMemoryPolicy,assertNativeMemoryGuard,nativeResourceExitError} from './native-resource-policy.mjs';
import {MeshStorageBudget,meshStoragePolicy} from './mesh-storage-budget.mjs';
import {DocumentActionQueue,DocumentActionError,documentActionLimits} from './document-action-queue.mjs';
import {PendingProjectInputs,PendingProjectInputError} from './pending-project-inputs.mjs';
import {gatewayErrorStatus} from './gateway-error-status.mjs';
import {ModelingTaskService,ModelingTaskError} from './modeling-task-service.mjs';
import {CommandJournal} from './command-journal.mjs';
import {PiWriteApprovals, requiresPiWriteApproval, summarizePiWrite} from './pi-write-approval.mjs';
import {handleModelingTaskRoute,authorizeModelingTaskRequest} from './modeling-task-routes.mjs';
import {ShutdownControl} from './shutdown-control.mjs';
import { corsHeaders, resolveCorsOrigin } from "./cors.mjs";
import { PropertySchemaStore } from "./property-schema-store.mjs";
import {MeshStrategyStore} from './mesh-strategy-store.mjs';
import {ProjectDataStore} from './project-data-store.mjs';
import {meshStrategyHash} from './mesh-strategy-proof.mjs';
import {meshStrategyState,meshStrategyKeys,normalizeMeshStrategyOptions} from '../shared/mesh-strategy.mjs';
import {validateMeshSizingSource} from '../shared/mesh-sizing.mjs';
import { checkPropertyTarget, resolvePropertySchema } from "./property-associations.mjs";
import {PropertyAssociationCache} from './property-association-cache.mjs';
import { GuardedMeshWorkerClient as MeshWorkerClient } from "./guarded-mesh-worker-client.mjs";
import { handleMeshRoute } from "./mesh-routes.mjs";
import {ProjectMeshService,isProjectMeshRoute} from "./project-mesh-service.mjs";
import {ProjectMeshAssets} from './project-mesh-assets.mjs';
import {streamCheckedMesh} from './mesh-download.mjs';
import { PiRpcRuntime, PiSessionError, normalizePiSessionId } from "./pi-rpc-runtime.mjs";
import {attachPiEventStream} from './pi-event-stream.mjs';
import { buildPiProviderConfig } from "./pi-provider-config.mjs";
import { ProjectFileService } from "./project-file-service.mjs";
import { WorkspaceCatalog } from "./workspace-catalog.mjs";
import { ProjectTransactionService, ProjectTransactionError } from "./project-transaction-service.mjs";
import {StepImportStore,StepImportError} from './step-import-store.mjs';
import {SnapshotSourceInspector,SourceInspectionError} from './snapshot-source-inspector.mjs';
import {StepSourceError} from './step-source-integrity.mjs';
import {SourceAuditService,SourceAuditError} from './source-audit-service.mjs';
import {SourceCheckpointCatalog} from './source-checkpoint-catalog.mjs';
import {SourceAccessGate} from './source-access-gate.mjs';
import {SourceFileSwap} from './source-file-swap.mjs';
import {SourceRestoreProof} from './source-restore-proof.mjs';
import {SourceRestoreTransactions} from './source-restore-transactions.mjs';
import {SourceRestoreService,SourceRestoreServiceError} from './source-restore-service.mjs';
import {handleSourceRestoreRoute} from './source-restore-routes.mjs';
import { PROJECT_MIME, PROJECT_EXTENSION, ProjectFileError } from "./project-package.mjs";
import {backendRuntimeInfo,backendPiRuntime,backendDiscreteRuntime,backendMeshRuntime} from './backend-runtime.mjs';
import {configureDiscreteSurfaceRuntime} from './discrete-surface-runtime.mjs';
import {configureDiscreteTetraRuntime} from './discrete-tetra-runtime.mjs';

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(process.env.CAD_APPLICATION_ROOT || codeRoot);
const startup={mode:'on-demand',startedAt:new Date().toISOString(),catalogMs:0,recoveryMs:0,workerHandshakeMs:0,readyAt:null};
const startupClock=performance.now();
try { process.loadEnvFile(path.join(rootDir, '.env')); } catch { /* optional .env */ }
const backendRelease=backendRuntimeInfo(codeRoot);
const surfaceRuntime=configureDiscreteSurfaceRuntime({mode:backendRelease.mode,sealed:backendDiscreteRuntime()});
const discreteTetraRuntime=configureDiscreteTetraRuntime({mode:backendRelease.mode,sealedMesh:backendMeshRuntime(),surfaceRuntime});
// Reject invalid/unqualified resource policy before opening persistent stores.
const workerMemoryPolicy=geometryMemoryPolicy();
const meshWorkerMemoryPolicy=meshMemoryPolicy();
const meshDiskPolicy=meshStoragePolicy();
const documentActions=new DocumentActionQueue(documentActionLimits());
const workerPath = path.resolve(process.env.GEOMETRY_WORKER_PATH || path.join(rootDir, "geometry-worker", "build", "occt_geometry_worker.exe"));
const meshWorkerPath = path.resolve(process.env.MESH_WORKER_PATH || path.join(rootDir, "mesh-worker", "build-gmsh", "gmsh_mesh_worker.exe"));
const configuredDataDir = path.resolve(process.env.GEOMETRY_DATA_DIR || path.join(rootDir, ".data"));
const dataDir = resolveWritableDataDir(configuredDataDir, {
  allowTemporaryFallback: process.env.GEOMETRY_ALLOW_TEMP_DATA_FALLBACK === "true",
  fallbackRoot: os.tmpdir(),
  onFallback: ({ configured, fallback }) => process.stderr.write(`[data] ${configured} is not writable; using ${fallback}.\n`),
});
// Must precede every persistent store, catalog migration and recovery routine.
let dataWriter;
try{dataWriter=acquireDataDirectoryWriter(dataDir,{helperPath:process.env.CAD_NATIVE_LOCK_PATH||path.join(rootDir,'geometry-worker','build','cad_data_directory_lock.exe')});}catch(error){process.stderr.write(JSON.stringify({type:'cad.startup',phase:'blocked',code:error.code||'DATA_DIRECTORY_LOCK_FAILED',error:error.message})+'\n');process.exit(73);}
const occtBin = process.env.CAD_NATIVE_GEOMETRY_BIN||path.resolve(rootDir, "..", "install-mingw-ucrt64", "win64", "gcc", "bin");
const mingwBin = process.env.CAD_NATIVE_GEOMETRY_BIN?"":"C:\\msys64\\ucrt64\\bin";
const host = process.env.GEOMETRY_HOST || "127.0.0.1";
const port = Number(process.env.GEOMETRY_PORT || 8788);
const webOrigin = process.env.WEB_ORIGIN || "http://localhost:3000";
function envLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}
const requestTimeoutMs = envLimit("GEOMETRY_REQUEST_TIMEOUT_MS", 15_000);
const workerTimeoutMs = envLimit("GEOMETRY_WORKER_TIMEOUT_MS", requestTimeoutMs);
const workerRestartDelayMs = envLimit("GEOMETRY_WORKER_RESTART_MS", 250);
const maxJsonBodyBytes = envLimit("GEOMETRY_JSON_LIMIT_BYTES", 1_000_000);
const maxStepUploadBytes = envLimit("GEOMETRY_STEP_LIMIT_BYTES", 50 * 1024 * 1024);
const maxProjectUploadBytes = envLimit("GEOMETRY_PROJECT_LIMIT_BYTES",256*1024*1024);
const pendingProjectInputs=new PendingProjectInputs(dataDir,{timeoutMs:Math.min(requestTimeoutMs,600000)});
const pendingStepInputs=new PendingProjectInputs(dataDir,{directoryName:'pending-step-inputs',timeoutMs:Math.min(requestTimeoutMs,600000)});
const maxProjectUnpackedBytes = envLimit("GEOMETRY_PROJECT_UNPACKED_LIMIT_BYTES",512*1024*1024);
const maxWorkerResponseBytes = envLimit("GEOMETRY_WORKER_RESPONSE_LIMIT_BYTES", 256 * 1024 * 1024);
const workerStartupTimeoutMs=Math.min(envLimit('GEOMETRY_WORKER_STARTUP_TIMEOUT_MS',Math.max(workerTimeoutMs,5000)),300000);
const workerStopTimeoutMs=Math.min(envLimit('GEOMETRY_WORKER_STOP_TIMEOUT_MS',5000),30000);
const workerQueueLimits={maxRequestBytes:Math.min(envLimit('GEOMETRY_WORKER_REQUEST_LIMIT_BYTES',4*1024*1024),8*1024*1024),maxPendingBytes:Math.min(envLimit('GEOMETRY_WORKER_PENDING_BYTES',16*1024*1024),64*1024*1024),maxPendingRequests:Math.min(envLimit('GEOMETRY_WORKER_PENDING_REQUESTS',64),256)};
const maxBatchResultBytes=Math.min(envLimit('GEOMETRY_BATCH_RESULT_BYTES',64*1024*1024),64*1024*1024);
const shutdownGraceMs=Math.min(envLimit('GEOMETRY_SHUTDOWN_GRACE_MS',10000),30000);
const shutdownStopMs=Math.min(envLimit('GEOMETRY_SHUTDOWN_STOP_MS',5000),10000);
const shutdownBudgetMs=shutdownGraceMs+shutdownStopMs+2000;
const shutdownControl=new ShutdownControl(dataDir,dataWriter,{port,budgetMs:shutdownBudgetMs});
const agentTimeoutMs = envLimit("AGENT_REQUEST_TIMEOUT_MS", 120_000);
const agentRetryAttempts = Math.min(envLimit("AGENT_RETRY_ATTEMPTS", 2), 4);
const agentRetryDelayMs = envLimit("AGENT_RETRY_DELAY_MS", 1_000);
const agentLoopMaxTurns = Math.min(envLimit("AGENT_LOOP_MAX_TURNS", 8), 16);
const defaultGmshRuntimePath = fs.existsSync("C:\\msys64\\ucrt64\\bin\\libgmsh.dll") ? "C:\\msys64\\ucrt64\\bin" : path.dirname(meshWorkerPath);
const meshWorker = new MeshWorkerClient({
  memoryPolicy:meshWorkerMemoryPolicy,
  workerPath: meshWorkerPath,
  runtimePath: process.env.GMSH_BIN || defaultGmshRuntimePath,
  timeoutMs: envLimit("MESH_WORKER_TIMEOUT_MS", 120_000),
});
const agentResources = new AgentResourceStore(resourceDirectories());
const agentConversations = new AgentConversationStore(dataDir);
const agentRuns = new AgentRunStore(dataDir);
const agentAudit = new AgentAuditStore(dataDir);
const propertySchemaStore = new PropertySchemaStore(dataDir);
const propertyAssociationCache=new PropertyAssociationCache();
const meshStrategyStore=new MeshStrategyStore(dataDir);
const projectDataStore=new ProjectDataStore({propertySchemaStore,meshStrategyStore});
const bundledPi=backendPiRuntime();
const piRepository = bundledPi?.cwd||path.resolve(rootDir, "..", "pi");
const piCliPath = bundledPi?.cliPath||process.env.PI_CLI_PATH || path.join(piRepository, "node_modules", "tsx", "dist", "cli.mjs");
const piCliArgs = bundledPi?.cliArgs||(process.env.PI_CLI_PATH ? [] : [path.join(piRepository, "packages", "coding-agent", "src", "cli.ts")]);
const piRuntime = new PiRpcRuntime({
  cliPath: piCliPath,
  cliArgs: piCliArgs,
  extensionPath: path.join(codeRoot, "gateway", "pi-cad-mcp-extension.mjs"),
  cwd: path.resolve(process.env.PI_CLI_CWD || piRepository),
  sessionRoot: path.join(dataDir, "pi-sessions"),
  agentConfigDir: path.join(dataDir, "pi-agent-config"),
  // The embedded CAD adapter belongs to this Gateway instance, not an inherited
  // external address or the standalone MCP server's default development port.
  env: {...process.env,CAD_GEOMETRY_API_URL:`http://127.0.0.1:${port}/api`},
});
const isLivePi = session => Boolean(session && piRuntime.get(session.sessionId) === session && session.child && !session.closed && !session.disposed);
const piWriteApprovals = new PiWriteApprovals({
  currentState: id => projectStateToken(id,historyFor(id)),
  isLive: isLivePi,
});
function preparePiSessionConfig(sessionId,projectId) {
  const directory = path.join(dataDir, "pi-agent-config", normalizePiSessionId(sessionId));
  const { models, environment } = buildPiProviderConfig(providerStore.read());
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, "models.json");
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, JSON.stringify(models, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, configPath);
  fs.writeFileSync(path.join(directory, "APPEND_SYSTEM.md"), [
    "You are the CAD modeling assistant embedded in Web CAD Studio.",
    "Use only the CAD MCP tools registered by this session. Do not use filesystem, shell, code-editing, or network capabilities.",
    "Before modeling, call query_model to inspect the current document and its spatial summary.",
    "Discuss and clarify requirements when needed. When the user asks for changes, use the smallest appropriate CAD MCP command, preserve expression strings, and query the model after changes. There is no Plan/Edit mode switch.",
    "Report concrete dimensions, Body IDs, and revision changes from tool results. Never claim a change succeeded unless a tool confirms it.",
    "Deletion, consuming Boolean tools and batch_modify wait for a workbench approval card. Use batch_modify for a request to edit multiple existing Bodies together. A chat message is not a substitute for the card. If approval is cancelled or expires, stop that operation. After a stale approval read the latest project and reselect before proposing it again.",
  ].join("\n"), { mode: 0o600 });
  // A sealed SDK is code, not the user's Pi project. Local settings/packages
  // belong to this CAD project's persistent workspace, never the release tree.
  const projectCwd=bundledPi&&!process.env.PI_CLI_CWD?path.join(dataDir,'pi-workspaces',projectId):null;
  if(projectCwd)fs.mkdirSync(projectCwd,{recursive:true});
  return { agentConfigDir: directory, env: environment,...(projectCwd?{cwd:projectCwd}:{}) };
}

let worker;
let workerChannel;
let workerReady=false,workerHandshake=Promise.resolve();
let workerInstance=null,workerFeatures={},workerResourceGuard=null,workerResourceBlocked=null;
const nativeCapabilities=()=>({...capabilitySnapshot(workerInstance,geometryReady(),workerFeatures),...(geometryReady()&&workerResourceGuard?{resourceGuard:{...workerResourceGuard}}:{})});
const runtimeMetrics={workerRequests:0,geometryMeasureRequests:0,documentRestoreRequests:0};
let shuttingDown = false;
let forceStopping=false,shutdownPromise=null,shutdownPhase='running';
const runningDocuments=new Set(),geometryChildren=new Set(),activeResponses=new Set();
function cancelQueuedOperations(){void documentActions.close();}
function propertyAssociationAuthority(documentId){
  const history=historyStore.get(documentId);
  return {documentId,workerInstance,generation:documentLoader.generation,stateToken:projectStateToken(documentId,history),stateSequence:history.stateSequence,propertyVersion:propertySchemaStore.contentVersion(documentId),stable:geometryReady()&&runningDocuments.has(documentId)&&!projectTransactions.active.has(documentId)&&!history.restoreError&&!projectFiles.hasUnconfirmed(documentId)};
}
function resolveProjectProperties(documentId,view){return propertyAssociationCache.read(documentId,view,{authority:()=>propertyAssociationAuthority(documentId),loadSchema:()=>propertySchemaStore.list(documentId)});}
let restartTimer;
let requestSequence = 1;
let importSequence = 1;
const workerPending=()=>workerChannel?.status().pendingRequests||0;
const providerStore = new ProviderStore(dataDir);
const providerHealth = new ProviderHealthRegistry();
const historyStore = new PersistentHistoryStore(dataDir, {
  limit: 50,
  idempotencyLimit: 100,
  idempotencyBytes:Math.min(envLimit('GEOMETRY_IDEMPOTENCY_BYTES',256*1024*1024),256*1024*1024),
  projectData:{capture:id=>projectDataStore.list(id),validate:value=>projectDataStore.validateSnapshot(value)},
  onWarning: (message) => process.stderr.write(`${message}\n`),
});
const workspaces = new WorkspaceCatalog({dataDir,historyStore,propertySchemaStore,meshStrategyStore,getLoadState:id=>documentLoader.status(id)});
const sourceInspector=new SnapshotSourceInspector({executablePath:path.resolve(process.env.GEOMETRY_SOURCE_INSPECTOR_PATH||path.join(rootDir,'geometry-worker','build','cad_snapshot_source_inspector.exe')),roots:['history','project-assets','project-transactions','history-quarantine'].map(name=>path.join(dataDir,name)),env:{...process.env,PATH:[occtBin,mingwBin,process.env.PATH||''].filter(Boolean).join(path.delimiter)}});
const projectFiles = new ProjectFileService({dataDir,historyStore,propertySchemaStore,projectDataStore,command,inspectSources:file=>sourceInspector.inspect(file),maxUnpackedBytes:maxProjectUnpackedBytes,maxPackedBytes:maxProjectUploadBytes,onExecutionStart:()=>modelingTasks.enterExecuting(),onCommitStart:()=>modelingTasks.beginCommit(),onRecoveryStart:()=>modelingTasks.beginRecovery(),captureExecutionState:()=>documentLoader.generation,assertExecutionState:(_id,generation)=>{if(generation!==documentLoader.generation)throw new NativeChannelError('WORKER_INSTANCE_CHANGED','工程打开期间几何进程已变化，未提交跨进程结果；正在恢复原工程。');},onWarning:(message)=>process.stderr.write(`${message}\n`)});
function sourceHistorySignature(id){const history=historyStore.get(id);return createHash('sha256').update(JSON.stringify({stateToken:projectStateToken(id,history),...historyStore.sourceCheckpoints(id)})).digest('hex');}
const sourceCatalog=new SourceCheckpointCatalog({dataDir}),sourceAuditRegistry=new Set();
const sourceAudits=new SourceAuditService({dataDir,inspector:sourceInspector,activeRegistry:sourceAuditRegistry,signature:sourceHistorySignature,capture:(id,options)=>serializeDocument(id,async()=>{
  const history=historyStore.get(id);
  // Diagnostics must never call command(): lazy loading may recover an older
  // checkpoint and rewrite the timeline before the audit can observe damage.
  return {...await sourceCatalog.project(id,options),restoreError:history.restoreError,signature:sourceHistorySignature(id),revision:history.events?.findLast(event=>Number.isSafeInteger(event.afterRevision))?.afterRevision,stateToken:projectStateToken(id,history)};
},{loadDocument:false})});
const storageSourceAudits=new SourceAuditService({dataDir,inspector:sourceInspector,activeRegistry:sourceAuditRegistry,scope:'storage',maxCheckpoints:2048,maxSources:2000,maxReadBytes:2*1024*1024*1024,capture:(_id,options)=>sourceCatalog.storage(options)});
const sourceAccessGate=new SourceAccessGate();
const sourceSwap=new SourceFileSwap({dataDir,executablePath:process.env.CAD_NATIVE_SWAP_PATH||path.join(rootDir,'geometry-worker','build','cad_source_file_swap.exe')});
const sourceRestoreProof=new SourceRestoreProof({dataDir,catalog:sourceCatalog,inspector:sourceInspector,activeRegistry:sourceAuditRegistry});
const sourceRestoreTransactions=new SourceRestoreTransactions({dataDir,proof:sourceRestoreProof,swap:sourceSwap,gate:sourceAccessGate,maxCandidateBytes:Math.min(maxStepUploadBytes,200*1024*1024)});
const sourceRestores=new SourceRestoreService({dataDir,transactions:sourceRestoreTransactions,maxUploadBytes:sourceRestoreTransactions.maxCandidateBytes,resolveAsset:({scope,documentId,auditJobId,assetId})=>(scope==='storage'?storageSourceAudits:sourceAudits).resolveAsset(documentId,auditJobId,assetId)});
sourceCatalog.restorationCapture=options=>sourceRestores.catalogEvidence(options);
const documentLoader=new DocumentLoader({historyStore,
  restore:(id,file)=>sendCommand({protocolVersion:1,requestId:`gateway-load-${requestSequence++}`,operation:'document.restore',documentId:id,parameters:{path:file}}),
  applyProjectData:(id,schema)=>projectDataStore.replaceSnapshot(id,schema,{preserveUpdatedAt:true}),
  recoverCheckpoint:(id,history,file,result,schema)=>{
    quarantineInvalidSnapshot(id,history.current,true);
    if(schema)projectDataStore.replaceSnapshot(id,schema,{preserveUpdatedAt:true});
    historyStore.commit(id,{...history,current:file,undo:[],redo:[],restoreError:null,idempotency:[],events:[...history.events,{eventId:`recovered-checkpoint-${Date.now()}-${process.pid}`,operation:'history.recover-checkpoint',beforeRevision:history.events.at(-1)?.afterRevision,afterRevision:result.revision,timestamp:new Date().toISOString()}]});
    process.stderr.write(`[history] ${id}: recovered the last readable checkpoint; original bytes preserved in quarantine.\n`);
  },
  onProgress:(id,phase)=>process.stdout.write(JSON.stringify({type:'cad.document.load',documentId:id,phase})+'\n'),
});
const loadedDocuments = documentLoader.loaded;
const meshCacheBytes=envLimit('GEOMETRY_MESH_CACHE_BYTES',4*1024**3),meshMaxJobs=envLimit('GEOMETRY_MESH_MAX_JOBS',2000);
const meshStorage=new MeshStorageBudget({dataDir,policy:meshDiskPolicy});
const projectMeshes = new ProjectMeshService({dataDir,command,serializeDocument,worker:meshWorker,surfaceWorkerFactory:surfaceRuntime.factory,discreteTetraWorkerFactory:discreteTetraRuntime.factory,discreteTetraMemoryLimitBytes:discreteTetraRuntime.memoryLimitBytes,getCapabilities:nativeCapabilities,surfaceMemoryLimitBytes:surfaceRuntime.memoryLimitBytes,storageBudget:meshStorage,cacheLimits:{maxBytes:meshCacheBytes,maxJobBytes:envLimit('GEOMETRY_MESH_CACHE_JOB_BYTES',Math.min(1024**3,Math.floor(meshCacheBytes/2)))},maxStoredJobs:meshMaxJobs,maxJobsPerDocument:envLimit('GEOMETRY_MESH_MAX_JOBS_PER_DOCUMENT',Math.min(500,meshMaxJobs)),getPropertySchema:resolveProjectProperties,getMeshStrategy:referencedMeshStrategy});
const projectMeshAssets=new ProjectMeshAssets({host:projectMeshes,projectBusy:id=>projectFiles.hasUnconfirmed(id)||projectTransactions.active.has(id)});
projectFiles.meshIntegration=projectMeshAssets;projectMeshes.assets=projectMeshAssets;
const spatialSummaryCache = new SpatialMeasurementCache();
const projectTransactions=new ProjectTransactionService({dataDir,historyStore,propertySchemaStore,projectDataStore,command,
  captureExecutionState:()=>documentLoader.generation,
  assertExecutionState:(_id,generation)=>{if(generation!==documentLoader.generation)throw new NativeChannelError('WORKER_INSTANCE_CHANGED','事务执行期间几何进程已变化，未提交跨进程结果；正在恢复原完整检查点。');},
  onExecutionStart:()=>modelingTasks.enterExecuting(),
  onRecoveryStart:()=>modelingTasks.beginRecovery(),
  prepareHistory:async id=>{let history=historyStore.repair(id);if(history.restoreError)history=await recoverLiveCheckpoint(id,history,loadedDocuments.has(id));return history;},
  onWarning:message=>process.stderr.write(message+"\n"),
});
let stepImportTasks,projectSaveTasks,projectCreateTasks;
const projectBackups=new ProjectBackupStore(dataDir,{maxFileBytes:maxProjectUploadBytes});
const projectBackupCatalog=new ProjectBackupCatalog(projectBackups,{resolveOwner:taskId=>{
  const record=modelingTasks.records.get(taskId);
  if(record?.operation!=='project.save'||!record.projectSaveInput)return null;
  return modelingTasks.validateProjectSaveBinding(record,record.projectSaveInput).documentId;
}});
const commandJournal = new CommandJournal(dataDir, {
  taskStatus: (id, taskId) => {
    const record = modelingTasks.records.get(taskId);
    const source = record?.projectCreateInput?.sourceDocumentId ?? record?.projectOpenInput?.sourceDocumentId;
    return record && (record.documentId === id || source === id) ? modelingTasks.get(record.documentId, taskId) : null;
  },
  resolveOutcome: entry => {
    const id = entry.documentId;
    if (projectTransactions.active.has(id) || fs.existsSync(projectTransactions.journalPath(id)) || projectFiles.hasUnconfirmed(id)) return null;
    const history = historyStore.get(id);
    if (entry.receiptKey) {
      const receipt = history.idempotency.find(item => item.key === entry.receiptKey && item.fingerprint === entry.fingerprint);
      if (!receipt) return null;
      const outcome = historyStore.readIdempotency(id, receipt);
      return {ok: outcome?.ok, revision: outcome?.revision, updatedAt: Date.parse(receipt.recordedAt)};
    }
    const event = history.events.find(item => (!entry.eventId || item.eventId === entry.eventId) && item.requestId === entry.requestId && item.operation === entry.operation
      && item.state === 'committed' && Date.parse(item.timestamp) >= entry.startedAt);
    return event ? {ok: true, revision: event.afterRevision, updatedAt: Date.parse(event.timestamp)} : null;
  },
  onWarning: message => process.stderr.write(message + '\n'),
});
const modelingTasks=new ModelingTaskService(dataDir,{ownerInstanceId:dataWriter.instanceId,onReserved:record=>commandJournal.observeTask(record),onTerminal:record=>{
  commandJournal.observeTask(record);
  stepImportTasks?.settle(record);
},resolveOutcome:record=>{
  if(record.operation==='project.save')return projectSaveTasks?.outcome(record)||null;
  if(projectTransactions.active.has(record.documentId)||fs.existsSync(projectTransactions.journalPath(record.documentId))||projectFiles.hasUnconfirmed(record.documentId))return null;
  const entry=historyStore.get(record.documentId).idempotency.find(item=>item.key===idempotencyKey(record.documentId,record.operation,record.requestKey));
  if(!entry||entry.fingerprint!==record.outcomeFingerprint)return null;
  try{return historyStore.readIdempotency(record.documentId,entry);}catch{return null;}
},onWarning:message=>process.stderr.write(message+'\n')});
const projectBackupMaintenance=new ProjectBackupMaintenance(projectBackups,projectBackupCatalog,{isTaskBusy:taskId=>{
  const record=modelingTasks.records.get(taskId);return Boolean(modelingTasks.active.has(taskId)||record&&!['succeeded','failed','cancelled'].includes(record.phase));
}});
const stepImports=new StepImportStore(dataDir,{ownerInstanceId:dataWriter.instanceId,resolveOutcome:(id,requestId,record)=>{
  const entry=historyStore.get(id).idempotency.find(item=>item.key===idempotencyKey(id,'step.import',requestId));
  if(!entry||record?.transfer&&entry.fingerprint!==record.transfer.outcomeFingerprint||projectTransactions.active.has(id)||fs.existsSync(projectTransactions.journalPath(id))||projectFiles.hasUnconfirmed(id))return null;try{return historyStore.readIdempotency(id,entry);}catch{return null;}
},onWarning:message=>process.stderr.write(message+'\n')});
stepImportTasks=new StepImportTasks({dataDir,tasks:modelingTasks,imports:stepImports,inputs:pendingStepInputs,maxBytes:maxStepUploadBytes,createSourcePath:stepImportPath,fingerprint:idempotencyFingerprint,execute:(fields,onPhase,task,beforeExecute)=>executeMutation('step.import',fields,onPhase,task,{finishTask:false,beforeExecute})});
const projectOpenTasks=new ProjectOpenTasks({tasks:modelingTasks,inputs:pendingProjectInputs,maxBytes:maxProjectUploadBytes,sourceExists:id=>workspaces.known(id),targetExists:id=>workspaces.known(id)||projectFiles.hasUnconfirmed(id)||fs.existsSync(projectMeshAssets.registry.file(id)),execute:(task,input,staged)=>serializeDocument(input.documentId,async()=>{
  const id=input.documentId;
  if(workspaces.known(id)||projectFiles.hasUnconfirmed(id)||fs.existsSync(projectMeshAssets.registry.file(id)))throw new ModelingTaskError('PROJECT_OPEN_TARGET_EXISTS','目标工程已被其他操作创建或存在恢复记录，未执行文件打开。');
  projectTransactions.assertWritable(id);sourceRestores.assertModelAccess();
  return piRuntime.withDocumentsQuiescent([input.sourceDocumentId,id],()=>sourceAccessGate.read(async()=>{
    await piRuntime.assertFreshDocument(id);
    await checkWorkspaceSource(input);
    const bytes=await staged.read(),meta=projectOpenTasks.meta(input);
    const result=await projectFiles.open(id,bytes,{signal:task.controller.signal,receipt:{key:idempotencyKey(id,'project.open',input.requestId),fingerprint:meta.outcomeFingerprint},decorateResult:(value,document,history)=>withHistoryState(value,document,history)});
    let notice;try{if(result.projectFile?.name)workspaces.rename(id,result.projectFile.name);else workspaces.get(id);if(result.projectFile.format==='web-cad-project')workspaces.markGenerated(id,workspaces.token(id));}catch{notice='工程已打开，但名称或备份状态记录未完成；请从工程列表核对。';process.stderr.write('[project] Open committed; workspace metadata publication deferred.\n');}
    return {result,notice};
  }));
},{loadDocument:false,inputBytes:128,task})});
const createTargetExists=id=>workspaces.known(id)||projectFiles.hasUnconfirmed(id)||fs.existsSync(projectMeshAssets.registry.file(id))||fs.existsSync(projectTransactions.journalPath(id))||projectDataStore.filePaths(id).some(file=>fs.existsSync(file));
projectCreateTasks=new ProjectCreateTasks({tasks:modelingTasks,sourceExists:id=>workspaces.known(id),targetExists:createTargetExists,execute:(task,input)=>serializeDocument(input.documentId,()=>piRuntime.withDocumentsQuiescent([input.sourceDocumentId,input.documentId],()=>sourceAccessGate.read(async()=>{
  const id=input.documentId,source=input.sourceDocumentId;
  await piRuntime.assertFreshDocument(id);
  if(!workspaces.known(source))throw new ModelingTaskError('PROJECT_CREATE_SOURCE_NOT_FOUND','来源工程已不可用，未创建新目标。',404);
  if(createTargetExists(id))throw new ModelingTaskError('PROJECT_CREATE_TARGET_EXISTS','目标在排队期间已被占用或包含恢复材料，未重置任何已有工程。');
  projectTransactions.assertWritable(source);projectFiles.assertModelAccess(source);sourceRestores.assertModelAccess();
  checkStatePrecondition(source,{baseStateToken:input.sourceStateToken});
  const sourceSummary=withHistoryState(projectFiles.check(await command('document.summary',{documentId:source})),source);
  if(sourceSummary.revision!==input.sourceRevision||sourceSummary.stateToken!==input.sourceStateToken||sourceSummary.stateSequence!==input.sourceStateSequence)throw new ModelingTaskError('PROJECT_STATE_CONFLICT','来源工程状态已变化，未将旧页面的新建请求用于当前工程。');
  const meta=projectCreateTasks.meta(input),fields={documentId:id,requestId:input.requestId,clientRequestId:input.requestId,inputs:{},parameters:{}};
  const result=await projectTransactions.run(id,history=>executeMutationUnlocked('document.create',fields,history,undefined,{key:idempotencyKey(id,'project.create',input.requestId),fingerprint:meta.outcomeFingerprint,projectCreate:{version:1,taskId:task.taskId,...input,canCreate:false}}));
  if(!result.ok)return {result};
  let notice;try{workspaces.rename(id,input.name);}catch{notice='工程已创建，但名称登记暂未完成；请从恢复工程列表核对，不要重新创建此目标。';process.stderr.write('[project] Create committed; workspace name publication deferred.\n');}
  return {result,notice};
})),{loadDocument:false,inputBytes:Buffer.byteLength(JSON.stringify(input)),task})});
projectSaveTasks=new ProjectSaveTasks({tasks:modelingTasks,backups:projectBackups,workspaceExists:id=>workspaces.known(id),execute:(task,input)=>serializeDocument(input.documentId,async()=>{
  const id=input.documentId;let lease,before;
  const stable=()=>before&&projectStateToken(id,historyFor(id))===before.stateToken&&historyFor(id).stateSequence===before.stateSequence&&workspaces.token(id)===before.workspaceToken;
  try{
    projectTransactions.assertWritable(id);projectFiles.assertModelAccess(id);const project=workspaces.get(id);if(!project.recoverable)throw new ModelingTaskError('WORKSPACE_UNAVAILABLE','工程没有可恢复检查点，未生成空备份。',409);
    checkStatePrecondition(id,input);const summary=withHistoryState(projectFiles.check(await command('document.summary',{documentId:id})),id);
    if(input.baseRevision!==undefined&&summary.revision!==input.baseRevision||input.baseStateSequence!==undefined&&summary.stateSequence!==input.baseStateSequence)throw new ModelingTaskError('PROJECT_STATE_CONFLICT','保存基线已变化，未生成其他版本的备份。');
    before={revision:summary.revision,stateToken:summary.stateToken,stateSequence:summary.stateSequence,workspaceToken:workspaces.token(id)};lease=projectBackups.reserve(task.taskId);const generation=documentLoader.generation;
    const name=input.copyName??project.name;
    modelingTasks.enterExecuting();const bytes=await projectFiles.save(id,{name,signal:task.controller.signal});await new Promise(resolve=>setImmediate(resolve));
    if(task.controller.signal.aborted)throw new ModelingTaskError('WORKER_CANCELLED','备份生成已请求取消。');
    if(!stable()||documentLoader.generation!==generation)throw new ModelingTaskError('PROJECT_SAVE_STATE_CHANGED','生成备份期间工程或内核代际已变化，未发布文件。');
    modelingTasks.beginCommit();const result=await projectBackups.publish(lease,input,bytes,before,{name});let notice;
    if(input.copyName===undefined){try{workspaces.markGenerated(id,before.workspaceToken);}catch{notice='备份已封存，但工程备份状态尚未更新；原文件仍可下载。';}}
    return {result,notice};
  }catch(error){
    if(task.mode==='preparing')try{Object.defineProperty(error,'projectSaveNotStarted',{value:{documentId:id,confirmed:true}});}catch{/* Do not invent proof for immutable errors. */}
    // This path performs only summary/snapshot reads. Do not claim unchanged if
    // the worker's exit is unconfirmed, or persisted source state no longer agrees.
    if(before&&!['WORKER_STOP_UNCONFIRMED','PROJECT_SAVE_STATE_CHANGED'].includes(error?.code))try{if(stable())Object.defineProperty(error,'projectSaveUnchanged',{value:{documentId:id,confirmed:true}});}catch{/* Preserve original error if verification is unavailable. */}
    throw error;
  }finally{if(lease)projectBackups.release(lease);}
},{inputBytes:128,task})});

function selectAgentProvider(providerId) {
  let providers = providerStore.read();
  if (process.env.AGENT_REQUIRE_PROVIDER_HANDSHAKE === "true") providers = providers.filter((item) => item.capabilities?.toolCalling === true && item.capabilities?.verified === true);
  return providerHealth.choose(providers, { providerId }) || selectProvider(providers, { providerId });
}
async function withProviderHealth(provider, operation) {
  providerHealth.assertAvailable(provider);
  try {
    const result = await operation();
    providerHealth.success(provider);
    return result;
  } catch (error) {
    providerHealth.failure(provider, error);
    throw error;
  }
}

function createWorkerEnvironment() {
  const environment = { ...process.env };
  const inheritedPath = environment.Path || environment.PATH || "";
  delete environment.Path;
  delete environment.PATH;
  environment.Path = [occtBin, mingwBin, inheritedPath].filter(Boolean).join(path.delimiter);
  environment.GEOMETRY_WORKER_MEMORY_LIMIT_BYTES=String(workerMemoryPolicy.limitBytes);
  return environment;
}
function geometryReady(){return workerReady&&workerChannel?.state==='active'&&Boolean(worker&&!worker.killed&&worker.stdin?.writable);}

function scheduleWorkerRestart() {
  if (shuttingDown || workerResourceBlocked || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    if (shuttingDown || worker) return;
    try { startWorker(); }
    catch (error) { process.stderr.write(`[worker] restart failed: ${error.message}\n`); scheduleWorkerRestart(); }
  }, workerRestartDelayMs);
}
function startWorker() {
  if(workerResourceBlocked)throw workerResourceBlocked;
  if(shuttingDown)throw new GatewayRequestError('SERVICE_STOPPING','后台正在停止，不会启动新的几何进程。');
  if (worker && workerChannel?.state==='active' && !worker.killed && worker.stdin?.writable) return worker;
  if(worker)throw new NativeChannelError('WORKER_STOP_UNCONFIRMED','原几何进程尚未确认退出，不能启动替代进程。');
  worker = spawn(workerPath, [], {
    cwd: path.dirname(workerPath),
    env: createWorkerEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const startedWorker = worker,handshakeStarted=performance.now();propertyAssociationCache.clear();workerReady=false;workerInstance=randomUUID();workerFeatures={};workerResourceGuard=null;
  geometryChildren.add(startedWorker);void childExit(startedWorker).then(()=>geometryChildren.delete(startedWorker));
  workerChannel=new NativeRequestChannel(startedWorker,{timeoutMs:workerTimeoutMs,stopTimeoutMs:workerStopTimeoutMs,maxResponseBytes:maxWorkerResponseBytes,...workerQueueLimits,
    exitError:code=>nativeResourceExitError(code,workerMemoryPolicy),
    onDiagnostic:line=>process.stderr.write(`[occt] ${line}\n`),
    onUnavailable:error=>{if(worker!==startedWorker)return;propertyAssociationCache.clear();if(error.permanent)workerResourceBlocked=error;workerReady=false;workerInstance=null;workerFeatures={};workerResourceGuard=null;documentLoader.invalidate();},
    onStopped:error=>{if(worker!==startedWorker)return;if(error.permanent)workerResourceBlocked=error;if(['WORKER_MEMORY_LIMIT','WORKER_MEMORY_EXHAUSTED'].includes(error.code))process.stderr.write(`[worker] ${error.code}: ${error.message}\n`);worker=undefined;scheduleWorkerRestart();},
  });
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => process.stderr.write(`[occt] ${chunk}`));
  workerHandshake=sendCommand({protocolVersion:1,requestId:`worker-handshake-${requestSequence++}`,operation:'health.ping'},{timeoutMs:workerStartupTimeoutMs}).then(async result=>{
    if(worker===startedWorker&&workerChannel?.state==='active'){
      try{workerResourceGuard=assertNativeMemoryGuard(result,workerMemoryPolicy);}catch(error){workerResourceBlocked=error;await workerChannel.retire(error);throw error;}
      workerFeatures=nativeGeometryFeatures(result);workerReady=true;startup.workerHandshakeMs=performance.now()-handshakeStarted;if(server.listening&&!startup.readyAt){startup.readyAt=new Date().toISOString();console.log(`Geometry gateway ready at ${host}:${port}`);}
    }
    return result;
  }).catch(error=>{if(worker===startedWorker||workerResourceBlocked===error)process.stderr.write(`[worker] handshake failed (${error.code||'WORKER_UNAVAILABLE'}): ${error.message}\n`);return {ok:false};});
  return worker;
}

async function sendCommand(command,options={}) {
  if(forceStopping)throw new GatewayRequestError('SERVICE_STOPPING','后台已进入停止阶段，未执行新的几何请求。');
  if(worker&&workerChannel?.state!=='active')await workerChannel.waitUntilStopped();
  runtimeMetrics.workerRequests++;if(command.operation==='geometry.measure')runtimeMetrics.geometryMeasureRequests++;if(command.operation==='document.restore')runtimeMetrics.documentRestoreRequests++;
  if (!worker) startWorker();
  const intendedWorker=worker;
  if(command.operation!=='health.ping'){
    await workerHandshake;
    if(workerResourceBlocked)throw workerResourceBlocked;
    if(worker!==intendedWorker)throw new NativeChannelError('WORKER_INSTANCE_CHANGED','几何进程在执行准入前变化，原请求未发送。');
    if(!geometryReady())throw new NativeChannelError('WORKER_UNAVAILABLE','几何进程尚未完成资源保护握手，未发送工程请求。');
  }
  assertCapabilityPrecondition(command.workerCapabilityPrecondition,nativeCapabilities());
  return workerChannel.request(command,options);
}
async function command(operation, fields = {}) {
  const actualAssociationOperation=Object.hasOwn(fields,'operation')?fields.operation:operation;
  const associationReadOnly=['health.ping','document.summary','document.view','body.presentation','geometry.measure','geometry.relation','property.list'].includes(actualAssociationOperation);
  if(!associationReadOnly)propertyAssociationCache.clear();
  if(forceStopping||shuttingDown&&!runningDocuments.has(fields.documentId))throw new GatewayRequestError('SERVICE_STOPPING','后台正在停止，未开始新的工程操作。');
  if (!worker) startWorker();
  const id = fields.documentId;
  if(id)projectFiles.assertModelAccess(id);
  if(id&&operation!=="document.restore"&&!projectTransactions.active.has(id)){
    try{projectTransactions.assertWritable(id);}catch(error){return {ok:false,protocolVersion:1,documentId:id,code:error.code,error:error.message};}
  }
  const generation=documentLoader.generation;
  if(id && !['document.create','document.restore','health.ping'].includes(operation))await documentLoader.ensure(id);
  if(generation!==documentLoader.generation)throw new DocumentLoadError('DOCUMENT_LOAD_INTERRUPTED','几何进程已变化，未在空文档上继续请求；请重新读取工程。');
  const result = await sendCommand({
    protocolVersion: 1,
    requestId: `gateway-${requestSequence++}`,
    operation,
    ...fields,
  },modelingTasks.commandOptions());
  if(generation!==documentLoader.generation)throw new NativeChannelError('WORKER_INSTANCE_CHANGED','几何回复完成前进程身份已变化，未采用迟到结果；请核对工程。');
  if(id && result.ok && operation!=='health.ping')documentLoader.markReady(id);
  if(!associationReadOnly)propertyAssociationCache.clear();
  else if(id&&result.ok&&['document.summary','document.view'].includes(actualAssociationOperation))propertyAssociationCache.observe(result,propertyAssociationAuthority(id));
  return result;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {...corsHeaders(response._cadCorsOrigin || webOrigin),'Cache-Control':'no-store'});
  response.end(JSON.stringify(payload));
}

function compactFeature(feature) {
  const stringParameters = {}, inputSelections = [];
  for (const [key, value] of Object.entries(feature.stringParameters || {})) {
    if(key==="loftSections"){
      try{inputSelections.push({field:key,kind:"ordered-face-sections",sections:JSON.parse(value).map(item=>({sectionId:item.sectionId,bodyId:item.bodyId,sourceFeatureId:item.featureId,...(Array.isArray(item.holeSelectors)?{holeCount:item.holeSelectors.length}:{}),basis:JSON.parse(item.selector).complete?"semantic":"exact-input-only"}))});}
      catch{inputSelections.push({field:key,basis:"invalid-reference"});}
      continue;
    }
    if(key==="loftNextSection")continue;
    if(key==="sweepProfile" || key==="sweepPath"){
      try{const reference=JSON.parse(value);inputSelections.push({field:key,kind:key==="sweepProfile"?"face":"ordered-edge-path",bodyId:reference.bodyId,sourceFeatureId:reference.featureId,...(key==="sweepPath"?{edgeCount:reference.edges?.length||0,inputIds:(reference.edges||[]).map((edge,index)=>edge.inputId||`legacy-path-${index+1}`)}:{inputId:"profile"}),basis:"persistent-historical-source"});}
      catch{inputSelections.push({field:key,basis:"invalid-reference"});}
      continue;
    }
    if (!key.startsWith("selection.")) { stringParameters[key] = value; continue; }
    try {
      const selector = JSON.parse(value);
      inputSelections.push({ field: key.slice("selection.".length), kind: selector.kind,
        basis: selector.complete && selector.origins?.length ? "exact-brep+semantic-topology" : "exact-brep-only" });
    } catch { inputSelections.push({ field: key.slice("selection.".length), basis: "invalid-reference" }); }
  }
  return {
    id: feature.id,
    type: feature.type,
    state: feature.state,
    computedRevision: feature.computedRevision,
    inputFeatures: feature.inputFeatures || [],
    outputBodies: feature.outputBodies || [],
    numberParameters: feature.numberParameters || {},
    stringParameters,
    ...(inputSelections.length ? {inputSelections} : {}),
  };
}

function conversationPromptContext(input, context) {
  const current = context && typeof context === "object" ? context : {};
  const document = documentId(input.documentId || "default");
  const conversation = input.conversationId ? agentConversations.get(String(input.conversationId), document) : null;
  const messages = conversation?.messages || [];
  const compacted = buildConversationContext(messages, { recentLimit: 8, maxSummaryChars: 12_000 });
  return {
    ...current,
    conversation: compacted.recent,
    conversationSummary: compacted.summary,
    contextMeta: { compacted: compacted.compacted, tokenEstimate: compacted.tokenEstimate, recentCount: compacted.recent.length },
  };
}
function recordAgentAudit(event) {
  try { return agentAudit.append(event); } catch (error) { process.stderr.write(`[agent-audit] ${error.message}` + "\\n"); return null; }
}
function agentMetrics(documentIdValue = "default") {
  const events = agentAudit.list({ documentId: documentIdValue, limit: 500 });
  const completed = events.filter((event) => event.type === "agent.run.completed");
  const failed = events.filter((event) => event.type === "agent.run.failed" || event.status === "failed");
  const durations = completed.map((event) => Number(event.durationMs)).filter(Number.isFinite);
  const byType = {};
  const byErrorCode = {};
  for (const event of events) byType[event.type] = (byType[event.type] || 0) + 1;
  for (const event of failed) if (event.errorCode) byErrorCode[event.errorCode] = (byErrorCode[event.errorCode] || 0) + 1;
  return {
    sampleSize: events.length,
    runCount: completed.length + failed.length,
    completedCount: completed.length,
    failedCount: failed.length,
    failureRate: completed.length + failed.length ? failed.length / (completed.length + failed.length) : 0,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    byType,
    byErrorCode,
    providers: providerHealth.list(),
  };
}function hydrateAgentPlan(plan, context = {}, prompt = "") {
  return resolveAgentPlan(plan, context, prompt);
}function isTransientAgentError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /超时|timeout|timed out|fetch failed|network|HTTP (?:408|425|429|5\d\d)\b/i.test(message);
}

function waitForAgentRetry(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestAgentPlanWithRetry(provider, prompt, systemPrompt, { stream = false, onDelta = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= agentRetryAttempts; attempt += 1) {
    try {
      if (stream) {
        const bufferedDeltas = [];
        const generated = await withProviderHealth(provider, () => streamModelingPlan(provider, prompt, systemPrompt, {
          timeoutMs: agentTimeoutMs,
          onDelta: (delta) => bufferedDeltas.push(delta),
        }));
        bufferedDeltas.forEach(onDelta);
        return { generated, attempts: attempt };
      }
      return { generated: await withProviderHealth(provider, () => requestModelingPlan(provider, prompt, systemPrompt, { timeoutMs: agentTimeoutMs })), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientAgentError(error) || attempt >= agentRetryAttempts) throw error;
      await waitForAgentRetry(agentRetryDelayMs * (2 ** (attempt - 1)) * (0.85 + Math.random() * 0.3));
    }
  }
  throw lastError || new Error("Agent planning failed.");
}
async function generateValidatedAgentPlan(provider, input, prompt, context, resources, { stream = false, onDelta = () => {} } = {}) {
  let repairFeedback = "";
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const plannerPrompt = repairFeedback
      ? `${prompt}\n\nThe previous plan was rejected by the deterministic CAD validator: ${repairFeedback}\nReturn a complete corrected modeling_plan JSON. Do not omit required parameters; for primitive.box always provide parameters.width, parameters.depth and parameters.height.`
      : prompt;
    const plannerContext = { ...conversationPromptContext(input, context), resources: resources.text, toolCalling: provider.toolCalling === true };
    const upstream = await requestAgentPlanWithRetry(provider, plannerPrompt, agentSystemPrompt(plannerContext), { stream: stream && attempt === 1, onDelta });
    const generated = upstream.generated;
    try {
      const rawPlan = generated.plan?.toolCalls ? toolCallsToModelingPlan(generated.plan.toolCalls) : generated.plan;
      const plan = buildValidatedAgentPlan(rawPlan, { prompt, context, validate: validateModelingPlan, resolve: hydrateAgentPlan });
      const safePlan = { ...plan, risk: "none", confirmation: undefined, steps: (plan.steps || []).map((item) => ({ ...item, risk: "none", status: "ready" })) };
      return { generated, plan: { ...safePlan, source: attempt > 1 ? "llm-repaired" : "llm", providerId: provider.id, model: provider.model, protocol: generated.protocol }, attempts: attempt, repaired: attempt > 1 };
    } catch (error) {
      lastError = error;
      if (attempt >= 2) throw error;
      repairFeedback = error instanceof Error ? error.message : String(error);
    }
  }
  throw lastError || new Error("Agent plan validation failed.");
}
function summarizeAgentModel(view, query = {}, propertySchema = null) {
  const kind = String(query.kind || "geometry-tree");
  const bodyId = query.bodyId ? String(query.bodyId) : "";
  const featureId = query.featureId ? String(query.featureId) : "";
  const features = (view.features || []).map(compactFeature);
  const presentations = Array.isArray(view.bodyPresentations) ? view.bodyPresentations : [];
  const bodies = (view.bodyMetadata || []).map((body) => {
    const presentation = presentations.find((item) => item?.bodyId === body.bodyId);
    return {
      bodyId: body.bodyId,
      name: body.name,
      kind: body.kind,
      visible: body.visible,
      material: body.material,
      featureIds: features.filter((feature) => feature.outputBodies.includes(body.bodyId)).map((feature) => feature.id),
      topology: presentation ? {
        topologyRevision: presentation.topologyRevision,
        faceIds: [...new Set(Array.isArray(presentation.triangleFaceIds) ? presentation.triangleFaceIds : [])],
        edgeIds: [...new Set(Array.isArray(presentation.edges) ? presentation.edges.map((edge) => edge?.edgeId) : [])],
      } : undefined,
    };
  });
  const selectedBody = bodyId ? bodies.find((body) => body.bodyId === bodyId) : null;
  const selectedFeature = featureId ? features.find((feature) => feature.id === featureId) : null;
  const scopedFeatures = selectedBody ? features.filter((feature) => feature.outputBodies.includes(bodyId) || feature.inputFeatures.some((inputId) => features.find((item) => item.id === inputId)?.outputBodies.includes(bodyId))) : features;
  const result = { kind, revision: view.revision, project: { bodyCount: view.bodyCount || 0, featureCount: view.featureCount || 0 } };
  if (kind === "body") Object.assign(result, { body: selectedBody || null, features: scopedFeatures });
  else if (kind === "feature") Object.assign(result, { feature: selectedFeature || null });
  else if (kind === "variables") Object.assign(result, { variables: view.variables || [] });
  else if (kind === "coordinates") Object.assign(result, { coordinateSystems: view.coordinateSystems || [] });
  else if (kind === "materials") Object.assign(result, { materials: view.materials || [] });
  else if (kind === "history") Object.assign(result, { history: view.history || null, features });
  else if (kind === "property-types") Object.assign(result, { propertyTypes: propertySchema?.types || [] });
  else if (kind === "properties") Object.assign(result, { propertyTypes: propertySchema?.types || [], propertyInstances: propertySchema?.instances || [] });
  else Object.assign(result, { bodies, features });
  return result;
}
function spatialVector(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const numbers = value.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

function spatialBounds(value) {
  const minimum = spatialVector(value?.min);
  const maximum = spatialVector(value?.max);
  return minimum && maximum && minimum.every((value,index)=>value<=maximum[index]) ? { min: minimum, max: maximum } : null;
}

function boundsCenter(bounds) {
  return bounds.min.map((value, index) => (value + bounds.max[index]) / 2);
}

function boundsSize(bounds) {
  return bounds.min.map((value, index) => Math.max(0, bounds.max[index] - value));
}

function optionalNumber(value) {
  if(value===undefined||value===null||value==='')return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function spatialObb(value) {
  const center = spatialVector(value?.center);
  const halfSizes = spatialVector(value?.halfSizes);
  const axes = Array.isArray(value?.axes) && value.axes.length === 3
    ? value.axes.map((axis) => spatialVector(axis))
    : null;
  const source = typeof value?.source === "string" ? value.source : null;
  const exact = typeof value?.exact === "boolean" ? value.exact : null;
  if (!center || !halfSizes || !axes || axes.some((axis) => !axis) || halfSizes.some((item) => item < 0)
      || !source || exact === null) return null;
  if(axes.some(axis=>Math.abs(Math.hypot(...axis)-1)>1e-6)||axes.some((axis,index)=>axes.slice(index+1).some(other=>Math.abs(axis.reduce((sum,value,i)=>sum+value*other[i],0))>1e-6)))return null;
  return { center, axes, halfSizes, source:source==='occt-exact'?'occt-legacy-obb':source, exact:source==='occt-exact'?false:exact,...(typeof value.minimum==='boolean'?{minimum:value.minimum}:{}),...(typeof value.triangulationUsed==='boolean'?{triangulationUsed:value.triangulationUsed}:{}),...(typeof value.toleranceExpanded==='boolean'?{toleranceExpanded:value.toleranceExpanded}:{}) };
}

function bodySpatialSummary(measurement) {
  const bounds = spatialBounds(measurement?.bounds);
  if (!bounds) return null;
  const size = boundsSize(bounds);
  const center = boundsCenter(bounds);
  const measuredObb = spatialObb(measurement?.obb);
  return {
    bounds,
    ...(measurement?.spatialPolicy?{boundsSource:measurement.spatialPolicy.aabb,boundsPolicyVersion:measurement.spatialPolicy.version}:{}),
    center,
    size,
    // Prefer the worker's OCCT OBB when available.  The identity-frame
    // fallback is deliberately marked approximate for older workers.
    obb: measuredObb || {
      center,
      axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      halfSizes: size.map((value) => value / 2),
      source: "aabb-derived",
      exact: false,
    },
    ...(optionalNumber(measurement.volume) !== null ? { volume: Number(measurement.volume) } : {}),
    ...(optionalNumber(measurement.area) !== null ? { area: Number(measurement.area) } : {}),
  };
}

function normalizeVector(vector) {
  const value = spatialVector(vector);
  if (!value) return null;
  const length = Math.hypot(...value);
  return length > 1e-12 ? value.map((item) => item / length) : null;
}

function faceNormalFromPresentation(presentation, faceId) {
  if (!presentation || !Array.isArray(presentation.triangleFaceIds) || !Array.isArray(presentation.normals)) return null;
  const normal = [0, 0, 0];
  let count = 0;
  presentation.triangleFaceIds.forEach((candidate, triangleIndex) => {
    if (candidate !== faceId) return;
    const offset = triangleIndex * 9;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      normal[0] += Number(presentation.normals[offset + vertex * 3]) || 0;
      normal[1] += Number(presentation.normals[offset + vertex * 3 + 1]) || 0;
      normal[2] += Number(presentation.normals[offset + vertex * 3 + 2]) || 0;
      count += 1;
    }
  });
  return count ? normalizeVector(normal) : null;
}

function selectionMeasurementSummary(measurement, presentation = null) {
  const selectionType = String(measurement?.selectionType || "body");
  if (selectionType === "body") return bodySpatialSummary(measurement);
  const bounds = spatialBounds(measurement?.bounds);
  const centroid = spatialVector(measurement?.centroid);
  const base = {
    ...(bounds ? { bounds, size: boundsSize(bounds) } : {}),
    ...(measurement?.spatialPolicy?{boundsSource:measurement.spatialPolicy.aabb,boundsPolicyVersion:measurement.spatialPolicy.version}:{}),
    ...(centroid ? { center: centroid, centroid } : bounds ? { center: boundsCenter(bounds) } : {}),
  };
  if (selectionType === "face") {
    const normal = faceNormalFromPresentation(presentation, measurement.selectionId);
    return {
      ...base,
      ...(optionalNumber(measurement.area) !== null ? { area: Number(measurement.area) } : {}),
      ...(optionalNumber(measurement.perimeter) !== null ? { perimeter: Number(measurement.perimeter) } : {}),
      ...(normal ? { normal, normalSource: "tessellation-average" } : {}),
    };
  }
  const endpoints = Array.isArray(measurement?.endpoints)
    ? measurement.endpoints.map(spatialVector).filter(Boolean).slice(0, 2)
    : [];
  const direction = endpoints.length === 2
    ? normalizeVector(endpoints[1].map((value, index) => value - endpoints[0][index]))
    : null;
  return {
    ...base,
    ...(optionalNumber(measurement.length) !== null ? { length: Number(measurement.length) } : {}),
    ...(measurement?.curveType ? { curveType: String(measurement.curveType) } : {}),
    ...(endpoints.length === 2 ? { endpoints } : {}),
    ...(direction ? { direction } : {}),
    ...(optionalNumber(measurement.radius) !== null ? { radius: Number(measurement.radius) } : {}),
    ...(spatialVector(measurement?.center) ? { curveCenter: spatialVector(measurement.center) } : {}),
  };
}

async function cachedSpatialMeasurement(document, view, bodyId, selectionType = "body", selectionId = bodyId) {
  const key = `${selectionType}:${bodyId}:${selectionId}`;
  return spatialSummaryCache.read(document,view,key,()=>command("geometry.measure", {
    documentId: document,
    inputs: { bodyId, selectionType, selectionId },
  }).then(compactSpatialMeasurement));
}

function relationBetweenBounds(firstId, first, secondId, second) {
  const axisOverlap = first.bounds.min.map((value, axis) =>
    Math.min(first.bounds.max[axis], second.bounds.max[axis]) - Math.max(value, second.bounds.min[axis]));
  const separation = axisOverlap.map((value) => Math.max(0, -value));
  const gap = Math.hypot(...separation);
  const firstCenter = first.center || boundsCenter(first.bounds);
  const secondCenter = second.center || boundsCenter(second.bounds);
  const separated = axisOverlap.some((value) => value < -1e-9);
  const touching = !separated && axisOverlap.some((value) => Math.abs(value) <= 1e-9);
  return {
    bodyA: firstId,
    bodyB: secondId,
    relation: separated ? "separated" : touching ? "touching" : "bounds-overlap",
    possibleIntersection: !separated && !touching,
    gap,
    distance: gap,
    source: "aabb",
    exact: false,
    axisOverlap,
    centerDelta: secondCenter.map((value, axis) => value - firstCenter[axis]),
  };
}

function compactSpatialRelations(spatialByBody, limit = 32) {
  return nearestBoundsRelations(spatialByBody,relationBetweenBounds,limit);
}

function projectSpatialSummary(revision, spatialByBody, {
  totalBodyCount = spatialByBody.size,
  failedBodyIds = [],
  scope = "geometry-tree",
} = {}) {
  const items = [...spatialByBody.values()].filter(Boolean);
  const measuredBodyCount = items.length;
  const status = totalBodyCount === 0
    ? "empty"
    : measuredBodyCount === totalBodyCount && failedBodyIds.length === 0
      ? "complete"
      : measuredBodyCount > 0
        ? "partial"
        : "unavailable";
  const result = {
    revision,
    status,
    scope,
    units: "mm",
    coordinateSystemId: "global",
    totalBodyCount,
    measuredBodyCount,
    failedBodyIds: [...new Set(failedBodyIds)],
  };
  if (!items.length) return result;
  const minimum = [Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity];
  for(const item of items)for(let axis=0;axis<3;axis++){minimum[axis]=Math.min(minimum[axis],item.bounds.min[axis]);maximum[axis]=Math.max(maximum[axis],item.bounds.max[axis]);}
  const bounds = { min: minimum, max: maximum };
  return {
    ...result,
    bounds,
    center: boundsCenter(bounds),
    size: boundsSize(bounds),
    ...(scope === "geometry-tree" ? { relations: compactSpatialRelations(spatialByBody) } : {}),
  };
}

async function summarizeAgentModelWithSpatial(document, view, query = {}, propertySchema = null) {
  const resolvedProperties=propertySchema?resolveProjectProperties(document,view):null;
  const summary = summarizeAgentModel(view, query, resolvedProperties);
  if(resolvedProperties?.associationCache)summary.propertyAssociationCache=resolvedProperties.associationCache;
  summary.stateToken=projectStateToken(document,historyFor(document));
  const kind = String(query.kind || "geometry-tree");
  if (kind !== "geometry-tree" && kind !== "body") return summary;
  const availableBodies = Array.isArray(view.bodyMetadata) ? view.bodyMetadata : [];
  const requestedBodies = kind === "body"
    ? availableBodies.filter((body) => body.bodyId === String(query.bodyId || ""))
    : availableBodies;
  const metadataPolicy=view.spatialPolicy?.version===1&&view.spatialPolicy.aabb==='occt-brep-optimal'&&view.spatialPolicy.triangulationUsed===false;
  const overviewPolicy=metadataPolicy?view.spatialPolicy:{version:0,aabb:'legacy-worker-bounds',triangulationUsed:null,toleranceExpanded:null,cacheIndependent:false,precision:'legacy-worker'};
  const measured = await Promise.all(requestedBodies.map(async (body) => {
    // All-body perception needs current analytic dimensions, not N additional
    // whole-document worker responses. Detailed Body queries still measure OBB.
    if(kind==='geometry-tree'&&(metadataPolicy||spatialBounds(body.bounds)))return {bodyId:body.bodyId,source:'metadata',result:{measurement:{...body,spatialPolicy:overviewPolicy}}};
    return {bodyId:body.bodyId,source:'measurement',result:await cachedSpatialMeasurement(document,view,body.bodyId)};
  }));
  const spatialByBody = new Map();
  const failedBodyIds = [];
  for (const item of measured) {
    const spatial = item.result.measurement ? bodySpatialSummary(item.result.measurement) : null;
    if (spatial) spatialByBody.set(item.bodyId, spatial);
    else failedBodyIds.push(item.bodyId);
  }
  if (Array.isArray(summary.bodies)) {
    summary.bodies = summary.bodies.map((body) => ({
      ...body,
      ...(spatialByBody.get(body.bodyId) ? { spatial: spatialByBody.get(body.bodyId) } : {}),
    }));
  }
  if (summary.body?.bodyId && spatialByBody.get(summary.body.bodyId)) {
    summary.body = { ...summary.body, spatial: spatialByBody.get(summary.body.bodyId) };
  }
  summary.spatial = projectSpatialSummary(view.revision, spatialByBody, {
    totalBodyCount: requestedBodies.length,
    failedBodyIds,
    scope: kind,
  });
  summary.spatial.sources={metadata:measured.filter(item=>item.source==='metadata').length,measurement:measured.filter(item=>item.source==='measurement').length};
  summary.spatial.boundsPolicy=overviewPolicy;
  return summary;
}

function selectionTargets(selections) {
  const targets = [];
  for (const selection of Array.isArray(selections) ? selections.slice(0, 16) : []) {
    if (!selection || !["body", "face", "edge"].includes(selection.kind) || !selection.bodyId) continue;
    const topologyIds = selection.kind === "body"
      ? [selection.bodyId]
      : [
          ...(selection.topologyId ? [selection.topologyId] : []),
          ...(Array.isArray(selection.topologyIds) ? selection.topologyIds : []),
        ];
    for (const selectionId of [...new Set(topologyIds)].slice(0, 16)) {
      targets.push({ kind: selection.kind, bodyId: String(selection.bodyId), selectionId: String(selectionId) });
    }
  }
  return targets.slice(0, 32);
}

async function summarizeAgentSelections(document, view, selections) {
  const presentations = Array.isArray(view.bodyPresentations) ? view.bodyPresentations : [];
  return Promise.all(selectionTargets(selections).map(async (target) => {
    const result = await cachedSpatialMeasurement(document, view, target.bodyId, target.kind, target.selectionId);
    const base = {
      kind: target.kind,
      bodyId: target.bodyId,
      selectionId: target.selectionId,
      revision: view.revision,
      units: "mm",
      coordinateSystemId: "global",
    };
    if (!result.measurement) {
      return { ...base, status: "unavailable", reason: String(result.error || "Measurement failed.").slice(0, 240) };
    }
    const presentation = presentations.find((item) => item?.bodyId === target.bodyId);
    return {
      ...base,
      status: "complete",
      spatial: selectionMeasurementSummary(result.measurement, presentation),
    };
  }));
}

async function assembleAgentContext(input, rawContext = {}) {
  const context = rawContext && typeof rawContext === "object" && !Array.isArray(rawContext) ? { ...rawContext } : {};
  const legacySuppliedModel = context.model
    && context.model.revision === undefined
    && context.model.spatial === undefined;
  const document = documentId(input.documentId || "default");
  return serializeDocument(document,async()=>{
  const view = await command("document.view", { documentId: document });
  if (!view.ok) return context;
  let model = context.model;
  let revision = context.revision ?? view.revision;
  if (!legacySuppliedModel) {
    const hasCurrentSpatialSummary = context.model?.revision === view.revision
      && context.model?.spatial?.revision === view.revision;
    model = hasCurrentSpatialSummary
      ? context.model
      : await summarizeAgentModelWithSpatial(document, view, { kind: "geometry-tree" }, true);
    revision = view.revision;
  }
  const selectionSpatial = await summarizeAgentSelections(document, view, context.selections);
  return { ...context, revision, model, selectionSpatial };
  });
}
function parseAgentToolArguments(call) {
  let args = call?.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch (error) { throw new Error(`Tool ${call?.name || ""} returned invalid arguments: ${error.message}`); }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`Tool ${call?.name || ""} arguments must be an object.`);
  return args;
}

async function executeAgentToolCall(call, { input, prompt, context, mode, turn, index, requestId, deferMutation = false }) {
  try {
    const args = parseAgentToolArguments(call);
    const document = documentId(input.documentId || "default");
    if (isCadQueryToolCall(call)) {
      return serializeDocument(document,async()=>{
      const view = await command("document.view", { documentId: document });
      if (!view.ok) return { ok: false, status: "failed", error: view.error || "Could not read the CAD document." };
      return { ok: true, status: "query", toolCallId: call.id || null, result: await summarizeAgentModelWithSpatial(document, view, args, true), revision: view.revision };
      });
    }
    const rawPlan = toolCallsToModelingPlan([{ ...call, arguments: args }]);
    const {currentView,liveModel}=await serializeDocument(document,async()=>{const currentView=await command("document.view",{documentId:document});return {currentView,liveModel:currentView.ok?await summarizeAgentModelWithSpatial(document,currentView,{kind:"geometry-tree"},true):context.model};});
    const effectiveContext = { ...context, model: liveModel || context.model, revision: currentView.revision ?? context.revision };
    const validated = buildValidatedAgentPlan(rawPlan, { prompt, context: effectiveContext, validate: validateModelingPlan, resolve: hydrateAgentPlan });
    const plan = { ...validated, source: "llm", providerId: input.providerId || null, risk: "none", confirmation: undefined, steps: (validated.steps || []).map((item) => ({ ...item, risk: "none", status: "ready" })) };
    if (mode === "plan" && isCadMutationTool(call.name)) return { ok: false, status: "blocked", reason: "当前处于 Plan 模式，只能分析和查询，不能创建或修改几何。请切换到 Edit 模式后重新提交或继续。", plan };
    if (plan.status === "needs-input") return { ok: true, status: "needs-input", questions: plan.questions, plan, revision: effectiveContext.revision };
    const step = plan.steps[0];
    if (!step) return { ok: false, status: "failed", error: "The CAD tool call did not produce an executable step.", plan };
    // Agent geometry operations execute directly in EDIT mode; confirmation dialogs are disabled.
    const fields = {
      documentId: document,
      requestId: `${requestId || "agent"}:turn-${turn + 1}:tool-${index + 1}`,
      clientRequestId: `${input.conversationId || requestId || "agent"}:${call.id || `turn-${turn + 1}-tool-${index + 1}`}`,
      baseRevision: effectiveContext.revision,
      ...(step.request.baseStateToken!==undefined?{baseStateToken:step.request.baseStateToken}:{}),
      inputs: step.request.inputs || {},
      parameters: step.request.parameters || {},
      conversationId: input.conversationId || undefined,
      agentPlanId: plan.planId,
    };
    const readOnly = isReadOnlyCadOperation(step.operation);
    if (deferMutation && !readOnly) return { ok: true, status: "prepared", call, step, fields, plan, revision: effectiveContext.revision, toolCallId: call.id || null };
    const result = readOnly ? await command(step.operation, fields) : await executeMutation(step.operation, fields);
    return { ok: Boolean(result.ok), status: result.ok ? "executed" : "failed", result, plan, revision: result.revision ?? effectiveContext.revision, toolCallId: call.id || null };
  } catch (error) {
    return { ok: false, status: "failed", error: error instanceof Error ? error.message : String(error), toolCallId: call?.id || null };
  }
}
async function requestAgentToolTurnWithRetry(provider, prompt, systemPrompt, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= agentRetryAttempts; attempt += 1) {
    try { return await withProviderHealth(provider, () => requestCadToolTurn(provider, prompt, systemPrompt, { timeoutMs: agentTimeoutMs, ...options })); }
    catch (error) {
      lastError = error;
      if (!isTransientAgentError(error) || attempt >= agentRetryAttempts) throw error;
      await waitForAgentRetry(agentRetryDelayMs * (2 ** (attempt - 1)) * (0.85 + Math.random() * 0.3));
    }
  }
  throw lastError || new Error("Agent Tool Calling request failed.");
}
async function runAgentLoop(provider, input, prompt, context, resources, { onEvent = () => {}, confirmed = false } = {}) {
  const mode = context.mode === "plan" ? "plan" : "edit";
  const document = documentId(input.documentId || "default");
  const requestId = input.requestId || `agent-run-${Date.now()}`;
  const conversation = input.conversationId ? agentConversations.get(String(input.conversationId), document) : null;
  const pendingToolCall = conversation?.pendingToolCall || null;
  if (confirmed && pendingToolCall && Number.isInteger(conversation?.pendingRevision)) {
    const liveRevision = await command("document.summary", { documentId: document });
    if (liveRevision.ok && liveRevision.revision !== conversation.pendingRevision) {
      if (input.conversationId) await agentConversations.updateState(input.conversationId, document, { activePlan: null, pendingPrompt: null, pendingToolCall: null, pendingRevision: null, pendingFingerprint: null });
      return { status: "needs-input", text: "确认前工程已发生变化，旧确认已失效，请重新检查并确认。", turns: 0, toolCount: 0, result: { ok: false, status: "stale-confirmation", code: "CONFIRMATION_REVISION_CHANGED", expectedRevision: conversation.pendingRevision, actualRevision: liveRevision.revision } };
    }
  }
  if (confirmed && pendingToolCall) {
    const expectedFingerprint = confirmationFingerprint({ planId: conversation?.activePlan?.planId || null, revision: conversation?.pendingRevision ?? context.revision, call: pendingToolCall });
    if (!sameConfirmationFingerprint(conversation?.pendingFingerprint, expectedFingerprint)) {
      if (input.conversationId) await agentConversations.updateState(input.conversationId, document, { activePlan: null, pendingPrompt: null, pendingToolCall: null, pendingRevision: null, pendingFingerprint: null });
      return { status: "needs-input", text: "确认内容已发生变化，请重新审核并确认。", turns: 0, toolCount: 0, result: { ok: false, status: "stale-confirmation", code: "CONFIRMATION_FINGERPRINT_CHANGED" } };
    }
  }
  if (input.conversationId) {
    await agentConversations.append(input.conversationId, document, { role: "user", content: confirmed ? `Confirmed CAD operation: ${prompt}` : prompt, revision: context.revision });
  }
  let turnPrompt = String(prompt || "").trim();
  if (confirmed && pendingToolCall) turnPrompt = `${turnPrompt || "Continue the confirmed CAD operation."}` + `\nThe user confirmed this pending CAD tool call. Execute it now: ${JSON.stringify(pendingToolCall)}`;
  let lastText = "";
  let toolCount = 0;
  let lastResult = null;
  let forcedConfirmedCall = confirmed ? pendingToolCall : null;
  const failureFingerprints = new Map();
  for (let turn = 0; turn < agentLoopMaxTurns; turn += 1) {
    if (context.model?.spatial?.revision !== context.revision) context = await assembleAgentContext(input, context);
    const plannerContext = { ...conversationPromptContext(input, context), resources: resources.text, toolCalling: true, agentLoop: true, mode };
    const instruction = turn === 0
      ? turnPrompt
      : "Continue the task using the CAD tool results already recorded in this conversation. Call another declared tool if more work or inspection is needed. When the task is complete, respond with one concise final sentence and no tool call.";
    const latestConversation = input.conversationId ? agentConversations.get(String(input.conversationId), document) : null;
    const compactedHistory = buildConversationContext(latestConversation?.messages || [], { recentLimit: 12, maxSummaryChars: 12000 });
    const modelHistory = compactedHistory.compacted
      ? [{ role: "system", content: `Compressed conversation memory: ${JSON.stringify(compactedHistory.summary)}` }, ...compactedHistory.recent]
      : compactedHistory.recent;
    const upstream = (turn === 0 && forcedConfirmedCall)
      ? { protocol: "resume", raw: null, toolCalls: [forcedConfirmedCall], text: "" }
      : await requestAgentToolTurnWithRetry(provider, input.conversationId ? "" : instruction, agentSystemPrompt(plannerContext), { mode, includeQueries: true, history: modelHistory, omitPrompt: Boolean(input.conversationId) });
    forcedConfirmedCall = null;
    if (upstream.text) {
      lastText = upstream.text;
      onEvent("assistant", { text: upstream.text, turn: turn + 1 });
      if (input.conversationId && !upstream.toolCalls.length) await agentConversations.append(input.conversationId, document, { role: "assistant", content: upstream.text, revision: context.revision });
    }
    toolCount += upstream.toolCalls.length;
    if (!upstream.toolCalls.length) {
      if (input.conversationId) await agentConversations.updateState(input.conversationId, document, { activePlan: null, pendingPrompt: null, pendingToolCall: null, pendingRevision: null, pendingFingerprint: null });
      return { status: "completed", text: lastText || "Agent completed the task.", turns: turn + 1, toolCount, result: lastResult };
    }
    const preflight = [];
    let blocking = null;
    let failed = null;
    for (let index = 0; index < upstream.toolCalls.length; index += 1) {
      const call = upstream.toolCalls[index];
      onEvent("tool-call", { call, turn: turn + 1 });
      if (input.conversationId) await agentConversations.append(input.conversationId, document, { role: "assistant", content: index === 0 ? (upstream.text || `Tool call: ${call.name}`) : `Tool call: ${call.name}`, toolCallId: call.id, toolName: call.name, toolArguments: parseAgentToolArguments(call), ...(call.reasoningContent ? { reasoningContent: call.reasoningContent } : {}), revision: context.revision });
      const toolStartedAt = Date.now();
      const result = await executeAgentToolCall(call, { input, prompt, context, mode, turn, index, requestId, confirmed, deferMutation: true });
      recordAgentAudit({ type: "agent.tool", documentId: document, conversationId: input.conversationId, requestId, providerId: provider.id, model: provider.model, operation: result.step?.operation || call.name, status: result.status, turn: turn + 1, durationMs: Date.now() - toolStartedAt, revision: result.revision ?? context.revision, summary: result.error || result.plan?.summary || "" });
      preflight.push({ call, result });
      if (result.status === "query") {
        onEvent("tool-result", { call, result, turn: turn + 1 });
        if (input.conversationId) await agentConversations.append(input.conversationId, document, { role: "tool", content: JSON.stringify(result).slice(0, 12000), toolCallId: call.id, toolName: call.name, toolArguments: parseAgentToolArguments(call), toolResult: result, revision: result.revision ?? context.revision });
      } else if (result.status === "awaiting-confirmation" || result.status === "needs-input" || result.status === "blocked") {
        blocking ||= { call, result };
      } else if (result.status === "failed") {
        failed ||= { call, result };
      }
    }
    if (mode === "plan" && blocking) {
      const proposedPlans = preflight.map((item) => item.result.plan).filter((item) => item && Array.isArray(item.steps));
      if (proposedPlans.length > 1) {
        const base = proposedPlans[0];
        const steps = proposedPlans.flatMap((item) => item.steps).map((step, index) => ({ ...step, id: `plan-step-${index + 1}`, risk: "none" }));
        blocking.result = { ...blocking.result, plan: { ...base, status: "ready", risk: "none", steps, summary: steps.map((step) => step.explanation || step.operation).join(" → ").slice(0, 1000), confirmation: undefined } };
      }
    }
    if (blocking) {
      for (const item of preflight) {
        if (item.result.status === "query") continue;
        onEvent("tool-result", { call: item.call, result: item.result, turn: turn + 1 });
        if (input.conversationId) await agentConversations.append(input.conversationId, document, { role: "tool", content: JSON.stringify(item.result).slice(0, 12000), toolCallId: item.call.id, toolName: item.call.name, toolArguments: parseAgentToolArguments(item.call), toolResult: item.result, revision: item.result.revision ?? context.revision });
      }
      const result = blocking.result;
      if (input.conversationId && (result.status === "awaiting-confirmation" || result.status === "needs-input")) {
        const pendingRevision = result.revision ?? context.revision;
        await agentConversations.updateState(input.conversationId, document, { activePlan: result.plan || null, pendingPrompt: prompt, pendingToolCall: result.pendingToolCall || null, pendingRevision, pendingFingerprint: result.pendingToolCall ? confirmationFingerprint({ planId: result.plan?.planId || null, revision: pendingRevision, call: result.pendingToolCall }) : null });
      }
      if (result.status === "blocked") return { status: "blocked", text: result.reason, turns: turn + 1, toolCount, plan: result.plan || null, result };
      return { status: result.status, text: result.plan?.summary || "Additional confirmation or information is required.", turns: turn + 1, toolCount, plan: result.plan || null, pendingToolCall: result.pendingToolCall || null, questions: result.questions || [], result };
    }
    if (failed) {
      const failureFingerprint = String(failed.result.error || failed.result.resolver?.errors?.[0]?.code || "unknown").slice(0, 300);
      const failureCount = (failureFingerprints.get(failureFingerprint) || 0) + 1;
      failureFingerprints.set(failureFingerprint, failureCount);
      if (failureCount >= 2) return { status: "failed", text: "同一参数错误连续出现，已停止自动重试，请修正后继续。", turns: turn + 1, toolCount, result: { ok: false, status: "failed", code: "REPEATED_TOOL_ERROR", error: failed.result.error, fingerprint: failureFingerprint } };
      for (const item of preflight) {
        if (item.result.status === "query") continue;
        const result = item.result.status === "prepared" ? { ...item.result, status: "not-executed", error: "Batch preflight failed; no mutation was committed." } : item.result;
        onEvent("tool-result", { call: item.call, result, turn: turn + 1 });
        if (input.conversationId) await agentConversations.append(input.conversationId, document, { role: "tool", content: JSON.stringify(result).slice(0, 12000), toolCallId: item.call.id, toolName: item.call.name, toolArguments: parseAgentToolArguments(item.call), toolResult: result, revision: result.revision ?? context.revision });
      }
      turnPrompt = `The CAD tool preflight failed: ${failed.result.error || "invalid arguments"}. Correct the arguments using the structured error and try again.`;
      confirmed = false;
      continue;
    }
    const mutationItems = preflight.filter((item) => item.result.status === "prepared");
    if (mutationItems.length) {
      const batch = await executeMutationBatch(mutationItems.map((item) => ({ operation: item.result.step.operation, fields: item.result.fields }))).catch(error=>({response:{ok:false,code:error.code || "BATCH_FAILED",error:error.message,fieldPath:error.fieldPath,selectionPaths:error.selectionPaths},results:[]}));
      for (let index = 0; index < mutationItems.length; index += 1) {
        const item = mutationItems[index];
        const individual = batch.results[index] || batch.response;
        const recoveryRequired=["PROJECT_ROLLBACK_FAILED","PROJECT_RECOVERY_REQUIRED","HISTORY_RESTORE_FAILED"].includes(batch.response?.code);
        const result = { ...item.result, ok: Boolean(batch.response?.ok && individual?.ok), status: recoveryRequired?"recovery-required":batch.response?.ok && individual?.ok?"executed":individual?.status || "not-executed", result: individual, revision: individual?.revision ?? context.revision };
        onEvent("tool-result", { call: item.call, result, turn: turn + 1 });
        if (input.conversationId) await agentConversations.append(input.conversationId, document, { role: "tool", content: JSON.stringify(result).slice(0, 12000), toolCallId: item.call.id, toolName: item.call.name, toolArguments: parseAgentToolArguments(item.call), toolResult: result, revision: result.revision ?? context.revision });
      }
      if (batch.response?.ok) lastResult = batch.response;
      else turnPrompt = `The CAD mutation batch failed: ${batch.response?.error || "unknown error"}. Inspect the current model and correct the tool arguments.`;
      context.revision = batch.response?.revision ?? context.revision;
      confirmed = false;
    }
  }
  return { status: "max-turns", text: "Agent reached the maximum number of tool turns; review the current model and continue if needed.", turns: agentLoopMaxTurns, toolCount, result: lastResult };
}
async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxJsonBodyBytes) throw new GatewayRequestError("REQUEST_TOO_LARGE", `Request body exceeds ${maxJsonBodyBytes} bytes.`);
  }
  if(shuttingDown)throw new GatewayRequestError('SERVICE_STOPPING','后台正在停止，上传内容未作为新操作执行。');
  return body ? JSON.parse(body) : {};
}

async function readBinary(request, limit = maxStepUploadBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new GatewayRequestError("REQUEST_TOO_LARGE", `文件上传超过 ${Math.round(limit / 1024 / 1024)} MiB 限制。`);
    chunks.push(chunk);
  }
  if (length === 0) throw new GatewayRequestError("EMPTY_UPLOAD", "上传文件为空。");
  if(shuttingDown)throw new GatewayRequestError('SERVICE_STOPPING','后台正在停止，上传文件未作为新操作执行。');
  return Buffer.concat(chunks);
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  return number;
}

function documentId(value = "default") {
  const id = String(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("documentId is invalid.");
  return id;
}

class GatewayRequestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

const KNOWN_OPERATIONS = new Set(["health.ping", "document.create", "document.summary", "document.view", "document.preview", "document.naming.preview", "document.naming.upgrade", "body.presentation", ...CAD_OPERATION_NAMES, "property.type.create", "property.type.update", "property.type.delete", "property.type.list", "property.instance.create", "property.instance.update", "property.instance.delete", "property.instance.retarget", "property.instance.list", "property.package.export", "property.package.import", "step.import", "step.export", "document.snapshot", "document.restore"]);
const PROPERTY_SCHEMA_OPERATIONS = new Set(["property.type.create", "property.type.update", "property.type.delete", "property.type.list", "property.type.preview", "property.instance.create", "property.instance.update", "property.instance.delete", "property.instance.retarget", "property.instance.list", "property.package.export", "property.package.import"]);
const MESH_STRATEGY_OPERATIONS=new Set(['mesh.strategy.create','mesh.strategy.update','mesh.strategy.delete','mesh.strategy.list']);
const READ_ONLY_OPERATIONS=new Set(["health.ping", "document.summary", "document.view", "document.preview", "document.naming.preview", "feature.input.preview", "body.presentation", "property.list", "property.type.list", "property.type.preview", "property.instance.list", "property.package.export", "geometry.check", "geometry.measure", "geometry.relation"]);
KNOWN_OPERATIONS.add("property.type.preview");
KNOWN_OPERATIONS.add("feature.input.preview");
READ_ONLY_OPERATIONS.add('mesh.strategy.list');
function isPropertySchemaOperation(operation) { return PROPERTY_SCHEMA_OPERATIONS.has(String(operation || "")); }
function isProjectDataOperation(operation){return isPropertySchemaOperation(operation)||MESH_STRATEGY_OPERATIONS.has(operation);}
function executeProjectDataOperation(operation,fields){return MESH_STRATEGY_OPERATIONS.has(operation)?executeMeshStrategyOperation(operation,fields):executePropertySchemaOperation(operation,fields);}
function commandRequestFields(input,id){
  const clientRequestId=input.options?.idempotencyKey||input.idempotencyKey||input.requestId||'';
  return {documentId:id,requestId:String(input.requestId||clientRequestId||randomUUID()),
    ...(input.baseRevision===undefined?{}:{baseRevision:input.baseRevision}),...(input.baseStateToken===undefined?{}:{baseStateToken:input.baseStateToken}),
    ...(input.workerCapabilityPrecondition===undefined?{}:{workerCapabilityPrecondition:input.workerCapabilityPrecondition}),...(clientRequestId?{clientRequestId:String(clientRequestId)}:{}),
    ...(input.options?.agentPlanId?{agentPlanId:String(input.options.agentPlanId)}:{}),...(input.options?.conversationId?{conversationId:String(input.options.conversationId)}:{}),inputs:input.inputs||{},parameters:input.parameters||{}};
}
function noteRejectedWrite(input, operation, error, routeDocument = input?.documentId || 'default') {
  if (!input || (input.documentId || 'default') !== routeDocument || !/^[A-Za-z0-9_-]{1,64}$/.test(routeDocument)
      || !input.requestId || !(operation === 'project.batch' || KNOWN_OPERATIONS.has(operation))
      || READ_ONLY_OPERATIONS.has(operation) || input.preview === true || input.options?.preview === true) return;
  commandJournal.start({documentId:routeDocument, operation, requestId:input.requestId, rejectedCode:error.code || 'INVALID_COMMAND'});
}
function prepareTaskCommand(input, reservationDocument){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ModelingTaskError('MODELING_TASK_ARGUMENTS','任务 command 必须是对象。',400);
  if(input.operation==='project.batch'){
    if(!input.batchId&&!input.requestId)throw new ModelingTaskError('MODELING_TASK_REQUEST_KEY_REQUIRED','批量任务必须提供稳定的批次身份。',400);
    let batch;
    try { batch=prepareBatchInput(input); }
    catch (error) { if (reservationDocument) noteRejectedWrite(input,'project.batch',error,reservationDocument); throw error; }
    return {documentId:batch.document,operation:'project.batch',requestKey:batch.batchId,journalRequestId:input.requestId||batch.batchId,digest:createHash('sha256').update(stableJson(input)).digest('hex'),outcomeFingerprint:idempotencyFingerprint('project.batch',batchReceiptFields(batch.batchId,batch.steps))};
  }
  const operation=normalizeOperation(String(input.operation||''));
  try { validateCommandInput(input,operation); }
  catch (error) { if (reservationDocument) noteRejectedWrite(input,operation,error,reservationDocument); throw error; }
  if(READ_ONLY_OPERATIONS.has(operation)||input.options?.preview===true||input.preview===true||['document.snapshot','document.restore','step.import','step.export','document.naming.upgrade'].includes(operation))throw new ModelingTaskError('MODELING_TASK_OPERATION_UNSUPPORTED','此路径暂不支持任务取消；请使用原专用工作流。',400);
  const document=documentId(input.documentId),fields=commandRequestFields(input,document);
  if(!fields.clientRequestId)throw new ModelingTaskError('MODELING_TASK_REQUEST_KEY_REQUIRED','任务必须提供稳定的命令去重身份。',400);
  const outcomeFields=['document.undo','document.redo'].includes(operation)?{documentId:document,clientRequestId:fields.clientRequestId}:fields;
  return {documentId:document,operation,requestKey:fields.clientRequestId,journalRequestId:fields.requestId,digest:createHash('sha256').update(stableJson(input)).digest('hex'),outcomeFingerprint:idempotencyFingerprint(operation,outcomeFields)};
}

function piCadSession(request, id, required = false) {
  const sessionId = request.headers['x-cad-pi-session'], token = request.headers['x-cad-pi-token'];
  if (!required && sessionId === undefined && token === undefined) return null;
  const session = typeof sessionId === 'string' ? piRuntime.get(sessionId) : null;
  if (!isLivePi(session) || session.documentId !== id || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || !session.cadToolToken || !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(session.cadToolToken, 'hex')))
    throw new ModelingTaskError('PI_CAD_SESSION_FORBIDDEN','助手工具与当前会话或工程不匹配。',403);
  authorizeModelingTaskRequest(request,webOrigin,port);
  return session;
}

function reservePiWrite(request, response, input, meta) {
  const session = piCadSession(request,meta.documentId);
  const operation = { ...input, operation:meta.operation };
  if (!session || !requiresPiWriteApproval(operation)) return undefined;
  if (operation.operation === 'project.batch' && (operation.steps.length < 2 || operation.steps.length > 16))
    throw new ModelingTaskError('PI_BATCH_SIZE','助手批次需要 2 到 16 条现有 Body 操作。',400);
  // Hold the HTTP task registration, not a native queue slot, while the user reviews.
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  response.once('close',disconnect);
  return (async () => {
    try {
      const piApprovalId = await piWriteApprovals.request(session,meta,input.baseStateToken,() =>
        serializeDocument(meta.documentId,async () => {
          const view = await command('document.summary',{documentId:meta.documentId});
          if (!view.ok || !Array.isArray(view.bodyMetadata))
            throw new ModelingTaskError('PI_APPROVAL_TARGET_UNAVAILABLE','无法核对工程中的受影响对象，请重新读取工程。',503);
          if (input.baseRevision !== undefined && input.baseRevision !== view.revision)
            throw new ModelingTaskError('PI_APPROVAL_STALE','原修订号已失效，请让助手重新读取工程和选择对象。');
          return {revision:view.revision,steps:summarizePiWrite(operation,view)};
        },{signal:controller.signal}),controller.signal);
      if (controller.signal.aborted || response.destroyed) {
        piWriteApprovals.revoke(session,piApprovalId);
        throw new ModelingTaskError('PI_APPROVAL_CANCELLED','助手连接已中断，未登记写入任务。');
      }
      return {piApprovalId};
    } finally { response.off('close',disconnect); }
  })();
}

function claimCommandTask(request, input, id, operation) {
  const taskId = request.headers['x-cad-task-id'];
  const session = piCadSession(request,id);
  if (taskId === undefined) {
    if (session) throw new ModelingTaskError('PI_APPROVAL_TASK_REQUIRED','助手写入必须提交原建模任务。',403);
    return {};
  }
  authorizeModelingTaskRequest(request,webOrigin,port);
  if (typeof taskId !== 'string') throw new ModelingTaskError('MODELING_TASK_INVALID','任务标识必须是唯一字符串。',400);
  const meta = prepareTaskCommand(input);
  const record = modelingTasks.checked(taskId,id);
  const approvalId = record.piApprovalId;
  if (approvalId && !session || session && requiresPiWriteApproval({...input,operation}) && !approvalId)
    throw new ModelingTaskError('PI_APPROVAL_REQUIRED','助手写入需要当前会话确认，未执行。',403);
  const beforeExecute = approvalId ? () => piWriteApprovals.consume(session,approvalId,meta) : undefined;
  return {task:modelingTasks.claim(taskId,meta),beforeExecute};
}

function prepareBatchInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new GatewayRequestError('INVALID_BATCH','批量请求必须是对象。');
  if(input.protocolVersion!==undefined&&input.protocolVersion!==1)throw new GatewayRequestError('UNSUPPORTED_PROTOCOL','批量请求仅支持 protocolVersion 1。');
  if(input.operation!==undefined&&input.operation!=='project.batch')throw new GatewayRequestError('INVALID_BATCH','批量请求不能伪装成单条命令。');
  for(const field of ['batchId','requestId'])if(input[field]!==undefined&&(typeof input[field]!=='string'||Buffer.byteLength(input[field])>480||/[\u0000-\u001f\u007f]/.test(input[field])))throw new GatewayRequestError('INVALID_REQUEST_KEY','批量请求标识必须是最多 480 字节、不含控制字符的字符串。',{fieldPath:field});
  const document=documentId(input.documentId),batchId=String(input.batchId||input.requestId||randomUUID());
  if(!Array.isArray(input.steps)||!input.steps.length||input.steps.length>64)throw new GatewayRequestError('INVALID_BATCH','steps must contain between 1 and 64 commands.');
  if(input.preview===true||input.options?.preview===true)throw new GatewayRequestError('BATCH_OPERATION_UNSUPPORTED','批量修改不能作为预览提交。');
  const batchRevision=input.baseRevision===undefined?undefined:Math.trunc(finiteNumber(input.baseRevision,'baseRevision'));
  if(input.workerCapabilityPrecondition!==undefined)validateCapabilityPrecondition(input.workerCapabilityPrecondition);
  if(input.baseStateToken!==undefined)validateCommandInput({baseStateToken:input.baseStateToken},'document.summary');
  const steps=input.steps.map((step,index)=>{
    const operation=normalizeOperation(String(step?.operation||''));
    validateCommandInput({...step,documentId:document,operation,inputs:replaceBatchReferencesForValidation(step?.inputs||{}),parameters:replaceBatchReferencesForValidation(step?.parameters||{})},operation);
    if(step?.preview===true||step?.options?.preview===true||['document.snapshot','document.restore','step.import','step.export','document.undo','document.redo','feature.input.preview','document.naming.preview','document.naming.upgrade'].includes(operation))throw new GatewayRequestError('BATCH_OPERATION_UNSUPPORTED',`${operation} is not allowed in a mutation batch.`);
    return {stepId:String(step?.stepId||`step-${index}`),operation,fields:{documentId:document,requestId:String(step?.requestId||`${batchId}:${index}`),
      ...(index===0&&batchRevision!==undefined?{baseRevision:batchRevision}:{}),...(input.baseStateToken!==undefined?{baseStateToken:input.baseStateToken}:{}),...(step?.baseStateToken!==undefined?{baseStateToken:step.baseStateToken}:{}),
      ...((step?.workerCapabilityPrecondition??input.workerCapabilityPrecondition)===undefined?{}:{workerCapabilityPrecondition:step?.workerCapabilityPrecondition??input.workerCapabilityPrecondition}),
      clientRequestId:String(step?.idempotencyKey||step?.clientRequestId||`${batchId}:${index}`),inputs:step?.inputs||{},parameters:step?.parameters||{},...(input.options?.agentPlanId?{agentPlanId:String(input.options.agentPlanId)}:{})}};
  });
  validateMutationBatch(steps);
  return {document,batchId,steps};
}
function batchReceiptFields(batchId,steps){return {documentId:steps[0].fields.documentId,clientRequestId:batchId,parameters:{version:1,steps:steps.map(step=>({stepId:step.stepId,operation:step.operation,fingerprint:idempotencyFingerprint(step.operation,step.fields)}))}};}

const OPERATION_SCHEMAS = new Map([
  ["feature.input.preview", { inputs: { required:["featureId"],kind:"identifier" } }],
  ["primitive.box", { parameters: { required: ["width", "depth", "height"], kind: "scalar" } }],
  ["primitive.cylinder", { parameters: { required: ["radius", "height"], kind: "scalar" } }],
  ["primitive.cone", { parameters: { required: ["radius1", "radius2", "height"], kind: "scalar" } }],
  ["primitive.sphere", { parameters: { required: ["radius"], kind: "scalar" } }],
  ["primitive.torus", { parameters: { required: ["majorRadius", "minorRadius"], kind: "scalar" } }],
  ["transform.translate", { inputs: { required: ["bodyId"], kind: "identifier" }, parameters: { required: ["dx", "dy", "dz"], kind: "scalar" } }],
  ["pattern.linear", { inputs: { required: ["bodyId"], kind: "identifier" }, parameters: { required: ["count", "spacing", "directionX", "directionY", "directionZ"], kind: "scalar" } }],
  ["pattern.circular", { inputs: { required: ["bodyId"], kind: "identifier" }, parameters: { required: ["count", "angleDegrees", "axisX", "axisY", "axisZ"], kind: "scalar" } }],
  ["pattern.rectangular", { inputs: { required: ["bodyId"], kind: "identifier" }, parameters: { required: ["countX", "countY", "spacingX", "spacingY"], kind: "scalar" } }],
  ["pattern.mirror", { inputs: { required: ["bodyId"], kind: "identifier" }, parameters: { required: ["normalX", "normalY", "normalZ"], kind: "scalar" } }],
  ["variable.set", { parameters: { required: ["name", "type", "expression"], kind: "scalar" } }],
  ["material.set", { parameters: { required: ["name"], kind: "scalar" } }],
  ["body.update", { inputs: { required: ["bodyId"], kind: "identifier" } }],
  ["property.set", { inputs: { required: ["kind", "bodyId"], kind: "identifier" }, parameters: { required: ["key", "type", "value"], kind: "value" } }],
  ["property.delete", { inputs: { required: ["kind", "bodyId"], kind: "identifier" }, parameters: { required: ["key"], kind: "scalar" } }],
  ["body.presentation", { inputs: { required: ["bodyId"], kind: "identifier" } }],
  ["boolean.cut", { inputs: { required: ["targetBody", "toolBody"], kind: "identifier" } }],
  ["boolean.fuse", { inputs: { required: ["targetBody", "toolBody"], kind: "identifier" } }],
  ["boolean.common", { inputs: { required: ["targetBody", "toolBody"], kind: "identifier" } }],
  ["geometry.relation", { inputs: { required: ["bodyA", "bodyB"], kind: "identifier" }, parameters: { required: [], kind: "scalar" } }],
]);

function validateOperationSchema(input, operation) {
  if(operation==="document.naming.preview" || operation==="document.naming.upgrade"){
    if(!Number.isInteger(input.baseRevision) || input.baseRevision<0 || Object.keys(input.inputs||{}).length || Object.keys(input.parameters||{}).length || input.preview===true || input.options?.preview===true)
      throw new GatewayRequestError("SCHEMA_VALIDATION_FAILED","命名升级是独立工程维护操作：必须提供当前修订，不接受几何参数；验证请使用 document.naming.preview。",{fieldPath:"baseRevision",retryableByModel:false});
    return;
  }
  if(["detail.sweep","detail.pipe"].includes(operation) && (input.inputs?.pathBodyId!==undefined || input.inputs?.pathEdgeIds!==undefined)){
    const values=input.inputs||{},id=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,96}$/.test(value);
    if(!id(values.bodyId)||!/^face-\d+-[1-9]\d*$/.test(values.faceId||"")||!id(values.pathBodyId)||!Array.isArray(values.pathEdgeIds)||!values.pathEdgeIds.length||values.pathEdgeIds.length>32||values.pathEdgeIds.some(edge=>!/^edge-\d+-[1-9]\d*$/.test(edge))||new Set(values.pathEdgeIds).size!==values.pathEdgeIds.length)
      throw new GatewayRequestError("SCHEMA_VALIDATION_FAILED","Curved sweep requires bodyId/faceId and pathBodyId with 1-32 distinct ordered pathEdgeIds.",{fieldPath:"inputs.pathEdgeIds",retryableByModel:true});
    return;
  }
  if(operation==="feature.input.preview"){
    const values=input.inputs || {},valid=value=>typeof value==="string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
    const feature=values.featureId!==undefined,coordinate=values.coordinateSystemId!==undefined,section=values.sectionId!==undefined,sweep=values.sweepInputId!==undefined;
    if(feature===coordinate || !valid(feature?values.featureId:values.coordinateSystemId)
      || (section && (!feature || !valid(values.sectionId)))
      || (sweep && (!feature || section || !valid(values.sweepInputId)))
      || ["sourceFeatureId","sourceBodyId","editedFeatureId"].some(key=>values[key]!==undefined&&!valid(values[key])))
      throw new GatewayRequestError("SCHEMA_VALIDATION_FAILED","Identify exactly one historical feature input or coordinate source.",{fieldPath:"inputs",retryableByModel:true});
    if(!coordinate && !section && !sweep && (values.sourceFeatureId!==undefined || values.sourceBodyId!==undefined))
      throw new GatewayRequestError("SCHEMA_VALIDATION_FAILED","Alternative historical sources require a coordinate, Loft section or curved sweep input slot.",{fieldPath:"inputs",retryableByModel:true});
    return;
  }
  if(operation.startsWith("boolean.")) {
    for(const role of ["target","tool"]) {
      const singular=`${role}Body`,plural=`${role}Bodies`,values=input.inputs || {};
      const identifier=value=>typeof value==="string" && /^[A-Za-z0-9_-]{1,96}$/.test(value);
      const multiple=values[plural] !== undefined;
      const valid=multiple ? Array.isArray(values[plural]) && values[plural].length>0 && values[plural].length<=256 && values[plural].every(identifier)
        && (values[singular] === undefined || (identifier(values[singular]) && values[plural].includes(values[singular]))) : identifier(values[singular]);
      if(!valid)throw new GatewayRequestError("SCHEMA_VALIDATION_FAILED",`${operation}.inputs.${multiple?plural:singular} must identify a non-empty Boolean input group.`,{fieldPath:`inputs.${multiple?plural:singular}`,expected:"Body identifier or non-empty Body identifier array (max 256)",received:values[multiple?plural:singular] ?? null,retryableByModel:true});
    }
    return;
  }
  const schema = OPERATION_SCHEMAS.get(operation);
  if (!schema) return;
  for (const [section, rule] of Object.entries(schema)) {
    const values = input[section] || {};
    for (const field of rule.required || []) {
      const value = values[field];
      const valid = rule.kind === "scalar"
        ? ((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.trim().length > 0))
        : rule.kind === "value"
          ? value !== undefined
        : (typeof value === "string" && value.trim().length > 0);
      if (!valid) throw new GatewayRequestError("SCHEMA_VALIDATION_FAILED", `${operation}.${section}.${field} is required.`, { fieldPath: `${section}.${field}`, expected: rule.kind, received: value ?? null, retryableByModel: true });
    }
  }
}

function validateCommandInput(input, operation) {
  if(input.workerCapabilityPrecondition!==undefined)validateCapabilityPrecondition(input.workerCapabilityPrecondition);
  for(const [field,value] of [['requestId',input.requestId],['idempotencyKey',input.idempotencyKey],['clientRequestId',input.clientRequestId],['options.idempotencyKey',input.options?.idempotencyKey]]){
    if(value!==undefined&&(typeof value!=='string'||Buffer.byteLength(value)>512||/[\u0000-\u001f\u007f]/.test(value)))throw new GatewayRequestError('INVALID_REQUEST_KEY','请求标识必须是最多 512 字节、不含控制字符的字符串。',{fieldPath:field});
  }
  if (typeof operation !== "string" || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){1,3}$/.test(operation))
    throw new GatewayRequestError("INVALID_OPERATION", "operation must use a qualified CAD command name.");
  if (!KNOWN_OPERATIONS.has(operation))
    throw new GatewayRequestError("UNSUPPORTED_OPERATION", `Operation is not enabled: ${operation}.`);
  if (input.protocolVersion !== undefined && input.protocolVersion !== 1)
    throw new GatewayRequestError("UNSUPPORTED_PROTOCOL", "protocolVersion must be 1.");
  if (input.inputs !== undefined && (!input.inputs || typeof input.inputs !== "object" || Array.isArray(input.inputs)))
    throw new GatewayRequestError("INVALID_INPUTS", "inputs must be a JSON object.");
  if (input.parameters !== undefined && (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters)))
    throw new GatewayRequestError("INVALID_PARAMETERS", "parameters must be a JSON object.");
  if (input.baseRevision !== undefined
      && (!Number.isInteger(input.baseRevision) || input.baseRevision < 0))
    throw new GatewayRequestError("INVALID_REVISION", "baseRevision must be a non-negative integer.");
  if (input.baseStateToken !== undefined && (typeof input.baseStateToken !== "string" || !/^[a-f0-9]{64}$/.test(input.baseStateToken)))
    throw new GatewayRequestError("INVALID_STATE_TOKEN", "baseStateToken must be a 64-character state token returned by the gateway.");
  validateOperationSchema(input, operation);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function idempotencyFingerprint(operation, fields) {
  return mutationFingerprint(operation, fields);
}
function idempotencyMatches(entry, operation, fields) {
  // Previously saved keys remain replayable with the original request fields.
  const legacyFields=Object.fromEntries(Object.entries(fields).filter(([key])=>key!=="clientRequestId"));
  return entry.fingerprint===idempotencyFingerprint(operation,fields) || entry.fingerprint===createHash("sha256").update(stableJson({operation,fields:legacyFields})).digest("hex");
}
function checkStatePrecondition(id, fields) {
  const currentStateToken=projectStateToken(id,historyFor(id));
  if(fields.baseStateToken!==undefined && fields.baseStateToken!==currentStateToken)
    throw new GatewayRequestError("PROJECT_STATE_CONFLICT","工程已被其他操作或窗口修改。草稿已保留，请重新载入最新数据后再编辑。",{currentStateToken});
}
async function checkWorkspaceSource(input){
  const id=input.sourceDocumentId;
  // Unloaded-source activation can escape a damaged workspace without loading or repairing it.
  if(input.sourceRevision===null&&input.sourceStateToken===null&&input.sourceStateSequence===null)return;
  if(!workspaces.known(id))throw new GatewayRequestError('WORKSPACE_NOT_FOUND','来源工程已不存在，未采用旧页面的切换请求。');
  projectTransactions.assertWritable(id);projectFiles.assertModelAccess(id);sourceRestores.assertModelAccess();
  if(input.sourceStateToken!==undefined)checkStatePrecondition(id,{baseStateToken:input.sourceStateToken});
  if(input.sourceRevision===undefined&&input.sourceStateSequence===undefined)return;
  const current=withHistoryState(projectFiles.check(await command('document.summary',{documentId:id})),id);
  if(input.sourceRevision!==undefined&&current.revision!==input.sourceRevision||input.sourceStateSequence!==undefined&&current.stateSequence!==input.sourceStateSequence||input.sourceStateToken!==undefined&&current.stateToken!==input.sourceStateToken)throw new GatewayRequestError('PROJECT_STATE_CONFLICT','来源工程状态已变化，未将旧页面的请求用于工程切换。');
}
function checkSelectionPrecondition(operation, fields) {
  const problem=selectionStateProblem(operation,fields);
  if(problem)throw new GatewayRequestError(problem.code,problem.error,problem);
}

function idempotencyKey(documentId, operation, clientRequestId) {
  if(clientRequestId!==undefined&&clientRequestId!==''&&(typeof clientRequestId!=='string'||Buffer.byteLength(clientRequestId)>512||/[\u0000-\u001f\u007f]/.test(clientRequestId)))throw new GatewayRequestError('INVALID_IDEMPOTENCY_KEY','请求去重键必须是最多 512 字节、不含控制字符的字符串。');
  return clientRequestId ? `${documentId}:${operation}:${clientRequestId}` : "";
}

function idempotencyConflict(id) {
  return withHistoryState({
    ok: false,
    protocolVersion: 1,
    code: "IDEMPOTENCY_CONFLICT",
    error: "The idempotency key was already used with a different command payload.",
    recoverable: false,
  }, id);
}
function recordedMutation(id,operation,fields){
  const key=idempotencyKey(id,operation,fields.clientRequestId),entry=key?(historyStore.get(id).idempotency||[]).find(item=>item.key===key):null;
  if(!entry)return null;
  return {response:idempotencyMatches(entry,operation,fields)?historyStore.readIdempotency(id,entry):idempotencyConflict(id)};
}
function transactionEvent(operation, fields, beforeRevision, afterRevision, eventId = `event-${randomUUID()}`) {
  return {
    eventId,
    requestId: fields.requestId || fields.clientRequestId || null,
    operation,
    beforeRevision: Number.isInteger(beforeRevision) ? beforeRevision : null,
    afterRevision: Number.isInteger(afterRevision) ? afterRevision : null,
    state: "committed",
    timestamp: new Date().toISOString(),
  };
}
function logCommand(operation, fields, result, startedAt, error = null) {
  const bodyIds = Array.isArray(result?.bodyPresentations) ? result.bodyPresentations.map((body) => body.bodyId).filter(Boolean) : (result?.bodyId ? [result.bodyId] : []);
  const featureIds = Array.isArray(result?.features) ? result.features.map((feature) => feature.id).filter(Boolean) : (result?.featureId ? [result.featureId] : []);
  const entry = {
    type: "cad.command",
    timestamp: new Date().toISOString(),
    requestId: fields.clientRequestId || fields.requestId || null,
    conversationId: fields.conversationId || null,
    agentPlanId: fields.agentPlanId || null,
    documentId: fields.documentId || null,
    operation,
    durationMs: Date.now() - startedAt,
    ok: Boolean(result?.ok),
    code: result?.code || (error?.code || null),
    revision: Number.isInteger(result?.revision) ? result.revision : null,
    bodyId: result?.bodyId || null,
    bodyIds,
    featureId: result?.featureId || null,
    featureIds,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function statusFor(result) {
  if (result.ok) return 200;
  if (result.code === "SELECTION_STATE_REQUIRED") return 428;
  return ["STALE_REVISION", "REVISION_CONFLICT", "PROJECT_STATE_CONFLICT"].includes(result.code) ? 409 : 400;
}

function snapshotPath(id) {
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, `${id}.xbf`);
}

function stepImportPath(id) {
  const directory = path.join(dataDir, "imports");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${id}-${Date.now()}-${process.pid}-${importSequence++}.step`);
}

function stepExportPath(id) {
  const directory = path.join(dataDir, "exports");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${id}.step`);
}


function historyFor(id) {
  return historyStore.get(id);
}

function withHistoryState(result, id, history = historyFor(id)) {
  const latestEvent = history.events?.at(-1) || null;
  const recoveryWarning=historyRecoveryWarning(history);
  const stateToken=result.stateToken || projectStateToken(id,history);
  const stateSequence=result.stateSequence ?? history.stateSequence;
  return {
    ...result,
    stateToken,
    stateSequence,
    ...(result.propertySchema?{propertySchema:{...result.propertySchema,stateToken:result.propertySchema.stateToken || stateToken,stateSequence:result.propertySchema.stateSequence ?? stateSequence}}:{}),
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
    history: {
      canUndo: history.undo.length > 0,
      canRedo: history.redo.length > 0,
      eventId: latestEvent?.eventId || null,
      lastEvent: latestEvent,
    },
    ...(history.restoreError ? { historyWarning: history.restoreError } : {}),
    ...(recoveryWarning?{recoveryWarning,warnings:[...new Set([...(result.warnings||[]),recoveryWarning])]}:{}),
  };
}

function appendHistory(stack, filePath) {
  return [...stack, filePath].slice(-50);
}

function historyError(id, error) {
  return withHistoryState({
    ok: false,
    protocolVersion: 1,
    code: "HISTORY_PERSIST_FAILED",
    error: error instanceof Error ? error.message : String(error),
  }, id);
}

function propertyPayload(fields) {
  return { ...(fields.inputs || {}), ...(fields.parameters || {}) };
}

async function executePropertySchemaOperation(operation, fields) {
  const id = fields.documentId || "default";
  const payload = propertyPayload(fields);
  checkSelectionPrecondition(operation,fields);
  checkStatePrecondition(id, fields);
  const geometry=await command("document.summary",{documentId:id});
  if(!geometry.ok)throw new GatewayRequestError(geometry.code||'DOCUMENT_LOAD_FAILED',geometry.error||'工程几何未成功加载，属性操作已停止。');
  if(!operation.endsWith(".list")&&operation!=="property.package.export"&&fields.baseRevision!==undefined&&fields.baseRevision!==geometry.revision)throw new GatewayRequestError("STALE_REVISION","几何已变化，请刷新工程后再修改属性。");
  if (["property.instance.create","property.instance.update","property.instance.retarget"].includes(operation) && payload.target) {
    const checked=checkPropertyTarget(payload.target,geometry);
    if(!checked.ok)throw new GatewayRequestError("PROPERTY_TARGET_INVALID",checked.reason);
    payload.target=checked.target;
  }
  if(["property.instance.create","property.instance.update","property.instance.retarget"].includes(operation) && payload.targets!==undefined){
    if(!Array.isArray(payload.targets)||payload.targets.length>256)throw new GatewayRequestError('PROPERTY_TARGET_INVALID','关联集合最多包含 256 项。');
    payload.targets=payload.targets.map((target,index)=>{if(!target)throw new GatewayRequestError('PROPERTY_TARGET_INVALID',`关联集合第 ${index+1} 项为空。`);const checked=checkPropertyTarget(target,geometry);if(!checked.ok)throw new GatewayRequestError('PROPERTY_TARGET_INVALID',`关联集合第 ${index+1} 项：${checked.reason}`);if(!checked.target.bodyIdentity || (checked.target.kind!=='body'&&!checked.target.topologyIdentity))throw new GatewayRequestError('PROPERTY_TARGET_INVALID','关联集合需要提供持久对象身份的几何内核。');return checked.target;});
  }
  let value,resolvedPropertyListing;
  if (operation === "property.type.list" || operation === "property.instance.list") {
    const listing = resolveProjectProperties(id,geometry);
    resolvedPropertyListing=listing;
    value = operation === "property.type.list" ? { types: listing.types } : { instances: listing.instances };
  } else if (operation === "property.type.create") value = { type: propertySchemaStore.createType(id, payload) };
  else if (operation === "property.type.update") value = { type: propertySchemaStore.updateType(id, payload) };
  else if (operation === "property.type.preview") value = { migration: propertySchemaStore.previewTypeUpdate(id, payload) };
  else if (operation === "property.type.delete") value = { deletedType: propertySchemaStore.deleteType(id, payload) };
  else if (operation === "property.instance.create") value = { instance: propertySchemaStore.createInstance(id, payload) };
  else if (operation === "property.instance.update") value = { instance: propertySchemaStore.updateInstance(id, payload) };
  else if (operation === "property.instance.retarget") value = { instance: propertySchemaStore.retargetInstance(id, payload) };
  else if (operation === "property.instance.delete") value = { deletedInstance: propertySchemaStore.deleteInstance(id, payload) };
  else if (operation === "property.package.export") value = { package: propertySchemaStore.exportTypes(id, payload) };
  else if (operation === "property.package.import") value = { import: propertySchemaStore.importTypes(id, payload) };
  else throw new Error(`Unsupported property schema operation: ${operation}.`);
  const listing=resolvedPropertyListing||resolvePropertySchema(propertySchemaStore.list(id),geometry);
  if(value.instance)value.instance=listing.instances.find(instance=>instance.instanceId===value.instance.instanceId);
  return { ok: true, protocolVersion: 1, documentId: id, revision:geometry.ok ? geometry.revision : null, ...value, propertySchema:listing,...(listing.associationCache?{propertyAssociationCache:listing.associationCache}:{}) };
}
function startsNewDocument(operation, fields) {
  return operation === "document.create" || operation === "document.restore"
    || (operation.startsWith("primitive.") && fields.parameters?.reset === true);
}

function assertProjectDataCheckpoint(id){
  const history=historyFor(id);if(!history.current)return;
  const certified=historyStore.readProjectData(id,history.current);
  if(certified&&stableJson(projectDataStore.list(id))!==stableJson(certified))throw new GatewayRequestError('PROJECT_DATA_OUT_OF_SYNC','工程数据与完整检查点不一致，未采用游离文件中的方案。');
}
function referencedMeshStrategy(id,ref){assertProjectDataCheckpoint(id);return meshStrategyStore.referenced(id,ref);}
async function executeMeshStrategyOperation(operation,fields){
  const id=fields.documentId||'default',payload=propertyPayload(fields),readOnly=operation==='mesh.strategy.list';
  if(!readOnly&&!fields.baseStateToken)throw new GatewayRequestError('MISSING_STATE_TOKEN','方案修改必须提供来自同一次工程观察的状态凭据。');
  checkStatePrecondition(id,fields);const geometry=await command('document.summary',{documentId:id});if(!geometry.ok)throw new GatewayRequestError(geometry.code||'DOCUMENT_LOAD_FAILED',geometry.error||'工程未成功载入。');if(!projectTransactions.active.has(id))assertProjectDataCheckpoint(id);
  if(!readOnly&&fields.baseRevision!==undefined&&fields.baseRevision!==geometry.revision)throw new GatewayRequestError('STALE_REVISION','几何已变化，请重新核对方案目标。');
  if(payload.options!==undefined){const options=normalizeMeshStrategyOptions(payload.options);validateMeshSizingSource(options.sizing,geometry);for(const rule of options.sizing?.rules||[]){const target=rule.target,body=geometry.bodyMetadata.find(row=>row.bodyId===target.bodyId);if(!['solid','sheet'].includes(body.kind))throw new GatewayRequestError('MESH_STRATEGY_TARGET_INVALID','局部网格方案只接受实体或面体。');if(target.kind==='face'){const result=await command('geometry.measure',{documentId:id,inputs:{bodyId:target.bodyId,selectionType:'face',selectionId:target.cadFaceId}});if(!result.ok)throw new GatewayRequestError('MESH_STRATEGY_TARGET_INVALID','方案关联面不存在，未保存无效的选择。');}}payload.options=options;}
  let value={};
  if(readOnly)meshStrategyKeys(payload,[]);
  else if(operation==='mesh.strategy.create')value={strategy:meshStrategyStore.create(id,payload)};
  else if(operation==='mesh.strategy.update')value={strategy:meshStrategyStore.update(id,payload)};
  else if(operation==='mesh.strategy.delete')value={deletedStrategy:meshStrategyStore.delete(id,payload)};
  else throw new GatewayRequestError('UNSUPPORTED_OPERATION','不支持此网格方案操作。');
  const library=meshStrategyStore.list(id);return {ok:true,protocolVersion:1,documentId:id,revision:geometry.revision,...value,meshStrategies:{...library,strategies:library.strategies.map(strategy=>({...strategy,definitionHash:meshStrategyHash(strategy),...meshStrategyState(strategy,geometry)}))}};
}

async function ensureCurrentCheckpoint(id, history, before) {
  if (history.current || !before.ok) return { history };
  const checkpointPath = historyStore.snapshotPath(id);
  const saved = await command("document.snapshot", {
    documentId: id,
    parameters: { path: checkpointPath },
  });
  if (!saved.ok) {
    historyStore.discard(checkpointPath);
    return { error: withHistoryState(saved, id) };
  }
  try {
    return { history: historyStore.commit(id, { ...history, current: checkpointPath }) };
  } catch (error) {
    historyStore.discard(checkpointPath);
    return { error: historyError(id, error) };
  }
}

function quarantineInvalidSnapshot(id,file,force=false) {
  if(!file || !force&&historyStore.isValidSnapshot(id,file))return;
  const directory=path.join(dataDir,"history-quarantine",id);fs.mkdirSync(directory,{recursive:true});
  for(const source of [file,file+".properties.json",propertySchemaStore.filePath(id)]){
    if(!fs.existsSync(source)||!fs.lstatSync(source).isFile())continue;
    const bytes=fs.readFileSync(source),hash=createHash("sha256").update(bytes).digest("hex"),target=path.join(directory,`${path.basename(source)}-${hash}.corrupt`);
    if(!fs.existsSync(target))fs.writeFileSync(target,bytes);
  }
}

async function recoverLiveCheckpoint(id,history,wasLoaded) {
  if(history.current&&!historyStore.isValidProjectData(id,history.current))return history;
  const expected=history.events.at(-1)?.afterRevision;
  if(!wasLoaded || !Number.isSafeInteger(expected))return history;
  const live=await command("document.summary",{documentId:id});
  if(!live.ok || live.revision!==expected)return history;
  const target=historyStore.snapshotPath(id);
  try{
    const saved=await command("document.snapshot",{documentId:id,parameters:{path:target}});if(!saved.ok)return history;
    quarantineInvalidSnapshot(id,history.current);
    const next=historyStore.commit(id,{...history,current:target,undo:history.undo.filter(file=>historyStore.isValidSnapshot(id,file)),redo:history.redo.filter(file=>historyStore.isValidSnapshot(id,file)),restoreError:null,events:[...history.events,{eventId:`recovered-live-${Date.now()}-${process.pid}`,operation:"history.recover-live",beforeRevision:expected,afterRevision:live.revision,timestamp:new Date().toISOString()}]});
    process.stderr.write(`[history] ${id}: recreated a missing or damaged checkpoint from verified live revision ${live.revision}.\n`);return next;
  }catch(error){historyStore.discard(target);process.stderr.write(`[history] ${id}: live recovery failed: ${error.message}\n`);return history;}
}

function verifyStepAppend(before, result) {
  const expected = result.stepImport?.bodyCount;
  const previousBodies = new Map(before.bodyMetadata.map(body => [body.bodyId, body]));
  const bodies = new Map((result.bodyMetadata || []).map(body => [body.bodyId, body]));
  const features = result.features || [];
  const feature = features.at(-1);
  const outputs = new Set(feature?.outputBodies);
  const newBodies = [...bodies.values()].filter(body => !previousBodies.has(body.bodyId));
  const valid = result.documentId === before.documentId && result.revision === before.revision + 1
    && Number.isSafeInteger(expected) && expected > 0 && newBodies.length === expected
    && result.bodyCount === before.bodyCount + expected && bodies.size === result.bodyCount
    && features.length === before.features.length + 1 && feature?.type === 'import.step'
    && feature.computedRevision === result.revision && outputs.size === expected && outputs.has(result.activeBodyId)
    && newBodies.every(body => outputs.has(body.bodyId) && body.topologyRevision === result.revision)
    && isDeepStrictEqual(features.slice(0, -1), before.features)
    && [...previousBodies].every(([id, body]) => isDeepStrictEqual(bodies.get(id), body))
    && ['variables', 'coordinateSystems', 'materials', 'propertyRecords'].every(key => isDeepStrictEqual(result[key], before[key]));
  if (!valid) throw new GatewayRequestError('STEP_APPEND_UNVERIFIED', '未能验证 STEP 追加保留了原工程，导入未提交。请检查几何 Worker 版本。');
}

async function executeMutationUnlocked(operation, fields, preparedHistory, onPhase, createReceipt) {
  assertCapabilityPrecondition(fields.workerCapabilityPrecondition,nativeCapabilities());
  const id = fields.documentId || "default";
  const clientRequestId = fields.clientRequestId || "";
  if(createReceipt&&operation!=='document.create')throw new Error('Creation receipt used for an incompatible mutation.');
  const cacheKey = createReceipt?.key || idempotencyKey(id, operation, clientRequestId);
  const fingerprint = createReceipt?.fingerprint || idempotencyFingerprint(operation, fields);
  const resetHistory = startsNewDocument(operation, fields);
  const wasLoaded=loadedDocuments.has(id);
  let history = preparedHistory || historyStore.repair(id);
  if(history.restoreError && !resetHistory)history=await recoverLiveCheckpoint(id,history,wasLoaded);
  const recoveredLive=history.events.at(-1)?.operation==="history.recover-live";
  if (history.restoreError && !resetHistory) {
    return withHistoryState({
      ok: false,
      protocolVersion: 1,
      code: "HISTORY_RESTORE_FAILED",
      error: history.restoreError,
    }, id);
  }

  checkSelectionPrecondition(operation,fields);
  checkStatePrecondition(id, fields);
  const before = await command("document.summary", { documentId: id });
  if (operation === 'step.import' && !before.ok) return withHistoryState(before, id);
  if(operation==='step.import'&&fields.baseRevision!==undefined&&before.revision!==fields.baseRevision)throw new GatewayRequestError('STALE_REVISION','工程修订已改变，STEP 未导入；请核对当前工程后重新选择文件。');
  const checkpoint = await ensureCurrentCheckpoint(id, history, before);
  if (checkpoint.error) return checkpoint.error;
  history = checkpoint.history;

  onPhase?.('converting');
  const result = isProjectDataOperation(operation) ? await executeProjectDataOperation(operation, fields) : await command(operation, fields);
  if (!result.ok) return withHistoryState(result, id);
  if (operation === 'step.import') verifyStepAppend(before, result);
  if(operation==="document.naming.upgrade" && result.importedNamingUpgrade?.changed===false)return withHistoryState(result,id);
  onPhase?.('committing',{report:result.stepImport});
  modelingTasks.beginCommit();
  if (operation === "document.create") projectDataStore.reset(id);

  const nextPath = historyStore.snapshotPath(id);
  const saved = await command("document.snapshot", {
    documentId: id,
    parameters: { path: nextPath },
  });
  if (!saved.ok) {
    historyStore.discard(nextPath);
    if (history.current) await command("document.restore", {
      documentId: id,
      parameters: { path: history.current },
    });
    return historyError(id, new Error("The model changed but its durable history checkpoint could not be saved."));
  }

  const event = transactionEvent(operation, fields, before.revision, result.revision);
  const nextHistory = {
    ...history,
    current: nextPath,
    undo: resetHistory || !history.current ? [] : appendHistory(history.undo, history.current),
    redo: [],
    restoreError: null,
    events: resetHistory ? [event] : [...(history.events || []), event],
  };
  let presentedResult = result;
  if(createReceipt){
    const view=projectFiles.check(await command('document.view',{documentId:id}));
    if(view.bodyCount!==0||view.featureCount!==0||!['features','bodies','bodyMetadata','variables','propertyRecords'].every(key=>Array.isArray(view[key])&&view[key].length===0)||!['faceCount','edgeCount','triangleCount'].every(key=>view.stats?.[key]===0))throw new ModelingTaskError('PROJECT_CREATE_NOT_EMPTY','新建结果不是经过核对的完整空工程，未提交。',503);
    presentedResult={...result,...view,requestId:createReceipt.projectCreate.requestId,propertySchema:resolvePropertySchema(propertySchemaStore.list(id),view),projectCreate:createReceipt.projectCreate};
  } else if (Number(result.bodyCount) > 1) {
    const view = await command("document.view", { documentId: id });
    if (view.ok) presentedResult = { ...result, ...view };
  }
  const response = withHistoryState(recoveredLive ? {...presentedResult,warnings:[...(presentedResult.warnings || []),"异常检查点已从经核验的内核状态重建；损坏文件已保留在隔离目录。"]} : presentedResult, id,historyStore.prepareCommit(id,nextHistory));
  if(cacheKey)nextHistory.idempotency=[...(history.idempotency||[]),{key:cacheKey,fingerprint,response,recordedAt:new Date().toISOString()}];
  try {
    historyStore.commit(id, nextHistory);
  } catch (error) {
    historyStore.discard(nextPath);
    if (history.current) await command("document.restore", {
      documentId: id,
      parameters: { path: history.current },
    });
    return historyError(id, error);
  }
  return response;
}

function validateMutationBatch(steps){
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("Mutation batch must contain at least one step.");
  const id = steps[0].fields.documentId || "default";
  if (steps.some((step) => (step.fields.documentId || "default") !== id)) throw new Error("Mutation batch cannot span documents.");
  const stepIds=new Set(),requestKeys=new Set();
  for(const step of steps){
    const key=idempotencyKey(id,step.operation,step.fields.clientRequestId);
    if(step.stepId&&stepIds.has(step.stepId)||key&&requestKeys.has(key))throw new GatewayRequestError('INVALID_BATCH','批量命令中的步骤 ID 和同操作请求键必须唯一；未执行任何步骤。');
    if(step.stepId)stepIds.add(step.stepId);if(key)requestKeys.add(key);
  }
  return id;
}
async function recordedMutationBatch(steps,id){
  const history=historyStore.get(id);
  const replayResults = [];
  let replayCount = 0;
  for (const step of steps) {
    const key = idempotencyKey(id, step.operation, step.fields.clientRequestId);
    if (!key) continue;
    const entry = (history.idempotency || []).find((item) => item.key === key);
    if (entry) {
      if (!idempotencyMatches(entry, step.operation, step.fields)) return { response: idempotencyConflict(id), results: [] };
      replayResults.push(historyStore.readIdempotency(id,entry));
      replayCount += 1;
    }
  }
  if (replayCount > 0) {
    if (replayCount !== steps.length) return { response: withHistoryState({ ok: false, code: "IDEMPOTENCY_PARTIAL", error: "A mutation batch cannot partially replay idempotency keys." }, id), results: [] };
    const last = replayResults.at(-1) || { ok: true };
    const live=await command("document.view",{documentId:id});
    if(!live.ok)return {response:withHistoryState(live,id),results:replayResults};
    return { response: withHistoryState({ ...last, ...live, propertySchema:resolvePropertySchema(propertySchemaStore.list(id),live), batch: { state: "replayed", count: steps.length } }, id), results: replayResults };
  }
  return null;
}
async function executeMutationBatchUnlocked(steps, preparedHistory, receipt, journalEvent) {
  const id=steps[0].fields.documentId||'default';
  const history = preparedHistory || historyStore.repair(id);
  if (history.restoreError) return { response: withHistoryState({ ok: false, code: "HISTORY_RESTORE_FAILED", error: history.restoreError }, id), results: [] };
  const before = await command("document.summary", { documentId: id });
  if (!before.ok) return { response: withHistoryState(before, id), results: [] };
  // A lost response retries an already committed command; replay takes priority
  // over its now-old edit precondition, but a new command must match live state.
  const observedTokens=[...new Set(steps.map(step=>step.fields.baseStateToken).filter(token=>token!==undefined))];
  if(observedTokens.length>1)throw new GatewayRequestError("PROJECT_STATE_CONFLICT","批量命令包含来自不同工程状态的选择。请读取同一工程快照后重新组织命令；未执行任何步骤。");
  const observedToken=observedTokens[0];
  for(const step of steps)checkSelectionPrecondition(step.operation,{...step.fields,...(observedToken!==undefined?{baseStateToken:observedToken}:{})});
  checkStatePrecondition(id, {...steps[0].fields,...(observedToken!==undefined?{baseStateToken:observedToken}:{})});
  const requestedRevision = steps[0].fields.baseRevision;
  if (requestedRevision !== undefined && Number(requestedRevision) !== Number(before.revision)) return {
    response: withHistoryState({ok:false,code:"REVISION_CONFLICT",error:`Batch baseRevision ${requestedRevision} does not match current revision ${before.revision}.`,expectedRevision:Number(requestedRevision),currentRevision:before.revision},id),results:[],
  };
  const batchCheckpoint = historyStore.snapshotPath(id);
  const checkpoint = await command("document.snapshot", { documentId: id, parameters: { path: batchCheckpoint } });
  if (!checkpoint.ok) {
    historyStore.discard(batchCheckpoint);
    return { response: withHistoryState(checkpoint, id), results: [] };
  }
  const results = [];
  const stepResults = new Map();
  const stepObservations = new Map();
  let revision = before.revision;
  let nextPath = null;
  let resultBytes=0;
  let attemptedCount=0;
  try {
    for (const step of steps) {
      const fields = { ...resolveBatchReferences(step.fields, stepResults), baseRevision: revision,...(observedToken!==undefined?{baseStateToken:observedToken}:{}) };
      checkSelectionPrecondition(step.operation,fields);
      if(selectionBindingPaths(step.operation,fields).length){
        const current=await command("document.summary",{documentId:id});
        if(!current.ok)throw new GatewayRequestError(current.code || "BATCH_OBSERVATION_FAILED",current.error || "Cannot inspect batch selection state.");
        validateBatchSelectionProvenance(step.operation,step.fields,fields,before,stepObservations,current);
      }
      attemptedCount=results.length+1;
      const result = isProjectDataOperation(step.operation)?await executeProjectDataOperation(step.operation,fields):await command(step.operation, fields);
      if(result.ok&&step.operation==="document.create")projectDataStore.reset(id);
      results.push(result);
      resultBytes+=Buffer.byteLength(JSON.stringify(result));
      if(resultBytes>maxBatchResultBytes)throw new GatewayRequestError('BATCH_RESULT_TOO_LARGE','批量结果超过传输保留上限，已整体回滚；请拆分批次，未提交任何步骤。');
      if (step.stepId) {
        stepResults.set(step.stepId, result);
        if(result.ok){
          const observed=Array.isArray(result.bodyMetadata) && result.entityIdentities?result:await command("document.summary",{documentId:id});
          if(!observed.ok)throw new GatewayRequestError(observed.code || "BATCH_OBSERVATION_FAILED",observed.error || "Cannot retain batch result observation.");
          stepObservations.set(step.stepId,observed);
        }
      }
      if (!result.ok) {
        await command("document.restore", { documentId: id, parameters: { path: batchCheckpoint } });
        historyStore.discard(batchCheckpoint);
        return { response: withHistoryState({ ...result, code: "BATCH_ROLLED_BACK",causeCode:result.code || null,revision:before.revision, batch: { state: "rolled-back", failedOperation: step.operation } }, id), results };
      }
      revision = result.revision ?? revision;
    }
    modelingTasks.beginCommit();
    nextPath = historyStore.snapshotPath(id);
    const saved = await command("document.snapshot", { documentId: id, parameters: { path: nextPath } });
    if (!saved.ok) throw new Error("The batch completed but its durable checkpoint could not be saved.");
    const events = steps.map((step, index) => transactionEvent(step.operation, step.fields, index === 0 ? before.revision : results[index - 1]?.revision, results[index]?.revision));
    const newOutcomes=steps.map((step,index)=>({key:idempotencyKey(id,step.operation,step.fields.clientRequestId),fingerprint:idempotencyFingerprint(step.operation,step.fields),response:results[index],recordedAt:new Date().toISOString()})).filter(entry=>entry.key).map(entry=>historyStore.outcomes.storeEntry(id,entry));
    const nextHistory = {
      current: nextPath,
      undo: startsNewDocument(steps[0].operation, steps[0].fields) || !history.current ? [] : appendHistory(history.undo, history.current),
      redo: [],
      restoreError: null,
      events: [...(history.events || []), ...(journalEvent ? [transactionEvent('project.batch', journalEvent, before.revision, revision, journalEvent.eventId)] : []), ...events],
      idempotency: [...(history.idempotency || []), ...newOutcomes].slice(-historyStore.idempotencyLimit),
    };
    const view = await command("document.view", { documentId: id });
    if(receipt&&!view.ok)throw new GatewayRequestError(view.code||'BATCH_VIEW_FAILED',view.error||'无法形成完整批次提交回执，未提交。');
    const last = results.at(-1) || { ok: true, revision };
    const response = withHistoryState(view.ok ? { ...last, ...view,propertySchema:resolvePropertySchema(propertySchemaStore.list(id),view), batch: { state: "committed", count: steps.length } } : { ...last, batch: { state: "committed", count: steps.length } }, id,historyStore.prepareCommit(id,nextHistory));
    // Reserve 4 KiB for the task/status HTTP envelope as well as the receipt.
    if(receipt){const aggregate={...response,batchId:receipt.batchId,results};if(Buffer.byteLength(JSON.stringify(aggregate))+4096>maxBatchResultBytes)throw new GatewayRequestError('BATCH_RESULT_TOO_LARGE','整批完整回执超过保留上限，未提交。');newOutcomes.push(historyStore.outcomes.storeEntry(id,{key:idempotencyKey(id,'project.batch',receipt.batchId),fingerprint:receipt.fingerprint,response:aggregate,recordedAt:new Date().toISOString()}));}
    if(newOutcomes.length>historyStore.idempotencyLimit||newOutcomes.reduce((sum,entry)=>sum+entry.responseRef.bytes,0)>historyStore.idempotencyBytes)throw new GatewayRequestError('BATCH_RESULT_TOO_LARGE','整批命令结果超过去重保留窗口，已回滚；请拆分为较小批次，未提交部分结果。');
    nextHistory.idempotency=[...(history.idempotency||[]),...newOutcomes].slice(-historyStore.idempotencyLimit);
    historyStore.commit(id, nextHistory);
    historyStore.discard(batchCheckpoint);
    return { response, results };
  } catch (error) {
    if(error.code==='WORKER_CANCELLED'){error.batchAttemptedCount=attemptedCount;error.batchProvisional=results;throw error;}
    if (nextPath) historyStore.discard(nextPath);
    try { await command("document.restore", { documentId: id, parameters: { path: batchCheckpoint } }); } catch { /* preserve original failure */ }
    historyStore.discard(batchCheckpoint);
    return { response: withHistoryState({ ok: false, code: "BATCH_ROLLED_BACK",causeCode:error.code || "BATCH_FAILED",fieldPath:error.fieldPath || null,revision:before.revision, error: error instanceof Error ? error.message : String(error), batch: { state: "rolled-back" } }, id), results };
  }
}

function resolveBatchReferences(value, stepResults) {
  if (Array.isArray(value)) return value.map((item) => resolveBatchReferences(item, stepResults));
  if (!value || typeof value !== "object") return value;
  if (typeof value.$ref === "string") {
    const [stepId, ...fields] = value.$ref.split(".");
    const result = stepResults.get(stepId);
    if (!result) throw new Error(`Batch reference ${value.$ref} is not available yet.`);
    if(!fields.length||fields.length>8||fields.some(field=>![...field].length||["__proto__","prototype","constructor"].includes(field)))throw new Error(`Batch reference ${value.$ref} has an invalid field path.`);
    let resolved=result;
    for(const field of fields){const key=field==="body_id"?"bodyId":field==="feature_id"?"featureId":field;resolved=resolved&&typeof resolved==="object"&&Object.hasOwn(resolved,key)?resolved[key]:undefined;}
    if (resolved === undefined || resolved === null) throw new Error(`Batch reference ${value.$ref} is missing.`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveBatchReferences(item, stepResults)]));
}

function replaceBatchReferencesForValidation(value) {
  if (Array.isArray(value)) return value.map(replaceBatchReferencesForValidation);
  if (!value || typeof value !== "object") return value;
  if (typeof value.$ref === "string") return "__batch_reference__";
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceBatchReferencesForValidation(item)]));
}

function executeMutationBatch(steps, task, batchId, requestId = batchId || randomUUID(), beforeExecute) {
  const id = steps[0]?.fields?.documentId || "default";
  const startedAt = Date.now();
  const journalEvent = task ? null : {requestId,eventId:`event-${randomUUID()}`};
  const execute=()=>serializeDocument(id, async () => {
    beforeExecute?.();
    validateMutationBatch(steps);
    const receipt=task?{batchId,fingerprint:idempotencyFingerprint('project.batch',batchReceiptFields(batchId,steps))}:null;
    if(receipt){const entry=historyStore.get(id).idempotency.find(item=>item.key===idempotencyKey(id,'project.batch',batchId));if(entry){if(entry.fingerprint!==receipt.fingerprint)return {response:idempotencyConflict(id),results:[]};const exact=historyStore.readIdempotency(id,entry);const {results,...response}=exact;return {response,results};}}
    const replay=await recordedMutationBatch(steps,id);
    if(receipt&&replay?.response?.ok)throw new ModelingTaskError('MODELING_TASK_BATCH_RECEIPT_MISSING','此批次仅保留旧版分步回执，无法证明原始整批结果；请读取工程，不要重新执行。');
    if(!replay)for(const step of steps)assertCapabilityPrecondition(step.fields.workerCapabilityPrecondition,nativeCapabilities());
    const result = replay || await projectTransactions.run(id,history=>executeMutationBatchUnlocked(steps,history,receipt,journalEvent),{success:value=>value.response?.ok});
    if(!result.response?.ok)result.results=failedBatchResults(steps,result.results || [],result.response);
    steps.forEach((step, index) => logCommand(step.operation, step.fields, result.results[index] || result.response, startedAt));
    return result;
  },{inputBytes:Buffer.byteLength(JSON.stringify(steps)),task}).catch(error=>{
    const notStarted=['DOCUMENT_ACTION_INPUT_LIMIT','DOCUMENT_ACTION_QUEUE_LIMIT','DOCUMENT_ACTION_QUEUE_TIMEOUT','DOCUMENT_ACTION_CANCELLED','SERVICE_STOPPING'].includes(error.code),restored=error.projectRollback?.confirmed===true&&error.projectRollback.documentId===id;
    if(restored||notStarted){const provisional=error.batchProvisional||[],attempted=error.batchAttemptedCount||0;error.batchOutcome={batch:{state:restored?'rolled-back':'not-started',count:steps.length},results:failedBatchResults(steps,steps.map((_,index)=>provisional[index]||(index<attempted?{ok:false,code:error.code,error:error.message}:undefined)),{code:error.code,error:error.message})};}
    delete error.batchProvisional;delete error.batchAttemptedCount;throw error;
  });
  return task ? modelingTasks.finish(task, execute(), result => result.response)
    : commandJournal.track({documentId:id, operation:'project.batch', requestId, startedAt, eventId:journalEvent.eventId}, execute, result => result.response);
}
async function executePreviewUnlocked(operation, fields) {
  assertCapabilityPrecondition(fields.workerCapabilityPrecondition,nativeCapabilities());
  if (["step.import", "document.restore", "document.snapshot"].includes(operation)||isProjectDataOperation(operation)) {
    return withHistoryState({ ok: false, protocolVersion: 1, code: "PREVIEW_UNSUPPORTED", error: "This operation does not support preview." }, fields.documentId || "default");
  }
  const id = fields.documentId || "default";
  checkSelectionPrecondition(operation,fields);
  checkStatePrecondition(id,fields);
  const before = await command("document.summary", { documentId: id });
  const checkpointPath = historyStore.snapshotPath(id);
  const saved = await command("document.snapshot", { documentId: id, parameters: { path: checkpointPath } });
  if (!saved.ok) {
    historyStore.discard(checkpointPath);
    return withHistoryState(saved, id);
  }
  let result;
  let failure = null;
  try {
    result = await command(operation, fields);
    if(result.ok && Number(result.bodyCount)>1){const view=await command("document.view",{documentId:id});if(!view.ok)throw new GatewayRequestError(view.code||"PREVIEW_VIEW_FAILED",view.error||"Could not inspect the proposed result.");result={...result,...view};}
  }
  catch (error) { failure = error; }
  const restored = await command("document.restore", { documentId: id, parameters: { path: checkpointPath } });
  historyStore.discard(checkpointPath);
  if (failure) throw failure;
  if (!restored.ok) return withHistoryState({ ok: false, protocolVersion: 1, code: "PREVIEW_RESTORE_FAILED", error: restored.error || "Preview could not restore the model." }, id);
  if (!result.ok) return withHistoryState({ ...result, preview: { state: "preview", baseRevision: before.revision } }, id);
  const response = { ...result, revision: before.revision, preview: { state: "preview", baseRevision: before.revision, resultRevision: result.revision }, transaction: { state: "preview", beforeRevision: before.revision, afterRevision: before.revision } };
  return withHistoryState(response, id);
}

function executePreview(operation, fields) {
  const id = fields.documentId || "default";
  const startedAt = Date.now();
  return serializeDocument(id, async () => {
    try {
      const result = await executePreviewUnlocked(operation, fields);
      logCommand(operation, { ...fields, requestId: fields.requestId || fields.clientRequestId }, result, startedAt);
      return result;
    } catch (error) {
      logCommand(operation, { ...fields, requestId: fields.requestId || fields.clientRequestId }, null, startedAt, error);
      throw error;
    }
  },{inputBytes:Buffer.byteLength(JSON.stringify(fields))});
}

function serializeDocument(id, action, {loadDocument=true,inputBytes=0,task,signal}={}) {
  if(shuttingDown)return Promise.reject(new GatewayRequestError('SERVICE_STOPPING','后台正在停止，未接收新的工程操作。'));
  const ownedAction=async()=>{
    if(shuttingDown)throw new GatewayRequestError('SERVICE_STOPPING','该操作尚未开始，已随后台停机取消排队。');
    runningDocuments.add(id);
    const execute=async()=>{if(loadDocument){projectFiles.assertModelAccess(id);sourceRestores.assertModelAccess();if(!worker)startWorker();await documentLoader.ensure(id);}return action();};
    try{return await (loadDocument?sourceAccessGate.read(execute):execute());}finally{runningDocuments.delete(id);}
  };
  return documentActions.run(id,()=>task?modelingTasks.runAction(task,ownedAction):ownedAction(),{inputBytes,signal:task?.controller.signal||signal});
}

function executeMutation(operation, fields, onPhase, task, {finishTask=true,beforeExecute}={}) {
  const id = fields.documentId || "default";
  const startedAt = Date.now();
  if (!fields.requestId && !fields.clientRequestId) fields = {...fields, requestId: randomUUID()};
  const execute=()=>serializeDocument(id, async () => {
    try {
      onPhase?.('preparing');
      await beforeExecute?.();
      const replay=recordedMutation(id,operation,fields);
      if(!replay && operation==="document.naming.upgrade")assertImportedNamingUpgrade(nativeCapabilities());
      if(!replay)assertCapabilityPrecondition(fields.workerCapabilityPrecondition,nativeCapabilities());
      const result = replay?replay.response:await projectTransactions.run(id,history=>executeMutationUnlocked(operation, fields,history,onPhase));
      logCommand(operation, fields, result, startedAt);
      return result;
    } catch (error) {
      logCommand(operation, fields, null, startedAt, error);
      throw error;
    }
  },{inputBytes:Buffer.byteLength(JSON.stringify(fields)),task});
  if (task) return finishTask ? modelingTasks.finish(task, execute()) : execute();
  const receiptKey = idempotencyKey(id, operation, fields.clientRequestId);
  return commandJournal.track({documentId:id, operation, requestId:fields.requestId || fields.clientRequestId, startedAt, receiptKey,
    fingerprint:receiptKey ? idempotencyFingerprint(operation, fields) : undefined}, execute);
}

async function moveHistoryUnlocked(id, direction, clientRequestId = "", preparedHistory, requestId) {
  const history = preparedHistory || historyStore.repair(id);
  if (history.restoreError) {
    return withHistoryState({
      ok: false,
      protocolVersion: 1,
      code: "HISTORY_RESTORE_FAILED",
      error: history.restoreError,
    }, id);
  }
  const source = direction === "undo" ? history.undo : history.redo;
  if (source.length === 0) {
    return withHistoryState({ ok: false, protocolVersion: 1,
      code: direction === "undo" ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO",
      error: direction === "undo" ? "There is no operation to undo." : "There is no operation to redo." }, id);
  }
  if (!history.current) return historyError(id, new Error("History has no current checkpoint."));
  const before = await command("document.summary", { documentId: id });

  const restorePath = source[source.length - 1];
  const restoredSchema=historyStore.readProjectData(id,restorePath);
  const restored = await command("document.restore", {
    documentId: id,
    parameters: { path: restorePath },
  });
  if (!restored.ok) return withHistoryState(restored, id);
  if(restoredSchema)projectDataStore.replaceSnapshot(id,restoredSchema,{preserveUpdatedAt:true});

  const view = await command("document.view", { documentId: id });
  const event = transactionEvent(`document.${direction}`, { clientRequestId, requestId }, before.revision, view.revision);
  event.propertyState=restoredSchema?"restored":"legacy-preserved";
  const nextHistory = {...history,...(direction === "undo"
    ? {
        current: restorePath,
        undo: history.undo.slice(0, -1),
        redo: appendHistory(history.redo, history.current),
        restoreError: null,
        events: [...(history.events || []), event],
      }
    : {
        current: restorePath,
        undo: appendHistory(history.undo, history.current),
        redo: history.redo.slice(0, -1),
        restoreError: null,
        events: [...(history.events || []), event],
      })};
  const response=withHistoryState({...view,propertySchema:resolvePropertySchema(propertySchemaStore.list(id),view),meshStrategies:meshStrategyStore.list(id),...(!restoredSchema?{warnings:[...(view.warnings||[]),"此旧历史不含属性检查点及网格方案数据：已仅恢复几何并保留当前属性和网格方案，无法还原当时的数据修改。"],legacyPropertyHistory:true}:{})},id,historyStore.prepareCommit(id,nextHistory));
  const cacheKey=idempotencyKey(id,`document.${direction}`,clientRequestId);
  if(cacheKey)nextHistory.idempotency=[...(history.idempotency||[]),{key:cacheKey,fingerprint:idempotencyFingerprint(`document.${direction}`,{documentId:id,clientRequestId}),response,recordedAt:new Date().toISOString()}];
  try {
    modelingTasks.beginCommit();
    historyStore.commit(id, nextHistory);
  } catch (error) {
    await command("document.restore", {
      documentId: id,
      parameters: { path: history.current },
    });
    return historyError(id, error);
  }
  return response;
}

function moveHistory(id, direction, clientRequestId = "", precondition = {}, task) {
  const operation = `document.${direction}`;
  const cacheKey = idempotencyKey(id, operation, clientRequestId);
  const fingerprint = idempotencyFingerprint(operation, { documentId: id, clientRequestId });
  const startedAt = Date.now();
  const requestId = precondition.requestId || clientRequestId || randomUUID();
  const execute=()=>serializeDocument(id, async () => {
    const history = historyStore.get(id);
    const persisted = cacheKey ? (history.idempotency || []).find((entry) => entry.key === cacheKey) : null;
    if (persisted) {
      if (persisted.fingerprint !== fingerprint) return idempotencyConflict(id);
      return historyStore.readIdempotency(id,persisted);
    }
    let result;
    try {
      checkStatePrecondition(id,precondition);
      result = await projectTransactions.run(id,history=>moveHistoryUnlocked(id, direction, clientRequestId,history,requestId));
      logCommand(operation, { documentId: id, clientRequestId }, result, startedAt);
    } catch (error) {
      logCommand(operation, { documentId: id, clientRequestId }, null, startedAt, error);
      throw error;
    }
    return result;
  },{inputBytes:Buffer.byteLength(JSON.stringify(precondition)),task});
  return task ? modelingTasks.finish(task, execute()) : commandJournal.track({documentId:id, operation,
    requestId, startedAt, receiptKey:cacheKey, fingerprint}, execute);
}


startup.catalogMs=performance.now()-startupClock;
const recoveryStarted=performance.now();
await sourceRestores.initialize();
projectFiles.recover();
projectTransactions.recover();
projectMeshAssets.start();
startup.recoveryMs=performance.now()-recoveryStarted;
process.stdout.write(JSON.stringify({type:'cad.startup',phase:'catalog-ready',mode:startup.mode,knownDocuments:historyStore.documentIds().length,catalogMs:startup.catalogMs,recoveryMs:startup.recoveryMs})+'\n');
startWorker();

const server = createServer(async (request, response) => {
  activeResponses.add(response);const forget=()=>activeResponses.delete(response);response.once('close',forget);response.once('finish',forget);
  response._cadCorsOrigin = resolveCorsOrigin(String(request.headers.origin || ""), webOrigin);
  let requestTraceId = String(request.headers["x-request-id"] || "");
  let requestDocumentId = null;
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(response._cadCorsOrigin || webOrigin));
    response.end();
    return;
  }

  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if(url.pathname==='/api/runtime/shutdown'&&request.method==='POST'){
      if(!shutdownControl.authorized(request)){sendJson(response,403,{ok:false,code:'SHUTDOWN_FORBIDDEN',error:'此操作只允许持有当前本机控制凭据的启动器调用。'});return;}
      void shutdown('local-control');sendJson(response,202,{ok:true,state:'draining',budgetMs:shutdownBudgetMs});return;
    }
    if(shuttingDown){response.setHeader('Connection','close');sendJson(response,503,{ok:false,code:'SERVICE_STOPPING',error:'后台正在停止，未接收新请求；请在恢复后核对工程。'});return;}
    if(await handleModelingTaskRoute({request,response,url,service:modelingTasks,readJson,prepareCommand:prepareTaskCommand,beforeReserve:reservePiWrite,sendJson,webOrigin,port}))return;
    const commandJournalMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/command-journal$/);
    if (commandJournalMatch) {
      authorizeModelingTaskRequest(request,webOrigin,port);
      const id=commandJournalMatch[1], requestId=url.searchParams.get('requestId');
      requestDocumentId=id;
      if (!(request.method === 'GET' || request.method === 'DELETE')) throw new ModelingTaskError('COMMAND_JOURNAL_METHOD','命令日志支持读取和清理已完成记录。',405);
      if ([...url.searchParams].length > (request.method === 'GET' && requestId ? 1 : 0) || (requestId && Buffer.byteLength(requestId) > 512))
        throw new ModelingTaskError('COMMAND_JOURNAL_ARGUMENTS','命令日志的请求 ID 无效。',400);
      response.setHeader('Cache-Control','no-store');
      try {
        const removed = request.method === 'DELETE' ? commandJournal.clearCompleted(id) : undefined;
        sendJson(response,200,{ok:true,documentId:id,entries:commandJournal.list(id,requestId),removed});
      } catch {
        throw new ModelingTaskError('COMMAND_JOURNAL_UNAVAILABLE','工程命令日志暂时无法读取或保存。',503);
      }
      return;
    }
    if(await handleSourceRestoreRoute({request,response,url,service:sourceRestores,webOrigin,port,sendJson}))return;
    if(url.pathname==='/api/source-catalog'&&['GET','POST','DELETE'].includes(request.method)){
      const id='@storage',audit=request.method==='POST'?storageSourceAudits.start(id):request.method==='DELETE'?storageSourceAudits.cancel(id):storageSourceAudits.get(id);sendJson(response,request.method==='POST'?202:200,{ok:true,documentId:id,audit});return;
    }
    const sourceAuditMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/source-audit$/);
    if(sourceAuditMatch&&['GET','POST','DELETE'].includes(request.method)){
      const id=sourceAuditMatch[1];if(!workspaces.known(id))throw new GatewayRequestError('WORKSPACE_NOT_FOUND','当前工程不存在。');
      const audit=request.method==='POST'?sourceAudits.start(id):request.method==='DELETE'?sourceAudits.cancel(id):sourceAudits.get(id);sendJson(response,request.method==='POST'?202:200,{ok:true,documentId:id,audit});return;
    }
    const stepStatusMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/imports\/step\/status$/);
    if(stepStatusMatch&&request.method==='GET'){
      const id=stepStatusMatch[1],requestId=url.searchParams.get('requestId');
      const status=requestId?stepImports.get(id,requestId):stepImports.latest(id);
      sendJson(response,200,{ok:true,documentId:id,stepImportStatus:status});return;
    }
    const loadStatusMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/load-status$/);
    if(loadStatusMatch&&request.method==='GET'){
      const id=loadStatusMatch[1];if(!workspaces.known(id)&&!documentLoader.records.has(id))throw new GatewayRequestError('WORKSPACE_NOT_FOUND','该工程尚不存在。');
      sendJson(response,200,{ok:true,documentId:id,load:documentLoader.status(id),workerReady:geometryReady()});return;
    }
    if(url.pathname==="/api/projects" && request.method==="GET"){sendJson(response,200,{ok:true,projects:workspaces.list(url.searchParams.get("q") || "")});return;}
    const workspaceMatch=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9_-]{1,64})(?:\/(activate|view))?$/);
    if(workspaceMatch){
      const id=workspaceMatch[1];
      if(workspaceMatch[2]==='view'){
        authorizeModelingTaskRequest(request,webOrigin,port);requestDocumentId=id;
        let read;try{if(request.method!=='GET'||[...url.searchParams].length)throw Error();read=normalizeWorkspaceRead({protocolVersion:1,operation:'project.read',documentId:id,requestId:request.headers['x-request-id']});}catch{throw new GatewayRequestError('WORKSPACE_READ_ARGUMENTS','工程读取只支持携带唯一请求号、无查询参数的 GET。');}
        const view=await serializeDocument(id,()=>sourceAccessGate.read(async()=>{
          // Unlike activation, this does not stop, start, guard or rebind Pi.
          const project=workspaces.get(id);if(!project.recoverable)throw new GatewayRequestError('WORKSPACE_UNAVAILABLE','此工程的恢复快照不可用，请打开备份工程包。');
          const result=await command('document.view',{documentId:id});
          return result.ok?withHistoryState({...result,project:workspaces.get(id),workspaceRead:read},id):result;
        }),{loadDocument:false});
        response.setHeader('Cache-Control','no-store');sendJson(response,statusFor(view),view);return;
      }
      if(request.method==="GET" && !workspaceMatch[2]){sendJson(response,200,{ok:true,project:workspaces.get(id)});return;}
      if(request.method==="POST" && !workspaceMatch[2]){const input=await readJson(request);const project=await serializeDocument(id,()=>workspaces.rename(id,input.name));sendJson(response,200,{ok:true,project});return;}
      if(request.method==="POST" && workspaceMatch[2]==="activate"){
        authorizeModelingTaskRequest(request,webOrigin,port);
        requestDocumentId=id;if([...url.searchParams].length)throw new GatewayRequestError('WORKSPACE_ACTIVATION_ARGUMENTS','工程切换不接受查询参数。');
        const body=await readJson(request);let activation;
        if(!body||Array.isArray(body)||typeof body!=='object')throw new GatewayRequestError('WORKSPACE_ACTIVATION_ARGUMENTS','工程切换输入无效。');
        if(Object.keys(body).length){try{if(Object.keys(body).length!==1||!Object.hasOwn(body,'command'))throw Error();activation=normalizeWorkspaceActivation(body.command);if(activation.documentId!==id||request.headers['x-request-id']!==activation.requestId)throw Error();}catch{throw new GatewayRequestError('WORKSPACE_ACTIVATION_ARGUMENTS','工程切换需要匹配接口和请求号的唯一 command。');}}
        const ids=activation?[activation.sourceDocumentId,id]:[id];
        const view=await piRuntime.withDocumentsQuiescent(ids,()=>serializeDocument(id,()=>sourceAccessGate.read(async()=>{
          if(activation)await checkWorkspaceSource(activation);
          const project=workspaces.get(id);if(!project.recoverable)throw new GatewayRequestError('WORKSPACE_UNAVAILABLE','此工程的恢复快照不可用，请打开备份工程包。');
          const result=await command('document.view',{documentId:id});
          return result.ok?withHistoryState({...result,project:workspaces.touch(id),...(activation?{workspaceActivation:activation}:{})},id):result;
        }),{loadDocument:false,inputBytes:activation?Buffer.byteLength(JSON.stringify(activation)):0}));sendJson(response,statusFor(view),view);return;
      }
    }
    const piActivityMatch=url.pathname.match(/^\/api\/pi\/documents\/([A-Za-z0-9_-]{1,64})\/activity$/);
    if(piActivityMatch){
      authorizeModelingTaskRequest(request,webOrigin,port);
      if(request.method!=='GET'||[...url.searchParams].length)throw new GatewayRequestError('PI_DOCUMENT_ACTIVITY_ARGUMENTS','Pi 工程状态只支持无查询参数的只读 GET。');
      const id=piActivityMatch[1];requestDocumentId=id;
      sendJson(response,200,{ok:true,protocolVersion:1,documentId:id,activity:await piRuntime.documentActivity(id)});return;
    }
    const piOwnershipMatch=url.pathname.match(/^\/api\/pi\/session-ownership\/([A-Za-z0-9_-]{1,80})$/);
    if(piOwnershipMatch){
      authorizeModelingTaskRequest(request,webOrigin,port);const sessionId=piOwnershipMatch[1];
      if(request.method==='GET'){
        if([...url.searchParams.keys()].some(key=>!['documentId','preview'].includes(key))||url.searchParams.getAll('documentId').length!==1||url.searchParams.has('preview')&&(url.searchParams.getAll('preview').length!==1||url.searchParams.get('preview')!=='1'))throw new GatewayRequestError('INVALID_ARGUMENT','Pi 归属核对需要唯一 documentId 和可选 preview=1，不接受额外参数。');
        const id=documentId(url.searchParams.get('documentId'));requestDocumentId=id;sendJson(response,200,{ok:true,version:1,ownership:await piRuntime.ownership(sessionId,id,undefined,{preview:url.searchParams.get('preview')==='1'})});return;
      }
      if(request.method==='POST'){
        if([...url.searchParams].length)throw new GatewayRequestError('INVALID_ARGUMENT','Pi 归属确认不接受查询参数。');const input=await readJson(request);
        if(!input||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'documentId')||!Object.hasOwn(input,'historyDigest'))throw new GatewayRequestError('INVALID_ARGUMENT','Pi 归属确认只接受工程 ID 和原历史摘要。');
        const id=documentId(input.documentId);requestDocumentId=id;sendJson(response,200,{ok:true,version:1,ownership:await piRuntime.ownership(sessionId,id,input.historyDigest)});return;
      }
      throw new GatewayRequestError('INVALID_ARGUMENT','Pi 归属接口方法不受支持。');
    }
    if (url.pathname === "/api/pi/sessions" && request.method === "POST") {
      const input = await readJson(request);
      const id = documentId(input.documentId || "default");
      const sessionId = normalizePiSessionId(input.sessionId);
      piRuntime.assertOwner(sessionId,id);
      const config = preparePiSessionConfig(sessionId,id);
      const session = await piRuntime.create({ sessionId, documentId: id, mode: "edit", ...config });
      let stateResponse=await session.request({type:'get_state'}),state=stateResponse.data;
      const provider = selectAgentProvider(input.providerId);
      if ((!state.model || state.model.provider === "unknown") && provider?.model) {
        await session.request({ type: "set_model", provider: provider.id, modelId: provider.model });
        stateResponse=await session.request({type:'get_state'});state=stateResponse.data;
      }
      if(stateResponse.transport.streamId!==session.streamId)throw new GatewayRequestError('PI_STREAM_CHANGED','Pi 进程已变化，请重新连接会话。');
      sendJson(response, 200, { ok: true, protocolVersion: 2, sessionId: session.sessionId, documentId: id, streamId:session.streamId,eventCursor:stateResponse.transport.eventCursor, state });
      return;
    }
    const piApprovalMatch = url.pathname.match(/^\/api\/pi\/sessions\/([A-Za-z0-9_-]{1,80})\/write-approval$/);
    if (piApprovalMatch) {
      authorizeModelingTaskRequest(request,webOrigin,port);
      const session = piRuntime.get(piApprovalMatch[1]);
      const id = url.searchParams.get('documentId'), streamId = url.searchParams.get('streamId');
      if ([...url.searchParams].length !== 2 || !isLivePi(session) || session.documentId !== id || session.streamId !== streamId)
        throw new ModelingTaskError('PI_APPROVAL_INACTIVE','确认会话已变化，请重新连接。');
      requestDocumentId = id;
      response.setHeader('Cache-Control','no-store');
      let approval;
      if (request.method === 'GET') approval = piWriteApprovals.get(session);
      else if (request.method === 'POST') {
        const input = await readJson(request);
        if (!input || Array.isArray(input) || Object.keys(input).length !== 2 || typeof input.id !== 'string'
            || !['approve','cancel'].includes(input.decision))
          throw new ModelingTaskError('PI_APPROVAL_ARGUMENTS','确认只接受原确认 ID 和决定。',400);
        approval = piWriteApprovals.decide(session,input.id,input.decision);
      } else throw new ModelingTaskError('PI_APPROVAL_METHOD','此接口只支持读取和提交确认决定。',405);
      sendJson(response,200,{ok:true,documentId:id,streamId,approval});
      return;
    }
    const piSessionMatch = url.pathname.match(/^\/api\/pi\/sessions\/([A-Za-z0-9_-]{1,80})(?:\/(commands|events))?$/);
    if (piSessionMatch) {
      const session = piRuntime.get(piSessionMatch[1]);
      if (request.method === "DELETE" && !piSessionMatch[2]) {
        if (session) piWriteApprovals.revoke(session);
        await piRuntime.remove(piSessionMatch[1]);
        sendJson(response, 200, { ok: true, protocolVersion: 1, sessionId: piSessionMatch[1] });
        return;
      }
      if (!session) throw new GatewayRequestError("PI_SESSION_NOT_FOUND", "Pi RPC session is not running.");
      if (request.method === "POST" && !piSessionMatch[2]) {
        const input = await readJson(request);
        const id = documentId(input.documentId || session.documentId);
        piRuntime.assertOwner(session.sessionId,id);
        const active = await piRuntime.create({ sessionId: session.sessionId, documentId: id, mode: input.mode || session.mode, ...preparePiSessionConfig(session.sessionId,id) });
        const state = await active.request({ type: "get_state" });
        sendJson(response, 200, { ok: true, protocolVersion: 2, sessionId: active.sessionId, documentId: active.documentId,streamId:state.transport.streamId,eventCursor:state.transport.eventCursor, mode: active.mode, state: state.data });
        return;
      }
      if (request.method === "POST" && piSessionMatch[2] === "commands") {
        const input = await readJson(request);
        if(input.streamId!==undefined&&input.streamId!==session.streamId)throw new GatewayRequestError('PI_STREAM_CHANGED','Pi 事件流已变化，未执行旧连接的命令；请重新同步会话。');
        if(input.documentId!==undefined&&input.documentId!==session.documentId)throw new GatewayRequestError('PI_SESSION_DOCUMENT_MISMATCH','Pi 会话不属于当前工程，命令未执行。');
        const commandInput = input.command && typeof input.command === "object" ? input.command : input;
        if (commandInput.type === 'abort' || commandInput.type === 'new_session') piWriteApprovals.revoke(session);
        const result = await session.request(commandInput);
        const {transport,...nativeResponse}=result;
        sendJson(response, 200, { ok: true, protocolVersion: 2, sessionId: session.sessionId,documentId:session.documentId,streamId:transport.streamId,eventCursorBefore:transport.eventCursorBefore,eventCursor:transport.eventCursor, response: nativeResponse });
        return;
      }
      if (request.method === "GET" && piSessionMatch[2] === "events") {
        if(url.searchParams.has('documentId')&&url.searchParams.get('documentId')!==session.documentId)throw new GatewayRequestError('PI_SESSION_DOCUMENT_MISMATCH','Pi 事件流不属于当前工程。');
        if(!session.child||session.closed)throw new GatewayRequestError('PI_SESSION_NOT_RUNNING','Pi 进程未运行，请重新连接已有会话。');
        const origin = response._cadCorsOrigin || webOrigin;
        attachPiEventStream(session,request,response,url,{origin:corsHeaders(origin)});
        return;
      }
    }
    if (url.pathname === "/api/agent/runs" && request.method === "GET") {
      const id = documentId(url.searchParams.get("documentId") || "default");
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, runs: agentRuns.list(id) });
      return;
    }
    const runMatch = url.pathname.match(/^\/api\/agent\/runs\/([A-Za-z0-9._:-]{1,160})$/);
    if (runMatch && request.method === "GET") {
      const run = agentRuns.get(runMatch[1]);
      if (!run) throw new GatewayRequestError("RUN_NOT_FOUND", "Agent run does not exist.");
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, run });
      return;
    }
    if (url.pathname === "/api/agent/conversations" && request.method === "GET") {
      const id = documentId(url.searchParams.get("documentId") || "default");
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, conversations: agentConversations.list(id) });
      return;
    }
    if (url.pathname === "/api/agent/conversations" && request.method === "POST") {
      const input = await readJson(request);
      const id = documentId(input.documentId || "default");
      const conversation = agentConversations.create(id, input.title);
      sendJson(response, 201, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, conversation });
      return;
    }
    const conversationMatch = url.pathname.match(/^\/api\/agent\/conversations\/([A-Za-z0-9_-]{1,80})(?:\/messages)?$/);
    if (conversationMatch && request.method === "DELETE") {
      const id = documentId(url.searchParams.get("documentId") || "default");
      agentConversations.remove(conversationMatch[1], id);
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, conversationId: conversationMatch[1] });
      return;
    }
    if (conversationMatch && request.method === "GET" && !url.pathname.endsWith("/messages")) {
      const id = documentId(url.searchParams.get("documentId") || "default");
      const conversation = agentConversations.get(conversationMatch[1], id);
      if (!conversation) throw new GatewayRequestError("CONVERSATION_NOT_FOUND", "Agent conversation does not exist.");
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, conversation });
      return;
    }
    if (conversationMatch && request.method === "POST" && url.pathname.endsWith("/messages")) {
      const input = await readJson(request);
      const id = documentId(input.documentId || "default");
      const conversation = agentConversations.append(conversationMatch[1], id, input.message || input);
      sendJson(response, 201, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, conversation });
      return;
    }
    const conversationStateMatch = url.pathname.match(/^\/api\/agent\/conversations\/([A-Za-z0-9_-]{1,80})\/state$/);
    if (conversationStateMatch && request.method === "POST") {
      const input = await readJson(request);
      const id = documentId(input.documentId || "default");
      const conversation = agentConversations.updateState(conversationStateMatch[1], id, { activePlan: input.activePlan, pendingPrompt: input.pendingPrompt, pendingToolCall: input.pendingToolCall });
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, conversation });
      return;
    }
    const conversationCompactMatch = url.pathname.match(/^\/api\/agent\/conversations\/([A-Za-z0-9_-]{1,80})\/compact$/);
    if (conversationCompactMatch && request.method === "POST") {
      const input = await readJson(request);
      const id = documentId(input.documentId || "default");
      const result = agentConversations.compact(conversationCompactMatch[1], id, input.options || {});
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, conversation: result.conversation, context: result.context });
      return;
    }    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/agent/model/query") {
      const input = request.method === "POST" ? await readJson(request) : {};
      const id = documentId(input.documentId || url.searchParams.get("documentId") || "default");
      const query = { kind: input.kind || url.searchParams.get("kind") || "geometry-tree", bodyId: input.bodyId || url.searchParams.get("bodyId") || "", featureId: input.featureId || url.searchParams.get("featureId") || "" };
      const result=await serializeDocument(id,async()=>{const view=await command("document.view",{documentId:id});if(!view.ok)throw new GatewayRequestError(view.code||"MODEL_QUERY_FAILED",view.error||"Could not query the CAD document.");return {...await summarizeAgentModelWithSpatial(id,view,query,true),stateToken:projectStateToken(id,historyFor(id))};});
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, query:result });
      return;
    }    if (request.method === "GET" && url.pathname === "/api/agent/resources") {
      const resources = agentResources.list();
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, resources, directories: resourceDirectories() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/resources/reload") {
      const resources = agentResources.list();
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, resources });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/agent/audit") {
      const id = documentId(url.searchParams.get("documentId") || "default");
      const events = agentAudit.list({ documentId: id, conversationId: url.searchParams.get("conversationId") || undefined, limit: url.searchParams.get("limit") || 100 });
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, events });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/agent/metrics") {
      const id = documentId(url.searchParams.get("documentId") || "default");
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, metrics: agentMetrics(id) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/agent/providers") {
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, providers: providerStore.list().map((item) => ({ ...item, health: providerHealth.snapshot(item.id) })) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/providers") {
      const input = await readJson(request);
      assertProviderUrl(String(input.baseUrl || ""));
      const provider = providerStore.save(input);
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, provider });
      return;
    }
    const providerMatch = url.pathname.match(/^\/api\/agent\/providers\/([A-Za-z0-9._-]{1,80})(?:\/test)?$/);
    if (providerMatch && request.method === "DELETE") {
      providerStore.remove(providerMatch[1]);
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null });
      return;
    }
    if (providerMatch && request.method === "POST" && url.pathname.endsWith("/test")) {
      const providerId = providerMatch[1];
      const provider = providerStore.get(providerId);
      if (!provider) throw new GatewayRequestError("PROVIDER_NOT_FOUND", "Agent provider does not exist.");
      const result = await withProviderHealth(provider, () => testProvider(provider, { timeoutMs: agentTimeoutMs }));
      const updatedProvider = providerStore.updateCapabilities(providerId, { ...result.capabilities, verified: true });
      sendJson(response, 200, { ...result, protocolVersion: 1, requestId: requestTraceId || null, providerId, provider: updatedProvider });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/agent/run/stream") {
      const input = await readJson(request);
      const prompt = String(input.prompt || "").trim();
      if (!prompt || prompt.length > 8000) throw new GatewayRequestError("INVALID_AGENT_PROMPT", "Agent prompt is required and must be at most 8000 characters.");
      const startedAt = Date.now();
       const provider = selectAgentProvider(input.providerId);
      if (!provider) throw new GatewayRequestError("PROVIDER_NOT_FOUND", "Configure an Agent provider with CAD Tool Calling before running the Agent.");
      const context = await assembleAgentContext(input, input.context);
      const resources = agentResources.promptContext();
      const runId = String(input.runId || requestTraceId || `agent-run-${Date.now()}-${process.pid}`);
      agentRuns.begin({ runId, documentId: input.documentId || "default", conversationId: input.conversationId, providerId: provider.id, model: provider.model, mode: context.mode === "plan" ? "plan" : "edit" });
      response.writeHead(200, { ...corsHeaders(response._cadCorsOrigin || webOrigin), "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "Cache-Control": "no-cache" });
      const sendEvent = (event, data) => { agentRuns.appendEvent(runId, { type: event, data, at: new Date().toISOString() }); response.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); };
      sendEvent("start", { runId, requestId: requestTraceId || null, providerId: provider.id, model: provider.model, mode: context.mode === "plan" ? "plan" : "edit" });
      try {
        const run = await runAgentLoop(provider, { ...input, requestId: requestTraceId || input.requestId }, prompt, context, resources, {
          confirmed: input.confirmed === true,
          onEvent: (event, data) => sendEvent(event, data),
        });
        if (run.plan) sendEvent("plan", { plan: run.plan });
        sendEvent("run", { runId, status: run.status, text: run.text, turns: run.turns, toolCount: run.toolCount || 0, result: run.result || null, questions: run.questions || [], pendingToolCall: run.pendingToolCall || null, executed: run.status === "completed" && Boolean(run.result?.ok) });
        agentRuns.update(runId, { status: run.status, turns: run.turns, toolCount: run.toolCount || 0, result: run.result || null, text: run.text, finishedAt: new Date().toISOString() });
        recordAgentAudit({ type: "agent.run.completed", documentId: input.documentId || "default", conversationId: input.conversationId, requestId: requestTraceId, providerId: provider.id, model: provider.model, protocol: provider.protocol, status: run.status, turns: run.turns, toolCount: run.toolCount || 0, durationMs: Date.now() - startedAt, promptBytes: Buffer.byteLength(prompt, "utf8"), contextBytes: Buffer.byteLength(JSON.stringify(context), "utf8") });
        sendEvent("done", { ok: true });
      } catch (error) {
        agentRuns.update(runId, { status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
        recordAgentAudit({ type: "agent.run.failed", documentId: input.documentId || "default", conversationId: input.conversationId, requestId: requestTraceId, providerId: provider.id, model: provider.model, protocol: provider.protocol, status: "failed", durationMs: Date.now() - startedAt, promptBytes: Buffer.byteLength(prompt, "utf8"), contextBytes: Buffer.byteLength(JSON.stringify(context), "utf8"), errorCode: error?.code || "AGENT_RUN_FAILED", errorClass: error?.name || "Error", retryAfterMs: error?.retryAfterMs, summary: error instanceof Error ? error.message : String(error) });
        sendEvent("error", { code: "AGENT_RUN_FAILED", error: error instanceof Error ? error.message : "Agent run failed." });
      }
      response.end();
      return;
    }    if (request.method === "POST" && url.pathname === "/api/agent/plan/stream") {
      const input = await readJson(request);
      const prompt = String(input.prompt || "").trim();
      if (!prompt || prompt.length > 8000) throw new GatewayRequestError("INVALID_AGENT_PROMPT", "Agent prompt is required and must be at most 8000 characters.");
      const startedAt = Date.now();
      const provider = selectAgentProvider(input.providerId);
      const providerId = provider?.id || "";
      if (!provider) throw new GatewayRequestError("PROVIDER_NOT_FOUND", "Configure an Agent provider before planning.");
      response.writeHead(200, { ...corsHeaders(response._cadCorsOrigin || webOrigin), "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
      const sendEvent = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sendEvent("start", { requestId: requestTraceId || null, providerId, model: provider.model });
      try {
        const context = await assembleAgentContext(input, input.context);
        const resources = agentResources.promptContext();
        const streamedDeltas = [];
        const validated = await generateValidatedAgentPlan(provider, input, prompt, context, resources, { stream: true, onDelta: (delta) => streamedDeltas.push(delta) });
        const { generated, plan, attempts, repaired } = validated;
        if (repaired) sendEvent("status", { message: "已根据校验错误自动修正计划。" });
        if (!repaired) for (const delta of streamedDeltas) sendEvent("delta", { delta });
        recordAgentAudit({ type: "agent.plan.generated", documentId: input.documentId || "default", conversationId: input.conversationId, requestId: requestTraceId, providerId, model: provider.model, planId: plan.planId, status: plan.status, durationMs: Date.now() - startedAt, attempts, summary: reportAgentPlan(plan).summary });
        sendEvent("plan", { protocol: generated.protocol, plan, resources: resources.skills.length + resources.knowledge.length }); sendEvent("done", { ok: true }); response.end();
      } catch (error) { recordAgentAudit({ type: "agent.plan.failed", documentId: input.documentId || "default", conversationId: input.conversationId, requestId: requestTraceId, providerId, model: provider.model, status: "failed", durationMs: Date.now() - startedAt, attempts: 1, errorCode: "AGENT_PLAN_FAILED", summary: error instanceof Error ? error.message : "Agent streaming failed." }); sendEvent("error", { code: "AGENT_PLAN_FAILED", error: error instanceof Error ? error.message : "Agent streaming failed." }); response.end(); }
      return;
    }    if (request.method === "POST" && url.pathname === "/api/agent/plan") {
      const input = await readJson(request);
      const prompt = String(input.prompt || "").trim();
      if (!prompt || prompt.length > 8000) throw new GatewayRequestError("INVALID_AGENT_PROMPT", "Agent prompt is required and must be at most 8000 characters.");
      const startedAt = Date.now();
      const provider = selectAgentProvider(input.providerId);
      const providerId = provider?.id || "";
      if (!provider) throw new GatewayRequestError("PROVIDER_NOT_FOUND", "Configure an Agent provider before planning.");
      const context = await assembleAgentContext(input, input.context);
      const resources = agentResources.promptContext();
      let generated;
      let plan;
      let attempts = 1;
      try {
        const validated = await generateValidatedAgentPlan(provider, input, prompt, context, resources);
        generated = validated.generated;
        plan = validated.plan;
        attempts = validated.attempts;
      } catch (error) {
        recordAgentAudit({ type: "agent.plan.invalid", documentId: input.documentId || "default", conversationId: input.conversationId, requestId: requestTraceId, providerId, model: provider.model, status: "failed", durationMs: Date.now() - startedAt, attempts, errorCode: "AGENT_PLAN_INVALID", summary: error instanceof Error ? error.message : "Agent plan validation failed." });
        throw new GatewayRequestError("AGENT_PLAN_INVALID", error instanceof Error ? error.message : "Agent plan validation failed.");
      }
      recordAgentAudit({ type: "agent.plan.generated", documentId: input.documentId || "default", conversationId: input.conversationId, requestId: requestTraceId, providerId, model: provider.model, planId: plan.planId, status: plan.status, durationMs: Date.now() - startedAt, attempts, summary: reportAgentPlan(plan).summary });
      sendJson(response, 200, { ok: true, protocolVersion: 1, requestId: requestTraceId || null, providerId, protocol: generated.protocol, model: provider.model, resources: resources.skills.length + resources.knowledge.length, plan });
      return;
    }
    const meshOutputMatch = url.pathname.match(/^\/api\/mesh\/outputs\/([A-Za-z0-9._-]{1,160})$/);
    if (request.method === "GET" && meshOutputMatch) {
      const outputRoot = path.resolve(dataDir, "meshes");
      let outputPath = path.resolve(outputRoot, meshOutputMatch[1]);
      if (outputPath !== outputRoot && !outputPath.startsWith(`${outputRoot}${path.sep}`)) throw new GatewayRequestError("MESH_OUTPUT_INVALID", "Mesh output path is invalid.");
      const controller=new AbortController(),onClose=()=>controller.abort();response.once('close',onClose);request.once('aborted',onClose);
      let access;try{access=await projectMeshes.outputAccess(meshOutputMatch[1],url.searchParams.get('diagnostic')==='1',{signal:controller.signal});}finally{response.off('close',onClose);request.off('aborted',onClose);}if(response.destroyed)return;
      if(access.status!==200){sendJson(response,access.status,access.payload);return;}
      if(access.outputPath){const managedRoots=(access.assetOutput?['project-assets','mesh-asset-state']:['mesh-jobs']).map(name=>path.resolve(dataDir,name));outputPath=path.resolve(access.outputPath);if(!access.proof||!managedRoots.some(managedRoot=>outputPath.startsWith(managedRoot+path.sep)))throw new GatewayRequestError('MESH_OUTPUT_INVALID','网格下载缺少受管位置和完整凭据。');}
      if (!fs.existsSync(outputPath)) { sendJson(response, 404, { ok: false, protocolVersion: 1, requestId: requestTraceId || null, code: "MESH_OUTPUT_NOT_FOUND", error: "Mesh output does not exist.", recoverable: true }); return; }
      const headers={...corsHeaders(response._cadCorsOrigin || webOrigin),...access.headers,'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${access.filename}"`};
      if(access.proof){await streamCheckedMesh(outputPath,access.proof,response,headers);return;}
      response.writeHead(200, { ...headers, "Content-Length": fs.statSync(outputPath).size });
      fs.createReadStream(outputPath).pipe(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/mesh/health") {
      try {
        const workerHealth = await meshWorker.request({ protocolVersion: 1, requestId: requestTraceId || `mesh-health-${Date.now()}`, operation: "health.ping" });
        sendJson(response, 200, { ...workerHealth, worker: true, workerPath: meshWorkerPath });
      } catch (error) {
        sendJson(response, 503, { ok: false, protocolVersion: 1, requestId: requestTraceId || null, worker: false, workerPath: meshWorkerPath, code: error?.code || "MESH_WORKER_UNAVAILABLE", error: error instanceof Error ? error.message : "Mesh worker is unavailable.", recoverable: true });
      }
      return;
    }
    if (request.method === "POST" && ["/api/mesh/preflight", "/api/mesh/create", "/api/mesh/repair", "/api/mesh/intersections", "/api/mesh/quality"].includes(url.pathname)) {
      const input=await readJson(request);let lease,held=false;
      try{
        if(['/api/mesh/create','/api/mesh/repair','/api/mesh/intersections'].includes(url.pathname))lease=await meshStorage.reserve('file-'+randomUUID());
        const result = await handleMeshRoute({ method: request.method, pathname: url.pathname, input, requestId: requestTraceId, client: meshWorker, outputDirectory: path.join(dataDir, "meshes") });
        if(lease&&result.payload?.ok)await lease.verify();
        if(lease&&result.payload?.code==='MESH_STOP_UNCONFIRMED'){const children=[...meshWorker.children];held=true;void Promise.all(children.map(childExit)).then(()=>{if(children.every(child=>child.exitCode!=null||child.signalCode!=null))lease.release();});}
        const outputPath = result.payload?.mesh?.outputPath || result.payload?.repair?.outputPath; const payload = outputPath ? { ...result.payload, downloadUrl: `/api/mesh/outputs/${encodeURIComponent(path.basename(outputPath))}` } : result.payload;
        sendJson(response, result.status, payload);
      }catch(error){sendJson(response,['MESH_STORAGE_CAPACITY','MESH_STORAGE_FREE_SPACE'].includes(error.code)?507:503,{ok:false,code:error.code||'MESH_STORAGE_UNAVAILABLE',error:error.message});}
      finally{if(!held)lease?.release();}
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health/live") {
      sendJson(response, 200, { ok: true, gateway: true, worker: geometryReady(), requestId: requestTraceId || null });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const ready=geometryReady();
      sendJson(response, ready ? 200 : 503, {
        ok: ready,
        protocolVersion: 1,
        gateway: true,
        backendRelease,
        worker: ready,
        loadedDocuments: loadedDocuments.size,
        startup,
        documentLoading:documentLoader.counts(historyStore.documentIds()),
        meshCatalog:projectMeshes.catalogStatus(),
        surfaceReconstruction:{...surfaceRuntime.status(),tasks:projectMeshes.surfaceStatus()},
        runtime: {uptimeSeconds:process.uptime(),gatewayMemory:process.memoryUsage(),workerPending:workerPending(),workerChannel:workerChannel?.status()||null,geometryMemory:{basis:workerMemoryPolicy.basis,configuredBytes:workerMemoryPolicy.limitBytes,state:workerResourceGuard?'enforced':workerResourceBlocked?'blocked':'pending',blockedCode:workerResourceBlocked?.code||null},meshMemory:{basis:meshWorkerMemoryPolicy.basis,configuredBytes:meshWorkerMemoryPolicy.limitBytes,processes:projectMeshes.resourceStatus()},meshStorage:meshStorage.status(),meshRetirement:projectMeshes.retirementStatus(),meshQualityQueries:projectMeshes.qualityQueries.status(),meshArtifacts:projectMeshes.artifacts.status(),meshCompute:projectMeshes.computeGate.status(),meshTaskCapacity:{stored:projectMeshes.catalogStatus().stored,max:projectMeshes.maxStoredJobs,maxPerDocument:projectMeshes.maxJobsPerDocument},...runtimeMetrics},
        lifecycle:{state:shutdownPhase,activeDocuments:runningDocuments.size,queuedDocumentActions:documentActions.status().queued,documentActions:documentActions.status(),projectInputs:pendingProjectInputs.status(),stepInputs:pendingStepInputs.status(),modelingTasks:modelingTasks.status(),projectBackups:projectBackups.status()},
        storage:{writer:dataWriter,checkpointIntegrity:historyStore.integrityMetrics(),sourceRestoration:sourceRestores.health()},
        capabilities: {
          nativeGeometry:nativeCapabilities(),
          modelingTaskControl:{version:1,reservation:'server-issued-task-id-v1',commands:true,undoRedo:true,batches:true,batchReceipt:'exact-aggregate-v1',step:true,stepReservation:'registered-single-attachment-v1',projectOpen:true,projectOpenReservation:'registered-single-attachment-v1',projectSave:true,projectSaveReservation:'registered-fixed-backup-v1',projectFiles:false,commitCancellation:false,restart:'query-durable-receipt-never-replay'},
          preview: true,
          batches: true,
          commandBatch: true,
          atomicBatch: true,
          maxSerializedBatchStepResultBytes:maxBatchResultBytes,
          idempotency: true,
          idempotencyRetention:{maxEntriesPerDocument:historyStore.idempotencyLimit,maxSerializedOutcomeBytesPerDocument:historyStore.idempotencyBytes,immutableOutcomeVersion:1,replay:'exact-recorded-result',expiredKeys:'not-guaranteed',missingOutcome:'reject-without-reexecution'},
          stepExchange: true,
          history: true,
          persistentHistory: true,
          typedPropertyHistory: true,
          propertyTargetCollections: {schemaVersion:2,maxTargets:256,scopes:['body','face','edge'],splitPolicies:['review','all-descendants']},
          optimisticProjectEdits: true,
          orderedProjectState: true,
          historicalFeatureInput: true,
          historicalFeatureInputOperations:["feature.update","variable.set","coordinate.set","feature.suppress","feature.restore","feature.delete"],
          selectionStatePrecondition: SELECTION_STATE_POLICY,
          propertyMigrationPreview: true,
          atomicProjectState: { propertyCheckpointVersion:1, recoveryJournalVersion:2 },
          mesh: Boolean(meshWorker),
          spatialObb: "occt-brep-obb-not-minimum-with-aabb-fallback",
          spatialCache: {persistentGeometryIdentity:true,maxDocuments:32,maxMeasurementsPerDocument:256},
          catalogVersion: "gateway-v1",
        },
        operationCatalogVersion: "gateway-v1",
        requestId: requestTraceId || null,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/box") {
      const input = await readJson(request);
      const result = await executeMutation("primitive.box", {
        documentId: documentId(input.documentId),
        parameters: {
          width: finiteNumber(input.width, "width"),
          depth: finiteNumber(input.depth, "depth"),
          height: finiteNumber(input.height, "height"),
          reset: input.reset !== false,
        },
      });
      sendJson(response, statusFor(result), result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/fillet") {
      const input = await readJson(request);
      const edgeId = String(input.edgeId || "");
      if (!/^edge-\d+-\d+$/.test(edgeId)) throw new Error("edgeId is invalid.");
      if(input.baseStateToken!==undefined)validateCommandInput({baseStateToken:input.baseStateToken},"document.summary");
      const result = await executeMutation("detail.fillet", {
        documentId: documentId(input.documentId),
        baseRevision: Math.trunc(finiteNumber(input.revision, "revision")),
        ...(input.baseStateToken===undefined?{}:{baseStateToken:input.baseStateToken}),
        inputs: { edgeId, bodyId: input.bodyId ? String(input.bodyId) : "" },
        parameters: { radius: finiteNumber(input.radius, "radius") },
      });
      sendJson(response, statusFor(result), result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/command-batches") {
      const input = await readJson(request);
      let batch;
      try { batch=prepareBatchInput(input); }
      catch (error) { noteRejectedWrite(input,'project.batch',error); throw error; }
      const {document,batchId,steps}=batch;
      requestTraceId = String(input.requestId || batchId);
      requestDocumentId=document;
      const {task,beforeExecute} = claimCommandTask(request,input,document,'project.batch');
      const result = await executeMutationBatch(steps,task,batchId,requestTraceId,beforeExecute);
      sendJson(response, statusFor(result.response), { ...result.response, batchId, results: result.results,...(task?{modelingTask:modelingTasks.get(document,task.taskId)}:{}) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/commands") {
      const input = await readJson(request);
      requestTraceId = String(input.requestId || requestTraceId || "");
      requestDocumentId = input.documentId || null;
      const operation = normalizeOperation(String(input.operation || ""));
      try { validateCommandInput(input, operation); }
      catch (error) { noteRejectedWrite(input,operation,error); throw error; }
      const id = documentId(input.documentId);
      if (["document.snapshot", "document.restore", "step.import", "step.export"].includes(operation))
        throw new Error("Use the dedicated persistence or STEP routes for this operation.");
      const {task,beforeExecute} = claimCommandTask(request,input,id,operation);
      if (operation === "document.undo" || operation === "document.redo") {
        const result = await moveHistory(id, operation === "document.undo" ? "undo" : "redo", input.options?.idempotencyKey || input.idempotencyKey || input.requestId || "", input,task);
        sendJson(response, statusFor(result), task?{...result,modelingTask:modelingTasks.get(id,task.taskId)}:result);
        return;
      }
      const fields = commandRequestFields(input,id);
      const readOnly = READ_ONLY_OPERATIONS.has(operation);
      const preview = input.options?.preview === true || input.preview === true;
      let result;
      if(operation==='health.ping')result=await command(operation,fields);
      else if (readOnly) {
        result = await serializeDocument(id, async () => {
          const startedAt = Date.now();
          try {
            if(operation==="feature.input.preview" || operation==="document.naming.preview")checkStatePrecondition(id,fields);
            if(operation==="document.naming.preview")checkSelectionPrecondition(operation,fields);
            if(operation==="document.naming.preview")assertImportedNamingUpgrade(nativeCapabilities());
            const response = isProjectDataOperation(operation)
              ? await executeProjectDataOperation(operation, fields)
              : await command(operation, fields);
            logCommand(operation, fields, response, startedAt);
            return withHistoryState(response, id);
          } catch (error) {
            logCommand(operation, fields, null, startedAt, error);
            throw error;
          }
        },{inputBytes:Buffer.byteLength(JSON.stringify(fields))});
      } else if (preview) {
        result = await executePreview(operation, fields);
      } else {
        result = await executeMutation(operation, fields,undefined,task,{beforeExecute});
      }
      // Mutation outcomes already carry their original commit state. Replacing
      // their history here would mix an old replayed model with a new event.
      sendJson(response, statusFor(result), task?{...result,modelingTask:modelingTasks.get(id,task.taskId)}:operation==='health.ping'?withHistoryState(result,id):result);
      return;
    }
    if (isProjectMeshRoute(request.method, url.pathname)) {
      const input = request.method === "POST" ? await readJson(request) : Object.fromEntries(url.searchParams);
      const controller=new AbortController(),onDisconnect=()=>{if(!response.writableEnded)controller.abort();};
      request.once('aborted',onDisconnect);response.once('close',onDisconnect);
      try{const result = await projectMeshes.handle(request.method, url.pathname, input,{signal:controller.signal});if(!response.destroyed){if(result.body){response.writeHead(result.status,{...corsHeaders(response._cadCorsOrigin||webOrigin),...result.headers});response.end(result.body);}else sendJson(response, result.status, result.payload);}}
      finally{request.off('aborted',onDisconnect);response.off('close',onDisconnect);}
      return;
    }
    const stepTaskMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/imports\/step\/tasks$/);
    if(stepTaskMatch&&request.method==='POST'){
      authorizeModelingTaskRequest(request,webOrigin,port);const input=await readJson(request),id=documentId(stepTaskMatch[1]);requestDocumentId=id;
      if([...url.searchParams].length||!input||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'command'))throw new ModelingTaskError('STEP_IMPORT_TASK_ARGUMENTS','STEP 任务登记只接受唯一 command 对象，不支持查询参数。',400);
      const result=stepImportTasks.register(id,input.command);sendJson(response,201,{ok:true,protocolVersion:1,documentId:id,...result});return;
    }
    const stepDocumentMatch = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/(imports|exports)\/step$/);
    if (stepDocumentMatch && request.method === "POST") {
      const id = documentId(stepDocumentMatch[1]);
      requestDocumentId=id;
      if (stepDocumentMatch[2] === "imports") {
        if(request.headers['x-cad-task-id']!==undefined){
          authorizeModelingTaskRequest(request,webOrigin,port);requestTraceId=typeof request.headers['x-request-id']==='string'?request.headers['x-request-id']:null;
          const result=await stepImportTasks.upload(id,request.headers['x-cad-task-id'],request.headers,request);sendJson(response,statusFor(result),result);return;
        }
        const uploadPath = stepImportPath(id),clientRequestId=String(request.headers['x-request-id']||'step-import-'+randomUUID());
        let fileName;try{fileName=decodeURIComponent(String(request.headers['x-file-name']||'import.step'));}catch{throw new GatewayRequestError('INVALID_STEP_FILE_NAME','STEP 文件名编码无效。');}
        const baseStateToken=request.headers['x-base-state-token'],baseRevision=request.headers['x-base-revision'];
        if(baseStateToken!==undefined&&(typeof baseStateToken!=='string'||!/^[a-f0-9]{64}$/.test(baseStateToken)))throw new GatewayRequestError('INVALID_STATE_TOKEN','导入使用的工程状态标识无效。');
        if(baseRevision!==undefined&&(typeof baseRevision!=='string'||!/^\d+$/.test(baseRevision)||!Number.isSafeInteger(Number(baseRevision))))throw new GatewayRequestError('INVALID_REVISION','导入使用的工程修订无效。');
        stepImports.begin(id,clientRequestId,fileName);
        let retained = false;
        try {
          const bytes=await readBinary(request);
          const source=fs.openSync(uploadPath,'wx',0o600);try{fs.writeFileSync(source,bytes);fs.fsyncSync(source);}finally{fs.closeSync(source);}
          stepImports.advance(id,clientRequestId,'queued',{bytes:bytes.length});
          const beforeToken=projectStateToken(id,historyFor(id));
          const result = await executeMutation("step.import", { documentId: id,clientRequestId,...(baseStateToken!==undefined?{baseStateToken}:{}),...(baseRevision!==undefined?{baseRevision:Number(baseRevision)}:{}),parameters: { path: uploadPath } },(phase,patch)=>stepImports.advance(id,clientRequestId,phase,patch));
          retained = result.ok || Boolean(historyFor(id).restoreError);
          const outcome=stepImports.advance(id,clientRequestId,result.ok?'complete':'failed',{revision:result.revision,stateToken:result.stateToken,report:result.stepImport,code:result.code,error:result.error,unchanged:!result.ok&&!historyFor(id).restoreError&&projectStateToken(id,historyFor(id))===beforeToken});
          sendJson(response, statusFor(result), {...result,stepImportStatus:outcome,...(outcome?.reportDurable===false?{warnings:[...(result.warnings||[]),'导入结果已返回，但进度报告落盘失败，请保留命令结果并核对工程。']}:{} )});
        } catch(error){
          const restored=error?.projectRollback?.confirmed===true&&error.projectRollback.documentId===id;
          const uncertain=!restored&&['PROJECT_ROLLBACK_FAILED','PROJECT_RECOVERY_REQUIRED','TRANSACTION_ROLLBACK_FAILED','WORKER_TIMEOUT','WORKER_STOP_UNCONFIRMED','SERVICE_STOPPING'].includes(error?.code);
          // An uncertain transaction may still reference this source. Retain it
          // for recovery instead of turning an ambiguous outcome into data loss.
          retained ||= uncertain;
          stepImports.advance(id,clientRequestId,uncertain?'unknown':'failed',{code:error.code||'STEP_IMPORT_FAILED',error:error.message});throw error;
        } finally {
          if (!retained)try{fs.rmSync(uploadPath, { force: true });}catch{process.stderr.write('[step] Unused upload cleanup deferred; original import result retained.\n');}
        }
        return;
      }
      const exportPath = stepExportPath(id);
      const clientRequestId = String(request.headers["x-request-id"] || "");
      const result = await serializeDocument(id,()=>command("step.export", { documentId: id, ...(clientRequestId ? { clientRequestId } : {}), parameters: { path: exportPath } }));
      sendJson(response, statusFor(result), withHistoryState({ ...result, downloadUrl: `/api/exports/${id}/download` }, id));
      return;
    }

    const downloadMatch = url.pathname.match(/^\/api\/exports\/([A-Za-z0-9_-]{1,64})\/download$/);
    if (downloadMatch && request.method === "GET") {
      const id = documentId(downloadMatch[1]);
      const exportPath = stepExportPath(id);
      if (!fs.existsSync(exportPath)) {
        sendJson(response, 404, { ok: false, protocolVersion: 1, requestId: requestTraceId || null, documentId: id, code: "EXPORT_NOT_FOUND", error: "STEP export not found.", recoverable: true });
        return;
      }
      response.writeHead(200, {
        "Access-Control-Allow-Origin": response._cadCorsOrigin || webOrigin,
        "Cache-Control": "no-store",
        "Content-Type": "application/step",
        "Content-Disposition": `attachment; filename="${id}.step"`,
        "Content-Length": fs.statSync(exportPath).size,
      });
      fs.createReadStream(exportPath).pipe(response);
      return;
    }

    const projectSaveTasksMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/save\/tasks(?:\/([a-f0-9-]{36}))?$/);
    if(projectSaveTasksMatch&&['POST','GET'].includes(request.method)){
      authorizeModelingTaskRequest(request,webOrigin,port);const id=projectSaveTasksMatch[1],taskId=projectSaveTasksMatch[2];requestDocumentId=id;
      if([...url.searchParams].length)throw new ModelingTaskError('PROJECT_SAVE_TASK_ARGUMENTS','工程保存任务不接受查询参数。',400);
      if(request.method==='POST'&&!taskId){const body=await readJson(request);if(!body||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'command'))throw new ModelingTaskError('PROJECT_SAVE_TASK_ARGUMENTS','保存登记只接受唯一 command 对象。',400);sendJson(response,201,{ok:true,...projectSaveTasks.register(id,body.command)});return;}
      if(request.method==='GET'&&taskId){sendJson(response,200,{ok:true,...projectSaveTasks.get(id,taskId)});return;}
      throw new ModelingTaskError('PROJECT_SAVE_TASK_ARGUMENTS','工程保存任务接口方法不受支持。',405);
    }
    const backupMaintenanceMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/backup-maintenance(?:\/([a-f0-9-]{36})(\/commit)?)?$/);
    if(backupMaintenanceMatch){
      authorizeModelingTaskRequest(request,webOrigin,port);const id=backupMaintenanceMatch[1],reviewId=backupMaintenanceMatch[2];requestDocumentId=id;
      const maintenanceReply=async action=>{try{return await action();}catch(error){if(error instanceof ProjectBackupError)throw error;throw new ProjectBackupError('PROJECT_BACKUP_MAINTENANCE_IO','维护存储暂不可用或结果尚未确认。请读取原清单核对；材料不会自动清理，不能据此认定已经删除。',503);}};
      if([...url.searchParams].length)throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','备份维护不接受查询参数。',400);
      if(request.method==='GET'&&!backupMaintenanceMatch[3]){sendJson(response,200,await maintenanceReply(()=>reviewId?projectBackupMaintenance.get(id,reviewId):projectBackupMaintenance.list(id)));return;}
      if(request.method==='DELETE'&&reviewId&&!backupMaintenanceMatch[3]){sendJson(response,200,await maintenanceReply(()=>projectBackupMaintenance.discard(id,reviewId)));return;}
      if(request.method==='POST'){
        const body=await readJson(request);if(!body||Array.isArray(body)||Object.keys(body).length!==1)throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','维护接口只接受一项明确的条目标识或核对摘要。',400);
        if(!reviewId&&Object.hasOwn(body,'entryId')){sendJson(response,201,await maintenanceReply(()=>projectBackupMaintenance.preview(id,body.entryId)));return;}
        if(reviewId&&backupMaintenanceMatch[3]&&Object.hasOwn(body,'snapshotDigest')){sendJson(response,200,await maintenanceReply(()=>projectBackupMaintenance.commit(id,reviewId,body.snapshotDigest)));return;}
        throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','维护提交必须使用原清单标识及其摘要。',400);
      }
      throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','备份维护方法不受支持。',405);
    }
    const backupListMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/backups$/);
    if(backupListMatch&&request.method==='GET'){
      authorizeModelingTaskRequest(request,webOrigin,port);requestDocumentId=backupListMatch[1];
      for(const key of url.searchParams.keys())if(!['limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','备份列表参数无效。',400);
      const rawLimit=url.searchParams.get('limit');if(rawLimit!==null&&!/^[1-9][0-9]{0,2}$/.test(rawLimit))throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','备份分页大小无效。',400);
      sendJson(response,200,projectBackupCatalog.list(requestDocumentId,{...(rawLimit===null?{}:{limit:Number(rawLimit)}),...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{})}));return;
    }
    const backupMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/backups\/([a-f0-9-]{36})(\/download)?$/);
    if(backupMatch&&['GET','DELETE'].includes(request.method)){
      authorizeModelingTaskRequest(request,webOrigin,port);const id=backupMatch[1],taskId=backupMatch[2];requestDocumentId=id;
      if([...url.searchParams].length||request.headers.range!==undefined)throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','备份接口不接受查询或分段下载参数。',400);
      if(request.method==='GET'&&backupMatch[3]){const download=await projectBackups.openDownload(taskId,id);await streamProjectBackup(response,download,corsHeaders(response._cadCorsOrigin||webOrigin));return;}
      if(request.method==='GET'&&!backupMatch[3]){sendJson(response,200,projectBackupCatalog.get(id,taskId));return;}
      if(request.method==='DELETE'&&!backupMatch[3]){sendJson(response,200,{ok:true,...await projectBackups.remove(taskId,id)});return;}
      throw new ProjectBackupError('PROJECT_BACKUP_ARGUMENTS','备份接口方法不受支持。',405);
    }
    const projectCreateTasksMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/create\/tasks(?:\/([a-f0-9-]{36}))?$/);
    if(projectCreateTasksMatch){
      authorizeModelingTaskRequest(request,webOrigin,port);const [,id,taskId]=projectCreateTasksMatch;requestDocumentId=id;
      if([...url.searchParams].length)throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建登记/状态接口不接受查询参数。',400);
      if(request.method==='POST'&&!taskId){const body=await readJson(request);if(!body||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'command'))throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建登记只接受唯一 command。',400);sendJson(response,201,{ok:true,documentId:id,...projectCreateTasks.register(id,body.command)});return;}
      if(request.method==='GET'&&taskId){sendJson(response,200,{ok:true,documentId:id,...projectCreateTasks.get(id,taskId)});return;}
      throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建任务接口方法不受支持。',405);
    }
    const projectCreateListMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/create-tasks$/);
    if(projectCreateListMatch){
      authorizeModelingTaskRequest(request,webOrigin,port);if(request.method!=='GET')throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建任务列表只接受 GET。',405);
      for(const key of url.searchParams.keys())if(!['limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建任务列表参数无效。',400);
      const raw=url.searchParams.get('limit');if(raw!==null&&!/^[1-9][0-9]{0,2}$/.test(raw))throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建任务分页大小无效。',400);
      sendJson(response,200,{ok:true,...projectCreateTasks.list(projectCreateListMatch[1],{limit:raw===null?50:Number(raw),...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{})})});return;
    }
    const projectCreateMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/create$/);
    if(projectCreateMatch){
      authorizeModelingTaskRequest(request,webOrigin,port);const id=projectCreateMatch[1];requestDocumentId=id;
      if(request.method!=='POST')throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建提交只接受 POST。',405);
      if([...url.searchParams].length||request.headers.range!==undefined||!request.headers['x-cad-task-id'])throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建必须提交原任务身份，不接受查询或分段参数。',400);
      const body=await readJson(request);if(!body||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'command'))throw new ModelingTaskError('PROJECT_CREATE_TASK_ARGUMENTS','新建提交只接受原 command。',400);
      const result=await projectCreateTasks.create(id,request.headers['x-cad-task-id'],request.headers,body.command);sendJson(response,statusFor(result),result);return;
    }
    const projectOpenTasksMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/open\/tasks(?:\/([a-f0-9-]{36}))?$/);
    if(projectOpenTasksMatch&&['POST','GET'].includes(request.method)){
      authorizeModelingTaskRequest(request,webOrigin,port);const id=projectOpenTasksMatch[1],taskId=projectOpenTasksMatch[2];requestDocumentId=id;
      if([...url.searchParams].length)throw new ModelingTaskError('PROJECT_OPEN_TASK_ARGUMENTS','工程打开任务接口不支持查询参数。',400);
      if(request.method==='POST'&&!taskId){const body=await readJson(request);if(!body||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'command'))throw new ModelingTaskError('PROJECT_OPEN_TASK_ARGUMENTS','工程打开任务登记只接受唯一 command 对象。',400);sendJson(response,201,{ok:true,protocolVersion:1,documentId:id,...projectOpenTasks.register(id,body.command)});return;}
      if(request.method==='GET'&&taskId){sendJson(response,200,{ok:true,documentId:id,...projectOpenTasks.get(id,taskId)});return;}
      throw new ModelingTaskError('PROJECT_OPEN_TASK_ARGUMENTS','工程打开任务接口方法不受支持。',405);
    }
    const projectOpenListMatch=url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/open-tasks$/);
    if(projectOpenListMatch&&request.method==='GET'){
      authorizeModelingTaskRequest(request,webOrigin,port);for(const key of url.searchParams.keys())if(!['limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ModelingTaskError('PROJECT_OPEN_TASK_ARGUMENTS','工程文件任务列表参数无效。',400);
      const rawLimit=url.searchParams.get('limit');if(rawLimit!==null&&!/^[1-9][0-9]{0,2}$/.test(rawLimit))throw new ModelingTaskError('PROJECT_OPEN_TASK_ARGUMENTS','工程文件任务分页大小无效。',400);
      sendJson(response,200,{ok:true,...projectOpenTasks.list(projectOpenListMatch[1],{limit:rawLimit===null?50:Number(rawLimit),...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{})})});return;
    }
    const projectMatch = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})\/project\/(save|open)$/);
    if (projectMatch && request.method === "POST") {
      const id = documentId(projectMatch[1]);
      requestDocumentId=id;
      if(request.headers['x-cad-task-id']!==undefined){
        authorizeModelingTaskRequest(request,webOrigin,port);
        if(projectMatch[2]==='save'){
          if([...url.searchParams].length)throw new ModelingTaskError('PROJECT_SAVE_TASK_ARGUMENTS','工程保存不接受查询参数。',400);
          const body=await readJson(request);if(!body||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'command'))throw new ModelingTaskError('PROJECT_SAVE_TASK_ARGUMENTS','工程保存提交需要原登记 command。',400);
          const result=await projectSaveTasks.generate(id,request.headers['x-cad-task-id'],request.headers,body.command);sendJson(response,200,result);return;
        }
        const result=await projectOpenTasks.upload(id,request.headers['x-cad-task-id'],request.headers,request);sendJson(response,statusFor(result),result);return;
      }
      projectFiles.assertModelAccess(id);
      if (projectMatch[2] === "save") {
        const bytes = await serializeDocument(id,async()=>{const project=workspaces.get(id);if(!project.recoverable)throw new GatewayRequestError("WORKSPACE_UNAVAILABLE","恢复快照不可用，不能将空状态作为原工程导出。");const token=workspaces.token(id);const result=await projectFiles.save(id,{name:project.name});workspaces.markGenerated(id,token);return result;});
        response.writeHead(200, { ...(corsHeaders(response._cadCorsOrigin || webOrigin)), "Content-Type": PROJECT_MIME, "Content-Disposition": `attachment; filename="${id}${PROJECT_EXTENSION}"`, "Content-Length": bytes.length });
        response.end(bytes);
        return;
      }
      const rawLength=request.headers['content-length'];
      if(rawLength!==undefined&&(typeof rawLength!=='string'||!/^\d{1,10}$/.test(rawLength)||!Number.isSafeInteger(Number(rawLength))))throw new PendingProjectInputError('PROJECT_INPUT_SIZE','工程上传长度声明无效。');
      const staged=await pendingProjectInputs.receive(request,{maxBytes:maxProjectUploadBytes,...(rawLength===undefined?{}:{declaredBytes:Number(rawLength)})});
      try{
        const restored = await serializeDocument(id,async()=>{projectTransactions.assertWritable(id);const bytes=await staged.read();const result=await projectFiles.open(id,bytes);try{if(result.projectFile?.name)workspaces.rename(id,result.projectFile.name);else workspaces.get(id);if(result.projectFile.format==="web-cad-project")workspaces.markGenerated(id,workspaces.token(id));}catch(error){result.warnings.push(`工程已打开，但名称/备份状态记录失败：${error.message}`);}return result;},{inputBytes:128});
        sendJson(response,200,withHistoryState(restored,id));
      }finally{await staged.release();}
      return;
    }
    const match = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9_-]{1,64})(?:\/(snapshot|restore))?$/);
    if (match) {
      const id = documentId(match[1]);
      if (request.method === "GET" && !match[2]) {
        const result = await serializeDocument(id,async()=>withHistoryState(await command("document.summary", { documentId: id }),id));
        sendJson(response, statusFor(result), result);
        return;
      }
      if (request.method === "POST" && match[2]) {
        const operation = match[2] === "snapshot" ? "document.snapshot" : "document.restore";
        const fields = { documentId: id, parameters: { path: snapshotPath(id) } };
        const result = operation === "document.restore"
          ? await executeMutation(operation, fields)
          : await serializeDocument(id,async()=>withHistoryState(await command(operation, fields),id));
        sendJson(response, statusFor(result), result);
        return;
      }
    }

    sendJson(response, 404, { ok: false, protocolVersion: 1, requestId: requestTraceId || null, documentId: requestDocumentId || null, code: "ROUTE_NOT_FOUND", error: "Route not found.", recoverable: false });
  } catch (error) {
    // Streaming may already have sent headers before detecting changed bytes.
    // Never attempt a second JSON response or crash the Gateway on disconnect.
    if(response.destroyed)return;if(response.headersSent){response.destroy();return;}
    const code = error instanceof ProjectBackupError || error instanceof ModelingTaskError || error instanceof PendingProjectInputError || error instanceof DocumentActionError || error instanceof NativeChannelError || error instanceof WorkerCapabilityError || error instanceof GatewayRequestError || error instanceof ProjectFileError || error instanceof DocumentLoadError || error instanceof PiSessionError || error instanceof IdempotencyOutcomeError || error instanceof ProjectTransactionError || error instanceof StepImportError || error instanceof SourceInspectionError || error instanceof StepSourceError || error instanceof SourceAuditError || error instanceof SourceRestoreServiceError || ['WORKSPACE_NOT_FOUND','SERVICE_STOPPING'].includes(error?.code) ? error.code : "GATEWAY_ERROR";
    sendJson(response, gatewayErrorStatus(code,error instanceof ProjectBackupError||error instanceof PendingProjectInputError||error instanceof ModelingTaskError?error.status:undefined), {
      ok: false,
      protocolVersion: 1,
      requestId: requestTraceId || null,
      documentId: requestDocumentId || null,
      code,
      error: error instanceof Error ? error.message : "Unexpected gateway error.",
      recoverable: error instanceof PiSessionError?error.outcome!=='unknown':error.permanent?false:!['WORKER_STOP_UNCONFIRMED','INVALID_OPERATION','UNSUPPORTED_PROTOCOL','IDEMPOTENCY_RESULT_UNAVAILABLE','PROJECT_RECOVERY_REQUIRED','PROJECT_ROLLBACK_FAILED','PROJECT_DATA_OUT_OF_SYNC'].includes(code),
      ...(error instanceof PiSessionError?{outcome:error.outcome,retryableByModel:false}:{}),
      ...(error instanceof WorkerCapabilityError||error instanceof NativeChannelError?{retryableByModel:false}:{}),
      ...(error instanceof DocumentActionError?{...(['DOCUMENT_ACTION_INPUT_LIMIT','DOCUMENT_ACTION_QUEUE_LIMIT','DOCUMENT_ACTION_QUEUE_TIMEOUT','DOCUMENT_ACTION_CANCELLED','SERVICE_STOPPING'].includes(code)?{execution:'not-started'}:{}),retryableByModel:false}:{}),
      ...(error instanceof PendingProjectInputError?{execution:'not-started',retryableByModel:false}:{}),
      ...(error instanceof ModelingTaskError?{retryableByModel:false,...(code==='MODELING_TASK_REPORT_UNAVAILABLE'&&error.details?.taskPersistence?{details:{taskPersistence:error.details.taskPersistence}}:{})}:{}),
      ...(error.modelingTask?{modelingTask:error.modelingTask}:{}),
      ...(error.modelingTask?.execution==='not-started'?{execution:'not-started'}:{}),
      ...(error.batchOutcome||{}),
      ...(error?.projectRollback?.confirmed===true?{projectRollback:{documentId:error.projectRollback.documentId,confirmed:true}}:{}),
      ...(code==="PROJECT_STATE_CONFLICT"?{currentStateToken:error.currentStateToken}:{}),
      ...(Array.isArray(error.selectionPaths)?{selectionPaths:error.selectionPaths,policyVersion:error.policyVersion}:{}),
      ...(error instanceof GatewayRequestError ? { fieldPath: error.fieldPath || null, expected: error.expected || null, received: error.received ?? null, retryableByModel: error.retryableByModel === true, currentRevision: Number.isInteger(error.currentRevision) ? error.currentRevision : null } : {}),
    });
  }
});
server.requestTimeout = requestTimeoutMs;
server.headersTimeout = requestTimeoutMs + 5_000;
server.keepAliveTimeout = 5_000;

await workerHandshake;

server.listen(port, host, () => {
  try{shutdownControl.publish();}catch(error){process.stderr.write(JSON.stringify({type:'cad.startup',phase:'blocked',code:'SHUTDOWN_CONTROL_UNAVAILABLE',error:error.message})+'\n');void shutdown('control-publication-failed');return;}
  startup.readyAt=workerReady?new Date().toISOString():null;
  console.log(`Geometry gateway ${workerReady?'ready':'listening (worker unavailable)'} at ${host}:${port}`);
  process.stdout.write(JSON.stringify({type:'cad.startup',phase:workerReady?'ready':'degraded',...startup,processUptimeMs:process.uptime()*1000})+'\n');
});

async function within(promise,ms){let timer;try{return await Promise.race([Promise.resolve(promise).then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}}
function shutdown(reason='signal') {
  if(shutdownPromise)return shutdownPromise;
  shuttingDown = true;
  shutdownPhase='draining';
  sourceAccessGate.close();
  cancelQueuedOperations();
  if (restartTimer) clearTimeout(restartTimer);
  server.close();
  server.closeIdleConnections();
  const ledgerErrors=agentRuns.stop();
  const sourceShutdown=Promise.allSettled([sourceRestores.close(),sourceAudits.close(),storageSourceAudits.close()]).then(async results=>{await sourceSwap.close();await sourceInspector.close();const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;});
  const auxiliary=Promise.allSettled([piRuntime.close(),projectMeshes.closeAndWait(),projectBackupMaintenance.closeAndWait(),meshWorker.dispose(),sourceShutdown,pendingProjectInputs.close(),pendingStepInputs.close()]);
  const log=(phase,extra={})=>process.stdout.write(JSON.stringify({type:'cad.shutdown',phase,reason,...extra})+'\n');
  let finishing=false;
  const finish=(code)=>{
    if(finishing)return;finishing=true;
    const leave=()=>{stepImports.interruptActive();try{shutdownControl.record({state:code===0?'complete':'interrupted',reason,activeDocuments:runningDocuments.size,pendingRequests:workerPending()});}catch{log('report-unavailable');}shutdownControl.remove();log(code===0?'complete':'interrupted',{activeDocuments:runningDocuments.size,pendingRequests:workerPending()});process.exit(code);};
    const live=[...new Set([...sourceSwap.children,...geometryChildren,...meshWorker.children,...projectMeshes.ownedChildren()])].filter(child=>child.exitCode==null&&child.signalCode==null&&child.pid!=null);
    if(!live.length){leave();return;}
    // Never release the data-directory writer while a tracked source/geometry/
    // mesh writer could still touch files. A stop timeout is not exit evidence.
    for(const child of live)child.kill();log('native-stop-unconfirmed',{helpers:live.length});void Promise.all(live.map(childExit)).then(leave);
  };
  const hardTimer=setTimeout(()=>{forceStopping=true;for(const child of geometryChildren)child.kill();void meshWorker.dispose();log('deadline',{activeDocuments:runningDocuments.size});finish(1);},shutdownBudgetMs);
  log('draining',{activeDocuments:runningDocuments.size,queuedDocumentActions:documentActions.status().queued});
  shutdownPromise=(async()=>{
    const drained=await within(documentActions.whenIdle(),shutdownGraceMs);
    shutdownPhase=drained?'stopping':'forcing';forceStopping=true;
    if(!drained)log('drain-timeout',{activeDocuments:runningDocuments.size});
    workerReady=false;const stopped=[...geometryChildren].map(child=>{const done=waitChildExit(child,{timeoutMs:shutdownStopMs,code:'GEOMETRY_STOP_UNCONFIRMED'});child.kill();return done;});
    const resources=await Promise.allSettled([...stopped,auxiliary.then(results=>{const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;})]);
    const failed=resources.find(result=>result.status==='rejected');
    if(failed)log('resource-unconfirmed',{code:failed.reason?.code||'RESOURCE_STOP_FAILED'});
    await within(documentActions.whenIdle(),500);
    // Give already-completed command replies a chance to reach their clients.
    await within(Promise.all([...activeResponses].map(response=>new Promise(resolve=>{if(response.writableFinished||response.destroyed)return resolve();response.once('finish',resolve);response.once('close',resolve);}))),500);
    for(const response of activeResponses)if(!response.writableEnded&&!response.destroyed){if(response.headersSent)response.end();else sendJson(response,503,{ok:false,code:'SERVICE_STOPPING',error:'后台停止，当前请求结果需恢复后查询工程核对；没有自动重试。'});}
    server.closeAllConnections();clearTimeout(hardTimer);shutdownPhase=drained&&!failed?'stopped':'forcing';finish(drained&&!failed&&!ledgerErrors&&reason!=='control-publication-failed'?0:1);
  })().catch(error=>{forceStopping=true;for(const child of geometryChildren)child.kill();log('error',{code:error.code||'SHUTDOWN_FAILED'});finish(1);});
  return shutdownPromise;
}

process.on("SIGINT", ()=>{void shutdown('SIGINT');});
process.on("SIGTERM", ()=>{void shutdown('SIGTERM');});
