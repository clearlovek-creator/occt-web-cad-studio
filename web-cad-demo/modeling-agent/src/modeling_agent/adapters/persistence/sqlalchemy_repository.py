from __future__ import annotations

from copy import deepcopy
from datetime import timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from modeling_agent.adapters.persistence.sqlalchemy_models import (
    AgentActionRow,
    AgentConfigSnapshotRow,
    AgentApprovalRow,
    AgentEventRow,
    AgentGoalRow,
    AgentIdempotencyRow,
    AgentQuestionRow,
    AgentRunRow,
    Base,
)
from modeling_agent.application.store import InMemoryRepository
from modeling_agent.domain.models import (
    ActionRequest,
    AgentEvent,
    AgentRun,
    ConfigSnapshot,
    ApprovalRequest,
    ElicitationRequest,
    EventType,
    RunStatus,
    new_id,
    utc_now,
)
from modeling_agent.domain.state_machine import assert_transition


class SqlAlchemyRepository(InMemoryRepository):
    """SQLAlchemy-backed implementation of the repository contract.

    The domain and workflow layers still depend on the small repository API, so
    the same services can run with JSON, memory, SQLite or PostgreSQL storage.
    """

    def __init__(self, database_url: str, *, initialize: bool = False) -> None:
        super().__init__()
        from modeling_agent.adapters.persistence.sqlalchemy import create_sync_engine

        self.engine = create_sync_engine(database_url)
        if initialize:
            Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False, class_=Session)

    def close(self) -> None:
        self.engine.dispose()

    @staticmethod
    def _run(row: AgentRunRow) -> AgentRun:
        return AgentRun(
            id=row.id,
            project_id=row.project_id,
            document_id=row.document_id,
            user_id=row.user_id,
            status=RunStatus(row.status),
            current_stage=row.current_stage,
            run_version=row.run_version,
            goal_version=row.goal_version,
            graph_version=row.graph_version,
            config_snapshot_id=row.config_snapshot_id,
            document_revision=row.document_revision,
            waiting_request_id=row.waiting_request_id,
            waiting_approval_id=row.waiting_approval_id,
            paused_from_status=RunStatus(row.paused_from_status) if row.paused_from_status else None,
            last_error=row.last_error,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    def create_run(self, run: AgentRun) -> AgentRun:
        with self.sessions.begin() as session:
            session.add(AgentRunRow(
                id=run.id,
                project_id=run.project_id,
                document_id=run.document_id,
                user_id=run.user_id,
                status=run.status.value,
                current_stage=run.current_stage.value,
                run_version=run.run_version,
                goal_version=run.goal_version,
                graph_version=run.graph_version,
                config_snapshot_id=run.config_snapshot_id,
                document_revision=run.document_revision,
                waiting_request_id=run.waiting_request_id,
                waiting_approval_id=run.waiting_approval_id,
                paused_from_status=run.paused_from_status.value if run.paused_from_status else None,
                last_error=run.last_error,
                created_at=run.created_at,
                updated_at=run.updated_at,
            ))
        self.append_event(run.id, EventType.RUN_CREATED, {"status": run.status.value})
        return run

    def get_run(self, run_id: str) -> AgentRun:
        with self.sessions() as session:
            row = session.get(AgentRunRow, run_id)
            if row is None:
                raise KeyError(f"Run not found: {run_id}")
            return self._run(row)

    def list_runs(
        self,
        *,
        project_id: str | None = None,
        user_id: str | None = None,
        active_only: bool = False,
    ) -> list[AgentRun]:
        with self.sessions() as session:
            query = select(AgentRunRow).order_by(AgentRunRow.updated_at.desc())
            if project_id is not None:
                query = query.where(AgentRunRow.project_id == project_id)
            if user_id is not None:
                query = query.where(AgentRunRow.user_id == user_id)
            if active_only:
                query = query.where(AgentRunRow.status.not_in([item.value for item in (RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.CANCELLED)]))
            return [self._run(row) for row in session.scalars(query)]

    def update_run(self, run: AgentRun) -> AgentRun:
        run.updated_at = utc_now()
        with self.sessions.begin() as session:
            row = session.get(AgentRunRow, run.id)
            if row is None:
                raise KeyError(run.id)
            row.project_id = run.project_id
            row.document_id = run.document_id
            row.user_id = run.user_id
            row.status = run.status.value
            row.current_stage = run.current_stage.value
            if run.run_version != row.run_version:
                raise ValueError(
                    f"Run version conflict for {run.id}: expected {run.run_version}, current {row.run_version}"
                )
            run.run_version = row.run_version + 1
            row.run_version = run.run_version
            row.goal_version = run.goal_version
            row.graph_version = run.graph_version
            row.config_snapshot_id = run.config_snapshot_id
            row.document_revision = run.document_revision
            row.waiting_request_id = run.waiting_request_id
            row.waiting_approval_id = run.waiting_approval_id
            row.paused_from_status = run.paused_from_status.value if run.paused_from_status else None
            row.last_error = deepcopy(run.last_error)
            row.updated_at = run.updated_at
        return run

    def transition(self, run_id: str, target: RunStatus) -> AgentRun:
        run = self.get_run(run_id)
        assert_transition(run.status, target)
        run.status = target
        return self.update_run(run)

    def append_event(
        self,
        run_id: str,
        event_type: EventType,
        payload: dict[str, Any],
        *,
        actor: str = "system",
        correlation_id: str | None = None,
    ) -> AgentEvent:
        with self.sessions.begin() as session:
            # Lock the owning Run on PostgreSQL so concurrent workers cannot
            # allocate the same per-Run event sequence number. SQLite ignores
            # FOR UPDATE but serializes the write transaction itself.
            session.execute(
                select(AgentRunRow.id).where(AgentRunRow.id == run_id).with_for_update()
            ).scalar_one_or_none()
            sequence = session.scalar(
                select(func.max(AgentEventRow.sequence_number)).where(AgentEventRow.run_id == run_id)
            ) or 0
            previous_event_id = session.scalar(
                select(AgentEventRow.id)
                .where(AgentEventRow.run_id == run_id)
                .order_by(AgentEventRow.sequence_number.desc())
                .limit(1)
            )
            event = AgentEvent(
                event_id=new_id("evt"),
                run_id=run_id,
                sequence_number=int(sequence) + 1,
                event_type=event_type,
                actor=actor,
                correlation_id=correlation_id or run_id,
                causation_id=str(previous_event_id) if previous_event_id else None,
                payload=deepcopy(payload),
            )
            session.add(AgentEventRow(
                id=event.event_id,
                run_id=event.run_id,
                sequence_number=event.sequence_number,
                event_type=event.event_type.value,
                actor=event.actor,
                correlation_id=event.correlation_id,
                causation_id=event.causation_id,
                schema_version=event.schema_version,
                payload=event.payload,
                occurred_at=event.occurred_at,
            ))
            return event

    def list_events(self, run_id: str) -> list[AgentEvent]:
        with self.sessions() as session:
            rows = session.scalars(
                select(AgentEventRow).where(AgentEventRow.run_id == run_id).order_by(AgentEventRow.sequence_number)
            )
            return [AgentEvent(
                event_id=row.id,
                run_id=row.run_id,
                sequence_number=row.sequence_number,
                event_type=EventType(row.event_type),
                actor=row.actor,
                correlation_id=row.correlation_id,
                causation_id=row.causation_id,
                schema_version=row.schema_version,
                payload=row.payload or {},
                occurred_at=row.occurred_at,
            ) for row in rows]

    def save_config_snapshot(self, snapshot: ConfigSnapshot) -> ConfigSnapshot:
        with self.sessions.begin() as session:
            row = session.get(AgentConfigSnapshotRow, snapshot.snapshot_id)
            if row is None:
                session.add(AgentConfigSnapshotRow(
                    id=snapshot.snapshot_id,
                    graph_version=snapshot.graph_version,
                    tool_registry_version=snapshot.tool_registry_version,
                    policy_version=snapshot.policy_version,
                    settings=deepcopy(snapshot.settings),
                    created_at=snapshot.created_at,
                ))
        return snapshot

    def get_config_snapshot(self, snapshot_id: str) -> ConfigSnapshot:
        with self.sessions() as session:
            row = session.get(AgentConfigSnapshotRow, snapshot_id)
            if row is None:
                raise KeyError(f"Config snapshot not found: {snapshot_id}")
            return ConfigSnapshot(
                snapshot_id=row.id,
                graph_version=row.graph_version,
                tool_registry_version=row.tool_registry_version,
                policy_version=row.policy_version,
                settings=row.settings or {},
                created_at=row.created_at,
            )

    def save_goal(self, run_id: str, version: int, goal: dict[str, Any]) -> None:
        with self.sessions.begin() as session:
            row = session.scalar(select(AgentGoalRow).where(AgentGoalRow.run_id == run_id, AgentGoalRow.version == version))
            if row is None:
                session.add(AgentGoalRow(run_id=run_id, version=version, goal=deepcopy(goal), created_at=utc_now()))
            else:
                row.goal = deepcopy(goal)

    def get_goal(self, run_id: str, version: int) -> dict[str, Any] | None:
        with self.sessions() as session:
            row = session.scalar(select(AgentGoalRow).where(AgentGoalRow.run_id == run_id, AgentGoalRow.version == version))
            return deepcopy(row.goal) if row is not None else None

    @staticmethod
    def _action(row: AgentActionRow) -> ActionRequest:
        return ActionRequest.model_validate({
            "action_id": row.id,
            "run_id": row.run_id,
            "tool_name": row.tool_name,
            "tool_version": row.tool_version,
            "arguments": row.arguments,
            "side_effect": row.side_effect,
            "risk_level": row.risk_level,
            "expected_document_revision": row.expected_document_revision,
            "idempotency_key": row.idempotency_key,
            "reason": row.reason,
            "success_criteria": row.success_criteria or [],
            "action_hash": row.action_hash,
            "status": row.status,
            "created_at": row.created_at,
        })

    def save_action(self, action: ActionRequest) -> ActionRequest:
        with self.sessions.begin() as session:
            row = session.get(AgentActionRow, action.action_id)
            values = action.model_dump(mode="json")
            if row is None:
                session.add(AgentActionRow(
                    id=action.action_id,
                    run_id=action.run_id,
                    tool_name=action.tool_name,
                    tool_version=action.tool_version,
                    arguments=values["arguments"],
                    side_effect=values["side_effect"],
                    risk_level=values["risk_level"],
                    expected_document_revision=action.expected_document_revision,
                    idempotency_key=action.idempotency_key,
                    reason=action.reason,
                    success_criteria=action.success_criteria,
                    action_hash=action.action_hash,
                    status=values["status"],
                    created_at=action.created_at,
                ))
            else:
                row.status = values["status"]
                row.arguments = values["arguments"]
        return action

    def list_actions(self, run_id: str) -> list[ActionRequest]:
        with self.sessions() as session:
            rows = session.scalars(
                select(AgentActionRow).where(AgentActionRow.run_id == run_id).order_by(AgentActionRow.created_at)
            )
            return [self._action(row) for row in rows]

    def get_action(self, action_id: str) -> ActionRequest:
        with self.sessions() as session:
            row = session.get(AgentActionRow, action_id)
            if row is None:
                raise KeyError(action_id)
            return self._action(row)

    def save_approval(self, approval: ApprovalRequest) -> ApprovalRequest:
        with self.sessions.begin() as session:
            row = session.get(AgentApprovalRow, approval.approval_id)
            values = approval.model_dump(mode="json")
            if row is None:
                session.add(AgentApprovalRow(
                    id=approval.approval_id,
                    run_id=approval.run_id,
                    action_id=approval.action_id,
                    action_hash=approval.action_hash,
                    summary=approval.summary,
                    impact=approval.impact,
                    expires_at=approval.expires_at,
                    allowed_decisions=values["allowed_decisions"],
                    decision=values["decision"],
                    decision_payload=approval.decision_payload,
                ))
            else:
                row.decision = values["decision"]
                row.decision_payload = approval.decision_payload
        return approval

    def list_approvals(self, run_id: str) -> list[ApprovalRequest]:
        with self.sessions() as session:
            rows = session.scalars(
                select(AgentApprovalRow).where(AgentApprovalRow.run_id == run_id).order_by(AgentApprovalRow.id)
            )
            return [self.get_approval(row.id) for row in rows]

    def get_approval(self, approval_id: str) -> ApprovalRequest:
        with self.sessions() as session:
            row = session.get(AgentApprovalRow, approval_id)
            if row is None:
                raise KeyError(approval_id)
            expires_at = row.expires_at
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            return ApprovalRequest.model_validate({
                "approval_id": row.id,
                "run_id": row.run_id,
                "action_id": row.action_id,
                "action_hash": row.action_hash,
                "summary": row.summary,
                "impact": row.impact or [],
                "expires_at": expires_at,
                "allowed_decisions": row.allowed_decisions or [],
                "decision": row.decision,
                "decision_payload": row.decision_payload or {},
            })

    def save_question(self, question: ElicitationRequest) -> ElicitationRequest:
        with self.sessions.begin() as session:
            session.merge(AgentQuestionRow(
                id=question.request_id,
                run_id=question.run_id,
                reason_code=question.reason_code,
                question=question.question,
                expected_schema=question.expected_schema,
                choices=question.choices,
                current_value=question.current_value,
                recommended_value=question.recommended_value,
            ))
        return question

    def get_question(self, request_id: str) -> ElicitationRequest:
        with self.sessions() as session:
            row = session.get(AgentQuestionRow, request_id)
            if row is None:
                raise KeyError(request_id)
            return ElicitationRequest(
                request_id=row.id,
                run_id=row.run_id,
                reason_code=row.reason_code,
                question=row.question,
                expected_schema=row.expected_schema,
                choices=row.choices,
                current_value=row.current_value,
                recommended_value=row.recommended_value,
            )

    def save_idempotent(self, key: str, value: dict[str, Any]) -> None:
        with self.sessions.begin() as session:
            session.merge(AgentIdempotencyRow(key=key, observation=deepcopy(value), created_at=utc_now()))

    def get_idempotent(self, key: str) -> dict[str, Any] | None:
        with self.sessions() as session:
            row = session.get(AgentIdempotencyRow, key)
            return deepcopy(row.observation) if row is not None else None