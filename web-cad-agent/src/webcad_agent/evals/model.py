from __future__ import annotations

import tempfile
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from ..adapters.fake_geometry import FakeGeometryAdapter
from ..adapters.json_store import JsonStore
from ..application.service import AgentApplication
from ..llm.http_model import HttpJsonModel


async def run_model_evals(*, endpoint: str, repetitions: int = 1,
                          model_factory: Callable[[str], Any] | None = None) -> dict[str, Any]:
    """Run opt-in model-backed smoke cases against a provider-neutral endpoint.

    The model is only asked for a structured AgentPlan; execution still uses the
    normal Registry, Policy, Approval and Verifier path against Fake Geometry.
    No model content is persisted in the returned report.
    """
    cases = [("MODEL-1", "Create a box with width 10 mm, depth 20 mm and height 30 mm.")]
    failures: list[dict[str, Any]] = []
    for repetition in range(max(1, int(repetitions))):
        for case_id, prompt in cases:
            model = (model_factory or HttpJsonModel)(endpoint)
            try:
                with tempfile.TemporaryDirectory() as temp:
                    app = AgentApplication(store=JsonStore(f"{temp}/state.json"),
                                           geometry=FakeGeometryAdapter(), model=model)
                    session = app.create_session(document_id=f"model-eval-{repetition}", gateway_origin="fake")
                    result = await app.handle_prompt(session_id=session.session_id, text=prompt,
                                                     approve=True, mode="supervised")
                    if result.get("status") != "completed" or not result.get("verification", {}).get("passed"):
                        failures.append({"case_id": case_id, "repetition": repetition,
                                         "status": result.get("status"), "reason": "verification_failed"})
            except Exception as exc:
                failures.append({"case_id": case_id, "repetition": repetition,
                                 "status": "error", "reason": type(exc).__name__})
            finally:
                await model.close()
    parsed = urlsplit(endpoint)
    safe_endpoint = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    return {"status": "passed" if not failures else "failed", "endpoint": safe_endpoint,
            "repetitions": max(1, int(repetitions)), "cases": len(cases), "failures": failures}
