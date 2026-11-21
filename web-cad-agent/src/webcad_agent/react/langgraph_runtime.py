from __future__ import annotations

from dataclasses import asdict
import os
from collections import defaultdict
import base64
from pathlib import Path
from time import monotonic
from typing import Any, Awaitable, Callable

from .loop import ReactBudget, ReactDecision


class LangGraphUnavailable(RuntimeError):
    pass


class DurableMemorySaver:
    """Small local-file checkpointer for optional LangGraph deployments.

    LangGraph's production database checkpointers remain injectable.  This
    adapter makes the standalone CLI durable without adding a database driver
    to the base install; the file uses LangGraph's JSON/msgpack serializer and
    is written atomically after every checkpoint mutation.
    """

    def __new__(cls, path: str | os.PathLike[str]):
        try:
            from langgraph.checkpoint.memory import MemorySaver
            from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
        except ImportError as exc:  # pragma: no cover - guarded by caller
            raise LangGraphUnavailable("Install the 'agent' extra to use LangGraph runtime") from exc

        class _Durable(MemorySaver):
            def __init__(self, checkpoint_path: str | os.PathLike[str]) -> None:
                super().__init__()
                self._checkpoint_path = Path(checkpoint_path)
                self._serializer = JsonPlusSerializer(pickle_fallback=False)
                self._load()

            def _load(self) -> None:
                if not self._checkpoint_path.exists():
                    return
                try:
                    import json
                    payload = json.loads(self._checkpoint_path.read_text(encoding="utf-8"))
                    raw = base64.b64decode(payload["data"].encode("ascii"))
                    decoded = self._serializer.loads_typed((payload["type"], raw))
                    if isinstance(decoded, dict) and {"storage", "writes", "blobs"} <= set(decoded):
                        self.storage = defaultdict(lambda: defaultdict(dict))
                        for thread_id, namespaces in decoded["storage"].items():
                            self.storage[thread_id] = defaultdict(dict, namespaces)
                        self.writes = defaultdict(dict, decoded["writes"])
                        self.blobs = decoded["blobs"]
                except (OSError, EOFError, ValueError, KeyError, TypeError):
                    # A corrupt checkpoint must not make the CAD runtime start
                    # with an arbitrary state; the graph will create a fresh one.
                    return

            def _save(self) -> None:
                self._checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self._checkpoint_path.with_suffix(self._checkpoint_path.suffix + ".tmp")
                storage = {thread_id: dict(namespaces) for thread_id, namespaces in self.storage.items()}
                writes = dict(self.writes)
                import json
                type_name, raw = self._serializer.dumps_typed({"storage": storage, "writes": writes,
                                                               "blobs": dict(self.blobs)})
                temporary.write_text(json.dumps({"version": 1, "type": type_name,
                                                 "data": base64.b64encode(raw).decode("ascii")},
                                                separators=(",", ":")), encoding="utf-8")
                os.replace(temporary, self._checkpoint_path)

            def put(self, *args, **kwargs):
                result = super().put(*args, **kwargs)
                self._save()
                return result

            def put_writes(self, *args, **kwargs):
                result = super().put_writes(*args, **kwargs)
                self._save()
                return result

            async def aput(self, *args, **kwargs):
                result = await super().aput(*args, **kwargs)
                self._save()
                return result

            async def aput_writes(self, *args, **kwargs):
                result = await super().aput_writes(*args, **kwargs)
                self._save()
                return result

            def delete_thread(self, *args, **kwargs):
                result = super().delete_thread(*args, **kwargs)
                self._save()
                return result

            async def adelete_thread(self, *args, **kwargs):
                result = await super().adelete_thread(*args, **kwargs)
                self._save()
                return result

        return _Durable(path)


