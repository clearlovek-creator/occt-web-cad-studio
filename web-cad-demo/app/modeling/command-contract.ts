import type {ModelingTaskStatus} from '../../shared/modeling-task-status.mjs';
export type ModelingSelectionKind = "body" | "face" | "edge";
const READ_ONLY_COMMANDS = new Set(["health.ping","document.summary","document.view","document.preview","document.naming.preview","feature.input.preview","body.presentation","property.list","property.type.list","property.instance.list","property.type.preview","property.package.export","geometry.measure","geometry.check","geometry.relation","mesh.strategy.list"]);
READ_ONLY_COMMANDS.add("property.vector.preview");
export const isReadOnlyCommand = (operation: string) => READ_ONLY_COMMANDS.has(operation);

export type ModelingSelection = {
  kind: ModelingSelectionKind;
  bodyId: string;
  topologyId?: string;
  topologyIds?: string[];
};

export type ModelingCommandOptions = {
  preview?: boolean;
  idempotencyKey?: string;
  agentPlanId?: string;
  conversationId?: string;
};

export type ModelingCommandRequest = {
  protocolVersion: 1;
  operation: string;
  documentId?: string;
  requestId?: string;
  baseRevision?: number;
  baseStateToken?: string;
  inputs?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  options?: ModelingCommandOptions;
};

export type ModelingHistoryState = {
  canUndo?: boolean;
  canRedo?: boolean;
  eventId?: string;
};

export type ModelingCommandResponse = {
  ok: true;
  requestId?: string;
  documentId?: string;
  revision?: number;
  history?: ModelingHistoryState;
  stateToken?: string;
  stateSequence?: number;
  warnings?: string[];
  [key: string]: unknown;
};

export type ModelingCommandErrorPayload = {
  ok: false;
  requestId?: string;
  documentId?: string;
  code?: string;
  error?: string;
  fieldPath?: string;
  recoverable?: boolean;
  details?: Record<string,unknown>;
  retryableByModel?: boolean;
  execution?: 'not-started';
  modelingTask?: ModelingTaskStatus;
  projectRollback?: {documentId: string; confirmed: boolean};
};

export type ModelingCommandInput = Omit<ModelingCommandRequest, "protocolVersion" | "documentId" | "requestId">;

/** Task envelope for the dedicated atomic-batch endpoint, never a native command. */
export type ModelingBatchRequest = ModelingCommandRequest & {
  operation: 'project.batch'; documentId: string; requestId: string; batchId: string;
  steps: ModelingCommandInput[];
};

export type ModelingStepImportRequest = ModelingCommandRequest & {
  operation: 'step.import';documentId:string;requestId:string;fileName:string;expectedBytes:number;
};

export function createRequestId(prefix = "cad") {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function normalizeCommandRequest(
  request: ModelingCommandInput,
  documentId: string,
): ModelingCommandRequest {
  const operationAliases: Record<string, string> = {
    box: "primitive.box",
    create_box: "primitive.box",
    "create.box": "primitive.box",
    "primitive.create": "primitive.box",
    "primitive.create.box": "primitive.box",
    "body.create": "primitive.box",
    "body.create.box": "primitive.box",
    "body.create_box": "primitive.box",
    "box.create": "primitive.box",
    "solid.box": "primitive.box",
    "solid.create": "primitive.box",
  };
  const rawOperation = request.operation.trim().toLowerCase().replace(/\s+/g, "_");
  const operation = operationAliases[rawOperation] || rawOperation;
  if (!operation) throw new Error("Modeling operation is required.");
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/.test(operation)) {
    throw new Error(`Invalid modeling operation: ${operation}`);
  }
  return {
    protocolVersion: 1,
    ...request,
    documentId,
    requestId: createRequestId(),
    inputs: request.inputs || {},
    parameters: request.parameters || {},
  };
}
