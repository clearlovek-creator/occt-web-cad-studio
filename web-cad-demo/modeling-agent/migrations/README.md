# 第一阶段数据库迁移

生产环境使用 PostgreSQL，业务表模型位于：

src/modeling_agent/adapters/persistence/sqlalchemy_models.py

第一版迁移需要创建：

- agent_runs
- agent_goals
- agent_events
- agent_actions
- agent_approvals
- agent_questions
- agent_idempotency

LangGraph Checkpointer 使用独立的 checkpoint 表，不与业务事件表混用。

本地无 PostgreSQL 时可使用 JsonRepository 验证重启恢复；它不是团队/生产部署的替代品。

0003_agent_checkpoints.py: LangGraph Checkpoint database persistence, separate from business event tables.

0004_config_snapshots.py: immutable Graph/Tool/Policy configuration snapshots referenced by each Run.

0005_checkpoint_threads.py: per-thread LangGraph checkpoints; the legacy aggregate table remains a compatibility fallback.

0006_event_sequence_constraint.py: unique per-Run event sequence and row-lock allocation for concurrent workers.

0007_run_version.py: optimistic Run version used to reject late user responses and approvals.

0008_run_pause.py: persist safe-boundary pause/resume state for a Run.
