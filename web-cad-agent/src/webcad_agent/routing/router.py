from __future__ import annotations

import re

from ..domain.models import RiskLevel, RouteDecision


class IntentRouter:
    """Deterministic first-pass router; an LLM may later fill only ambiguous fields."""

    _control = re.compile(r"^/(?:help|status|summary|tree|history|plan|details|compact|approve|reject|edit|undo|redo|runs|sessions|session|resume|pause|cancel|mode|config|new|open-viewer|exit|quit)\b", re.I)
    _read = re.compile(r"(?:查看|查询|测量|检查|有哪些|体积|尺寸|当前模型|summary|measure|check|list|what|show)", re.I)
    _write = re.compile(r"(?:创建|新建|生成|添加|移动|平移|旋转|镜像|缩放|布尔|相交|相减|切除|圆柱|长方体|box|cylinder|create|translate|rotate|cut|fuse)", re.I)

    def route(self, text: str, *, pending_run_id: str | None = None) -> RouteDecision:
        value = text.strip()
        if self._control.match(value):
            return RouteDecision(path="control", confidence=1.0, target_run_id=pending_run_id, reason_codes=["slash_command"])
        if self._write.search(value):
            return RouteDecision(path="execute", needs_cad_context=True, confidence=0.84,
                                 target_run_id=pending_run_id, risk_hint=RiskLevel.MEDIUM, reason_codes=["cad_mutation_intent"])
        if self._read.search(value):
            return RouteDecision(path="read", needs_cad_context=True, confidence=0.88, reason_codes=["cad_query_intent"])
        return RouteDecision(path="read", needs_cad_context=False, confidence=0.45, reason_codes=["general_question"])
