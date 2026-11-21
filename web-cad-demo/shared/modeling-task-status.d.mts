export type ModelingTaskStatus = {
  version: 1; documentId: string; taskId: string; operation: string; requestKey: string;
  phase: 'reserved'|'receiving'|'queued'|'preparing'|'executing'|'stopping'|'rolling-back'|'committing'|'succeeded'|'failed'|'cancelled'|'unknown';
  sequence: number; createdAt: string; updatedAt: string; cancelRequested: boolean; cancellable: boolean; reportDurable: boolean;
  revision?: number; stateToken?: string; code?: string; error?: string; recovered?: boolean; interrupted?: boolean; restored?: boolean; unchanged?:boolean; execution?: 'not-started';
};
export const MODELING_TASK_PHASES: ModelingTaskStatus['phase'][];
export function modelingTaskTerminal(phase: string): boolean;
export function normalizeModelingTaskStatus(value: unknown, documentId: string, taskId?: string): ModelingTaskStatus;
export function modelingTaskLabel(task: ModelingTaskStatus|null): string;
export function modelingTaskExplanation(task: ModelingTaskStatus|null): string|null;
