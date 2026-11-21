from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    description: str
    run: Callable[[], Awaitable[bool]]


@dataclass(frozen=True)
class EvalResult:
    case_id: str
    passed: bool
    error: str | None = None


async def run_cases(cases: list[EvalCase]) -> list[EvalResult]:
    results: list[EvalResult] = []
    for case in cases:
        try:
            results.append(EvalResult(case.case_id, bool(await case.run())))
        except Exception as exc:
            results.append(EvalResult(case.case_id, False, str(exc)))
    return results