class LangGraphReAct:
    """Optional LangGraph StateGraph implementation of the bounded ReAct subgraph.

    The domain/application layer still owns policy and verification. LangGraph
    only supplies node routing and a thread-scoped checkpoint; it cannot create
    an approval or call the Gateway directly.
    """

    def __init__(self, *, decide: Callable[[list[dict[str, Any]]], Awaitable[ReactDecision]],
                 act: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
                 observe: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
                 verify: Callable[[dict[str, Any]], Awaitable[bool]],
                 allowed_tools: set[str], write_tools: set[str] | None = None,
                 budget: ReactBudget | None = None, checkpointer: Any | None = None,
                 checkpoint_path: str | os.PathLike[str] | None = None) -> None:
        try:
            from langgraph.checkpoint.memory import MemorySaver
            from langgraph.graph import END, START, StateGraph
        except ImportError as exc:
            raise LangGraphUnavailable("Install the 'agent' extra to use LangGraph runtime") from exc
        self._END, self._START, self._StateGraph = END, START, StateGraph
        self.decide, self.act, self.observe, self.verify = decide, act, observe, verify
        self.allowed_tools = allowed_tools
        self.write_tools = write_tools or set()
        self.budget = budget or ReactBudget()
        self.checkpointer = checkpointer or (DurableMemorySaver(checkpoint_path) if checkpoint_path else MemorySaver())
        self._graph = self._build()

    def _build(self):
        graph = self._StateGraph(dict)
        graph.add_node("decide", self._decide_node)
        graph.add_node("act", self._act_node)
        graph.add_node("observe", self._observe_node)
        graph.add_node("verify", self._verify_node)
        graph.add_edge(self._START, "decide")
        graph.add_conditional_edges("decide", self._after_decide, {"act": "act", "end": self._END})
        graph.add_edge("act", "observe")
        graph.add_edge("observe", "verify")
        graph.add_conditional_edges("verify", self._after_verify, {"decide": "decide", "end": self._END})
        return graph.compile(checkpointer=self.checkpointer)

    async def _decide_node(self, state: dict[str, Any]) -> dict[str, Any]:
        trace = list(state.get("trace", []))
        decision = await self.decide(trace)
        trace.append({"stage": "decide", "step": state.get("steps", 0), "decision": asdict(decision)})
        return {"decision": asdict(decision), "trace": trace, "steps": int(state.get("steps", 0)) + 1}

    def _after_decide(self, state: dict[str, Any]) -> str:
        decision = state.get("decision") or {}
        if decision.get("kind") == "act" and decision.get("tool_name"):
            return "act"
        return "end"

    async def _act_node(self, state: dict[str, Any]) -> dict[str, Any]:
        decision = state.get("decision") or {}
        tool_name = decision.get("tool_name")
        trace = list(state.get("trace", []))
        if tool_name not in self.allowed_tools:
            return {"status": "stopped", "stop_reason": "tool_not_allowed", "trace": trace}
        calls = int(state.get("tool_calls", 0)) + 1
        writes = int(state.get("write_calls", 0)) + (1 if tool_name in self.write_tools else 0)
        if calls > self.budget.max_tool_calls or writes > self.budget.max_write_actions:
            return {"status": "stopped", "stop_reason": "tool_budget", "trace": trace}
        result = await self.act(tool_name, decision.get("arguments") or {})
        trace.append({"stage": "act", "tool": tool_name, "result": result})
        return {"tool_result": result, "tool_calls": calls, "write_calls": writes, "trace": trace}

    async def _observe_node(self, state: dict[str, Any]) -> dict[str, Any]:
        observed = await self.observe(state.get("tool_result") or {})
        trace = list(state.get("trace", [])); trace.append({"stage": "observe", "data": observed})
        return {"observed": observed, "trace": trace}

    async def _verify_node(self, state: dict[str, Any]) -> dict[str, Any]:
        trace = list(state.get("trace", []))
        if await self.verify(state.get("observed") or {}):
            trace.append({"stage": "verify", "passed": True})
            return {"status": "completed", "stop_reason": "verification_passed", "trace": trace}
        if int(state.get("steps", 0)) >= self.budget.max_steps:
            return {"status": "stopped", "stop_reason": "step_budget", "trace": trace}
        trace.append({"stage": "verify", "passed": False})
        return {"trace": trace}

    def _after_verify(self, state: dict[str, Any]) -> str:
        if state.get("status") in {"completed", "stopped", "clarify", "replan"}:
            return "end"
        return "decide"

    async def run(self, initial: dict[str, Any], *, thread_id: str) -> dict[str, Any]:
        started = monotonic()
        result = await self._graph.ainvoke(
            {**initial, "trace": [{"stage": "input", "data": initial}], "started_at": started},
            config={"configurable": {"thread_id": thread_id}},
        )
        if monotonic() - started > self.budget.wall_clock_seconds and result.get("status") is None:
            result["status"] = "stopped"; result["stop_reason"] = "wall_clock_budget"
        return result
