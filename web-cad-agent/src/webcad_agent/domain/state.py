from __future__ import annotations

from .models import AgentRun, RunStatus


TERMINAL = {RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED}


def transition(run: AgentRun, target: RunStatus) -> AgentRun:
    if run.status in TERMINAL:
        raise ValueError(f"Terminal Run cannot transition: {run.status} -> {target}")
    allowed = {
        RunStatus.CREATED: {RunStatus.RUNNING, RunStatus.CANCELLED},
        RunStatus.RUNNING: {
            RunStatus.WAITING_USER,
            RunStatus.WAITING_APPROVAL,
            RunStatus.PAUSED,
            RunStatus.COMPLETED,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
        },
        RunStatus.WAITING_USER: {RunStatus.RUNNING, RunStatus.CANCELLED, RunStatus.PAUSED},
        RunStatus.WAITING_APPROVAL: {RunStatus.RUNNING, RunStatus.CANCELLED, RunStatus.PAUSED},
        RunStatus.PAUSED: {RunStatus.RUNNING, RunStatus.CANCELLED},
    }
    if target not in allowed.get(run.status, set()):
        raise ValueError(f"Invalid Run transition: {run.status} -> {target}")
    return run.model_copy(update={"status": target})
