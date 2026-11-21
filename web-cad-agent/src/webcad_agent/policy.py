from __future__ import annotations

from dataclasses import dataclass

from .domain.models import ActionEnvelope, RiskLevel, SideEffect


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    requires_approval: bool
    reason: str


class PolicyEngine:
    def decide(self, action: ActionEnvelope, *, mode: str = "supervised") -> PolicyDecision:
        if action.side_effect == SideEffect.PURE or action.side_effect == SideEffect.READ:
            return PolicyDecision(True, False, "read_or_pure")
        if mode == "readonly":
            return PolicyDecision(False, False, "readonly_mode")
        if action.side_effect == SideEffect.DESTRUCTIVE or action.risk_level == RiskLevel.HIGH:
            return PolicyDecision(True, True, "high_risk_requires_approval")
        if mode == "auto" and action.risk_level == RiskLevel.LOW:
            return PolicyDecision(True, False, "low_risk_auto_allow")
        return PolicyDecision(True, True, "supervised_write_requires_approval")
