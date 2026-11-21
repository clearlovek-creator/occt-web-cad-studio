import type { ModelingCommandInput, ModelingSelection } from "./command-contract";

/**
 * Agent plans are produced by the configured LLM through CAD Tool Calling.
 * The former browser-side rule parser is intentionally disabled: keeping a
 * natural-language parser here would make failures silently diverge from the
 * model/tool contract and could execute geometry without model approval.
 */
export type ModelingAgentSelectionKind = "none" | "body" | "face" | "edge" | "body-or-face-or-edge";
export type ModelingAgentStepStatus = "ready" | "needs-input" | "awaiting-confirmation";
export type ModelingAgentMode = "plan" | "edit";
export type ModelingAgentContext = { revision?: number | null; selections?: ModelingSelection[]; variables?: unknown[]; coordinateSystems?: unknown[]; materials?: unknown[]; model?: unknown; mode?: ModelingAgentMode };
export type ModelingAgentQuestion = { questionId?: string; fieldPath: string; prompt: string; selection?: ModelingAgentSelectionKind };
export type ModelingAgentStep = { id: string; operation: ModelingCommandInput["operation"]; request: ModelingCommandInput; status: ModelingAgentStepStatus; selection: ModelingAgentSelectionKind; risk: "none" | "confirmation"; explanation: string };
export type ModelingAgentPlan = { planId: string; prompt: string; source?: "llm" | "llm-repaired" | "python-langgraph"; providerId?: string; model?: string; protocol?: string; allowed: boolean; status: "ready" | "needs-input" | "awaiting-confirmation" | "rejected"; steps: ModelingAgentStep[]; questions: ModelingAgentQuestion[]; confirmation?: { code: "HIGH_RISK_OPERATION"; prompt: string }; rejectionReason?: string; summary?: string };

/** @deprecated Local rule parsing is forbidden. Use /api/agent/run/stream. */
export function createModelingPlan(): never {
  throw new Error("Local rule parsing is disabled. Configure an LLM Provider with CAD Tool Calling.");
}