"""Deterministic natural-language command parsing for the CLI entry point."""

from .parser import ParsedCommand, parse_command

__all__ = ["ParsedCommand", "parse_command"]
