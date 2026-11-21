from __future__ import annotations

import json

from .controller import TuiController
from .deep_link import viewer_url


def run_tui(*args, **kwargs) -> object:
    """Optional Textual shell; the core Agent remains usable without Textual installed."""
    try:
        from textual.app import App, ComposeResult
        from textual.containers import Horizontal, Vertical
        from textual.screen import ModalScreen
        from textual.widgets import Button, Footer, Header, Input, Label, RichLog, Static
    except ImportError as exc:
        raise RuntimeError("TUI requires the optional 'textual' dependency") from exc

    application = kwargs.get("app") or (args[0] if args else None)
    session_id = kwargs.get("session_id") or (args[1] if len(args) > 1 else None)
    controller = TuiController()
    command_names = ["/help", "/summary", "/view", "/properties", "/measure", "/relation", "/status", "/sessions",
                     "/runs", "/compact", "/approve", "/answer", "/undo", "/redo", "/open-viewer", "/events", "/exit"]

    class ApprovalModal(ModalScreen[bool]):
        CSS = """
        ApprovalModal { align: center middle; }
        #approval-box { width: 70; height: auto; padding: 1 2; border: thick $accent; background: $surface; }
        #approval-actions { height: auto; align: right middle; }
        #approval-actions Button { margin-left: 1; }
        """

        def __init__(self, summary: str) -> None:
            super().__init__()
            self.summary = summary

        def compose(self) -> ComposeResult:
            with Vertical(id="approval-box"):
                yield Label("Approval required")
                yield Static(self.summary)
                with Horizontal(id="approval-actions"):
                    yield Button("Approve", variant="success", id="approve")
                    yield Button("Reject", variant="error", id="reject")

        def on_button_pressed(self, event: Button.Pressed) -> None:
            self.dismiss(event.button.id == "approve")

    class WebCadTui(App):
        CSS = """
        Screen { layout: vertical; }
        #main { height: 1fr; layout: horizontal; }
        #sessions { width: 25%; border: solid $accent; }
        #log { width: 50%; border: solid $primary; }
        #inspector { width: 25%; border: solid $secondary; }
        #palette { dock: bottom; height: auto; max-height: 6; padding: 0 1; background: $panel; display: none; }
        #input { dock: bottom; }
        @media (max-width: 90) {
            #sessions { display: none; }
            #inspector { display: none; }
            #log { width: 100%; }
        }
        """

        def compose(self) -> ComposeResult:
            yield Header(show_clock=True)
            yield Static("Web CAD Agent · independent runtime")
            with Vertical(id="main"):
                yield RichLog(id="sessions", markup=False)
                yield RichLog(id="log", markup=False)
                yield RichLog(id="inspector", markup=False)
            yield Static("", id="palette")
            yield Input(placeholder="Type a command or /help", id="input")
            yield Footer()

        def on_mount(self) -> None:
            self.query_one("#log", RichLog).write("Ready. Runtime state is persisted before it is rendered.")
            self.query_one("#sessions", RichLog).write(f"Session: {session_id or 'not selected'}")
            if application is not None and session_id:
                for event in application.events(session_id=session_id)[-30:]:
                    self._render_event(event)
                session = application.get_session(session_id)
                if session:
                    self.query_one("#sessions", RichLog).write(
                        f"{session.title}\n{session.session_id}\ndocument={session.document_id}\nrevision={session.last_document_revision or 0}")
                application.event_bus.subscribe("*", self._render_event)

        def on_input_changed(self, event: Input.Changed) -> None:
            palette = self.query_one("#palette", Static)
            value = event.value.strip().lower()
            if not value.startswith("/"):
                palette.display = False
                return
            matches = [item for item in command_names if item.startswith(value)]
            palette.update("Command palette: " + "  ".join(matches[:8]))
            palette.display = bool(matches)

        def _write_result(self, result: object) -> None:
            self.query_one("#log", RichLog).write(str(result))
            if isinstance(result, dict) and result.get("status") == "approval_required":
                run = result.get("run") or {}
                run_id = run.get("run_id")
                if run_id:
                    summary = str((result.get("approval") or {}).get("summary") or "Review the proposed CAD write.")
                    self.push_screen(ApprovalModal(summary),
                                     lambda approved: self._approval_finished(approved, str(run_id)))

        def _approval_finished(self, approved: bool | None, run_id: str) -> None:
            if not approved or application is None:
                return
            self.run_worker(self._approve_run(run_id), exclusive=False)

        async def _approve_run(self, run_id: str) -> None:
            try:
                run = application.get_run(run_id)
                if run is None:
                    self._write_result({"status": "needs_clarification", "message": "Unknown run"})
                    return
                if run.active_plan_id:
                    result = await application.approve_plan(session_id=session_id, run_id=run_id,
                                                             plan_id=run.active_plan_id)
                else:
                    result = await application.approve(run_id)
                self._write_result(result)
            except Exception as exc:
                self._write_result({"status": "error", "error": str(exc)})

        async def on_input_submitted(self, event: Input.Submitted) -> None:
            value = event.value.strip()
            self.query_one("#palette", Static).display = False
            self.query_one("#log", RichLog).write(f"> {value}")
            event.input.value = ""
            if value in {"/exit", "/quit"}:
                self.exit()
                return
            if application is None or not session_id:
                return
            try:
                if value == "/summary":
                    result = await application.summary(session_id)
                elif value == "/view":
                    result = await application.view(session_id=session_id)
                elif value == "/properties":
                    result = await application.properties(session_id)
                elif value == "/sessions":
                    result = {"sessions": [item.model_dump(mode="json") for item in application.store.list_sessions()]}
                elif value == "/runs":
                    result = {"runs": [item.model_dump(mode="json") for item in application.list_runs(session_id=session_id)]}
                elif value == "/status":
                    session = application.get_session(session_id)
                    result = {"session": session.model_dump(mode="json") if session else None,
                              "run": application.get_run(session.active_run_id).model_dump(mode="json") if session and session.active_run_id and application.get_run(session.active_run_id) else None}
                elif value.startswith("/measure "):
                    result = await application.measure(session_id=session_id, reference=value.split(maxsplit=1)[1])
                elif value.startswith("/relation "):
                    parts = value.split()
                    result = (await application.relation(session_id=session_id, body_a=parts[1], body_b=parts[2])
                              if len(parts) >= 3 else {"status": "needs_clarification", "message": "Usage: /relation <bodyA> <bodyB>"})
                elif value in {"/undo", "/redo"}:
                    result = await application.history(session_id=session_id, direction=value[1:])
                elif value == "/open-viewer":
                    session = application.get_session(session_id)
                    result = {"url": viewer_url(document_id=session.document_id,
                                                 revision=session.last_document_revision)} if session else {"status": "needs_clarification"}
                elif value == "/compact":
                    result = application.compact_session(session_id)
                elif value.startswith("/approve"):
                    run_id = value.split(maxsplit=1)[1] if " " in value else None
                    run = application.get_run(run_id) if run_id else None
                    if run and run.active_plan_id:
                        result = await application.approve_plan(session_id=session_id, run_id=run.run_id, plan_id=run.active_plan_id)
                    elif run:
                        result = await application.approve(run.run_id)
                    else:
                        result = {"status": "needs_clarification", "message": "请提供 run_id"}
                elif value.startswith("/answer "):
                    parts = value.split(maxsplit=2)
                    if len(parts) != 3:
                        result = {"status": "needs_clarification", "message": "用法：/answer <request_id> <JSON>"}
                    else:
                        result = await application.answer_input_and_continue(
                            request_id=parts[1], answer=json.loads(parts[2]))
                elif value in {"/help", ""}:
                    result = {"commands": ["/summary", "/view", "/properties", "/measure <ref>", "/relation <bodyA> <bodyB>", "/status", "/sessions", "/runs", "/compact", "/approve <run_id>", "/answer <request_id> <JSON>", "/undo", "/redo", "/open-viewer", "/events", "/exit"]}
                elif value == "/events":
                    result = {"events": [event.model_dump(mode="json") for event in application.events(session_id=session_id)]}
                else:
                    result = await application.handle_prompt(session_id=session_id, text=value)
                self._write_result(result)
            except Exception as exc:
                self.query_one("#log", RichLog).write(f"error: {exc}")

        def _render_event(self, event) -> None:
            snapshot = controller.consume(event)
            self.call_from_thread(self.query_one("#log", RichLog).write,
                                  f"{snapshot.last_sequence:04d} {snapshot.phase}: {snapshot.inspector}")
            self.call_from_thread(self.query_one("#inspector", RichLog).write,
                                  json.dumps(snapshot.inspector, ensure_ascii=False, default=str))

    application_instance = WebCadTui()
    if kwargs.get("run", True):
        application_instance.run()
    return application_instance
