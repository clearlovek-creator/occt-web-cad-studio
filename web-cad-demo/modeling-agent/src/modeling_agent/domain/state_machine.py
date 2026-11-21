from __future__ import annotations

from typing import Final

from modeling_agent.domain.models import RunStatus


ALLOWED_TRANSITIONS: Final[dict[RunStatus, frozenset[RunStatus]]] = {
    RunStatus.CREATED: frozenset({RunStatus.RUNNING, RunStatus.CANCELLED}),
    RunStatus.RUNNING: frozenset(
        {
            RunStatus.WAITING_USER,
            RunStatus.WAITING_APPROVAL,
            RunStatus.WAITING_EXTERNAL,
            RunStatus.PAUSED,
            RunStatus.COMPLETED,
            RunStatus.FAILED,
            RunStatus.CANCELLED,
        }
    ),
    RunStatus.WAITING_USER: frozenset({RunStatus.RUNNING, RunStatus.PAUSED, RunStatus.CANCELLED, RunStatus.FAILED}),
    RunStatus.WAITING_APPROVAL: frozenset({RunStatus.RUNNING, RunStatus.PAUSED, RunStatus.CANCELLED, RunStatus.FAILED}),
    RunStatus.WAITING_EXTERNAL: frozenset({RunStatus.RUNNING, RunStatus.PAUSED, RunStatus.FAILED, RunStatus.CANCELLED}),
    RunStatus.PAUSED: frozenset({RunStatus.RUNNING, RunStatus.CANCELLED, RunStatus.FAILED}),
    RunStatus.COMPLETED: frozenset(),
    RunStatus.FAILED: frozenset(),
    RunStatus.CANCELLED: frozenset(),
}


def assert_transition(current: RunStatus, target: RunStatus) -> None:
    if target not in ALLOWED_TRANSITIONS[current]:
        raise ValueError(f"Invalid Run transition: {current} -> {target}")
