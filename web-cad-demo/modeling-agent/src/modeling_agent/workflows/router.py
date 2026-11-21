from __future__ import annotations

import re

from modeling_agent.domain.models import AgentRun, InputRoute, RiskLevel, RoutingDecision


class InputRouter:
    """Small deterministic front door; the workflow graph owns execution decisions."""

    version = "rules-2"

    def route(self, message: str, active_runs: list[AgentRun] | None = None) -> RoutingDecision:
        text = message.strip()
        active = active_runs or []
        if not text:
            return self._clarify("empty_input", confidence=1.0)
        lowered = text.lower()
        if lowered in {"批准", "同意", "确认", "approve", "approved"}:
            return self._targeted(InputRoute.APPROVAL_RESPONSE, active, "approval_target_required", {"decision": "approve"})
        if lowered in {"拒绝", "不同意", "否决", "reject", "rejected"}:
            return self._targeted(InputRoute.APPROVAL_RESPONSE, active, "approval_target_required", {"decision": "reject"})
        if any(word in lowered for word in ("停止", "取消", "中止", "cancel")):
            return self._targeted(InputRoute.CANCEL_RUN, active, "cancel_target_required")
        if len(active) == 1 and active[0].status.value in {"waiting_user", "waiting_external"}:
            return RoutingDecision(route=InputRoute.CONTINUE_ACTIVE_RUN, confidence=0.98, target_run_id=active[0].id, extracted_payload={"message": text}, router_version=self.version)
        if re.search(r"(当前|现在).*(模型|文档).*(多少|哪些|有什么|查询|查看|状态)", text):
            return RoutingDecision(route=InputRoute.READ_QUERY, confidence=0.9, extracted_payload={"query": text}, router_version=self.version)
        if re.search(r"(为什么|原理|理论|解释|什么是)", text):
            return RoutingDecision(route=InputRoute.DIRECT_ANSWER, confidence=0.9, extracted_payload={"question": text}, router_version=self.version)
        if (re.search(r"(\u4fee\u6539|\u8c03\u6574|\u53d8\u66f4|\u6539\u6210|\u6362\u6210).*(\u9891\u7387|\u53c2\u6570|\u5c3a\u5bf8|\u5bbd\u5ea6|\u957f\u5ea6|\u539a\u5ea6)", text) or re.search(r"(\u9891\u7387|\u53c2\u6570|\u5c3a\u5bf8|\u5bbd\u5ea6|\u957f\u5ea6|\u539a\u5ea6).*(\u4fee\u6539|\u8c03\u6574|\u53d8\u66f4|\u6539\u6210|\u6362\u6210)", text)) and active:
            if len(active) != 1:
                return self._clarify("multiple_active_runs", confidence=0.55, candidates=[InputRoute.CHANGE_ACTIVE_GOAL.value, InputRoute.CONTINUE_ACTIVE_RUN.value])
            return RoutingDecision(route=InputRoute.CHANGE_ACTIVE_GOAL, confidence=0.82, target_run_id=active[0].id, extracted_payload={"message": text}, risk_hint=RiskLevel.MEDIUM, router_version=self.version)
        if re.search(r"(创建|生成|建模|设计|做一个|帮我做)", text):
            return RoutingDecision(route=InputRoute.START_WORKFLOW, confidence=0.92, extracted_payload={"message": text}, required_capabilities=["theory.analysis", "geometry.create_box"], risk_hint=RiskLevel.MEDIUM, router_version=self.version)
        return self._clarify("route_not_confident")

    def _targeted(self, route: InputRoute, active: list[AgentRun], reason: str, payload: dict | None = None) -> RoutingDecision:
        if len(active) == 1:
            return RoutingDecision(route=route, confidence=1.0, target_run_id=active[0].id, extracted_payload=payload or {}, risk_hint=RiskLevel.MEDIUM, router_version=self.version)
        return self._clarify(reason, candidates=[route.value])

    def _clarify(self, reason: str, *, confidence: float = 0.0, candidates: list[str] | None = None) -> RoutingDecision:
        if candidates is None:
            candidates = [
                InputRoute.START_WORKFLOW.value,
                InputRoute.CONTINUE_ACTIVE_RUN.value,
                InputRoute.CHANGE_ACTIVE_GOAL.value,
                InputRoute.READ_QUERY.value,
                InputRoute.DIRECT_ANSWER.value,
            ]
        return RoutingDecision(
            route=InputRoute.CLARIFY_ROUTE,
            confidence=confidence,
            reason_codes=[reason],
            candidate_routes=candidates,
            router_version=self.version,
        )
