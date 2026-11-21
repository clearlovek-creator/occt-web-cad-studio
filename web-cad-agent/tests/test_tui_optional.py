from __future__ import annotations

import pytest

textual = pytest.importorskip("textual")

from webcad_agent.adapters.fake_geometry import FakeGeometryAdapter  # noqa: E402
from webcad_agent.adapters.json_store import JsonStore  # noqa: E402
from webcad_agent.application.service import AgentApplication  # noqa: E402
from webcad_agent.ui.tui_app import run_tui  # noqa: E402


@pytest.mark.asyncio
async def test_textual_pilot_renders_narrow_layout_and_help(tmp_path) -> None:
    app_service = AgentApplication(store=JsonStore(tmp_path / "state.json"), geometry=FakeGeometryAdapter())
    session = app_service.create_session(document_id="tui-test", gateway_origin="fake")
    tui = run_tui(app=app_service, session_id=session.session_id, run=False)
    async with tui.run_test(size=(80, 24)) as pilot:
        await pilot.press("/")
        await pilot.press("h", "e", "l", "p", "enter")
        assert tui.query_one("#log") is not None
        assert tui.query_one("#sessions").display is False
