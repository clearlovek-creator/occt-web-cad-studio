from __future__ import annotations

import asyncio
import json
from typing import Any

from ..application.service import AgentApplication
from .deep_link import viewer_url


def run_repl(app: AgentApplication, *, session_id: str) -> None:
    print("Web CAD Agent · CLI session")
    print("Commands: /help, /summary, /view, /properties, /measure <ref>, /status, /sessions, /runs, /compact, /events, /approve <run_id>, /undo, /redo, /open-viewer, /exit")
    print("Natural language: Box, Cylinder, Cone, Sphere, Torus, hollow tube and translate prompts.")
    while True:
        try:
            text = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not text:
            continue
        if text in {"/exit", "/quit"}:
            return
        if text == "/help":
            print("/summary /view /properties /measure <body|feature> /status /sessions /runs /compact /events /approve <run_id> /undo /redo /open-viewer /exit")
            print("Natural language: create box/cylinder/cone/sphere/torus, hollow tube, translate.")
            continue
        if text == "/summary":
            print(asyncio.run(app.summary(session_id)))
            continue
        if text == "/view":
            print(asyncio.run(app.view(session_id=session_id)))
            continue
        if text == "/properties":
            print(asyncio.run(app.properties(session_id)))
            continue
        if text.startswith("/measure "):
            print(asyncio.run(app.measure(session_id=session_id, reference=text.split(maxsplit=1)[1])))
            continue
        if text == "/status":
            session = app.store.get_session(session_id)
            run = app.store.get_run(session.active_run_id) if session and session.active_run_id else None
            print({"session": session.model_dump(mode="json") if session else None, "run": run.model_dump(mode="json") if run else None})
            continue
        if text == "/sessions":
            print([item.model_dump(mode="json") for item in app.store.list_sessions()])
            continue
        if text == "/runs":
            print([item.model_dump(mode="json") for item in app.list_runs(session_id=session_id)])
            continue
        if text == "/compact":
            print(app.compact_session(session_id))
            continue
        if text == "/events":
            for event in app.store.list_events(session_id=session_id):
                print(f"{event.sequence_number:04d} {event.event_type}: {event.payload}")
            continue
        if text.startswith("/approve "):
            run_id = text.split(maxsplit=1)[1]
            run = app.store.get_run(run_id)
            if run and run.active_plan_id:
                print(asyncio.run(app.approve_plan(session_id=session_id, run_id=run_id, plan_id=run.active_plan_id)))
            else:
                print(asyncio.run(app.approve(run_id)))
            continue
        if text.startswith("/answer "):
            parts = text.split(maxsplit=2)
            if len(parts) != 3:
                print("用法：/answer <request_id> <JSON>")
            else:
                try:
                    print(asyncio.run(app.answer_input_and_continue(request_id=parts[1], answer=json.loads(parts[2]))))
                except Exception as exc:
                    print({"status": "failed", "error": str(exc)})
            continue
        if text == "/undo" or text == "/redo":
            print(asyncio.run(app.history(session_id=session_id, direction=text[1:])))
            continue
        if text == "/open-viewer":
            session = asyncio.run(app.open_session(session_id))
            print(viewer_url(document_id=session.document_id, revision=session.last_document_revision))
            continue
        try:
            result = asyncio.run(app.handle_prompt(session_id=session_id, text=text))
            print(result)
        except Exception as exc:
            print({"status": "failed", "error": str(exc)})
