"""Owned, loopback-only Python API fixture; no LLM configuration or live user data."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import threading
import inspect

parser = argparse.ArgumentParser()
parser.add_argument("--dependencies", required=True)
parser.add_argument("--package-root", required=True)
parser.add_argument("--data", required=True)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--gateway", default="")
parser.add_argument("--mode", choices=("local", "langgraph"), default="local")
args = parser.parse_args()
sys.path[:0] = [args.package_root, args.dependencies]

import uvicorn
from modeling_agent.api.app import create_app


async def main():
    directory = Path(args.data)
    app = create_app(data_path=str(directory/"agent.json"), workflow_mode=args.mode,
                     checkpoint_path=str(directory/"checkpoints.bin"), gateway_url=args.gateway or None)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port,
                                         log_level="warning", access_log=False))
    loop = asyncio.get_running_loop()

    def commands():
        for line in iter(lambda: sys.stdin.buffer.readline(1025), b""):
            try:
                value = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if value == {"stop": os.environ["CAD_TEST_PYTHON_STOP_TOKEN"]}:
                loop.call_soon_threadsafe(setattr, server, "should_exit", True)
                return

    threading.Thread(target=commands, daemon=True).start()

    async def ready():
        while not server.started and not server.should_exit:
            await asyncio.sleep(0.01)
        if server.started:
            print(json.dumps({"type": "python-test-ready", "port": args.port,
                              "packageOrigin": inspect.getfile(create_app)}), flush=True)

    monitor = asyncio.create_task(ready())
    try:
        await server.serve()
    finally:
        monitor.cancel()
        try:
            await monitor
        except asyncio.CancelledError:
            pass


asyncio.run(main())
