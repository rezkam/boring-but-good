#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["perplexity-webui-scraper>=1.0.2"]
# ///
from __future__ import annotations

import argparse
from collections.abc import Iterable
import json
from pathlib import Path
import sys
from typing import Any

from pplx import (
    add_client_args,
    add_token_args,
    allowed_model_by_tool_name,
    die,
    read_text_arg,
    render_markdown,
    run_with_auth_retry,
    source_dict,
    write_output,
)


def infer_tool_name(argv: list[str]) -> tuple[str, list[str]]:
    invoked_as = Path(argv[0]).name
    if invoked_as.startswith("pplx_"):
        return invoked_as, argv[1:]
    if len(argv) < 2:
        die("provide a tool name or run one of the direct tool scripts, for example scripts/pplx_best")
    return argv[1], argv[2:]


def build_parser(tool_name: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=tool_name,
        description=f"Run the {tool_name} Perplexity tool.",
    )
    add_token_args(parser)
    add_client_args(parser)
    parser.add_argument("query", nargs="*", help="Question. Use '-' to read stdin.")
    parser.add_argument("--search-focus", choices=["web", "writing"], default="web")
    parser.add_argument("--source-focus", choices=["web", "academic", "social", "finance", "all"], default="web")
    parser.add_argument("--time-range", choices=["all", "day", "week", "month", "year"], default="all")
    parser.add_argument("--language", default="en-US")
    parser.add_argument("--latitude", type=float)
    parser.add_argument("--longitude", type=float)
    parser.add_argument("--format", choices=["json", "markdown", "answer"], default="json")
    parser.add_argument("--save", help="Save the printed output to a file.")
    return parser


def run_tool(tool_name: str, args: argparse.Namespace) -> int:
    try:
        from perplexity_webui_scraper import ClientConfig, ConversationConfig, Coordinates, Perplexity
    except Exception as exc:
        die(f"could not import perplexity-webui-scraper. Run through uv: {exc}")

    model = allowed_model_by_tool_name(tool_name)

    if (args.latitude is None) != (args.longitude is None):
        die("pass both --latitude and --longitude, or neither")

    coordinates = None
    if args.latitude is not None and args.longitude is not None:
        coordinates = Coordinates(latitude=args.latitude, longitude=args.longitude)

    query = read_text_arg(args.query)
    if not query:
        die("provide a query or '-' to read stdin")

    def make_conversation_config() -> ConversationConfig:
        return ConversationConfig(
            model=model.id,
            search_focus=args.search_focus,
            source_focus=args.source_focus,
            time_range=args.time_range,
            citation_mode="clean",
            language=args.language,
            coordinates=coordinates,
        )
    client_config = ClientConfig(
        timeout=args.timeout,
        max_retries=args.max_retries,
        requests_per_second=args.requests_per_second,
        logging_level=args.logging_level,
        log_file=args.log_file,
    )

    def execute(token: str) -> dict[str, Any]:
        with Perplexity(token, config=client_config) as client:
            conversation = client.create_conversation(make_conversation_config())
            conversation.ask(query)
            return {
                "answer": conversation.answer or "",
                "search_results": [source_dict(item) for item in conversation.search_results],
                "conversation_uuid": conversation.uuid,
            }

    result = run_with_auth_retry(args, execute)

    if args.format == "json":
        output = json.dumps(result, ensure_ascii=False, indent=2)
    elif args.format == "answer":
        output = result["answer"]
    else:
        output = render_markdown([{**result, "query": query}])

    write_output(output, args.save)
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    raw_argv = list(argv) if argv is not None else sys.argv
    tool_name, tool_args = infer_tool_name(raw_argv)
    parser = build_parser(tool_name)
    args = parser.parse_args(tool_args)
    return run_tool(tool_name, args)


if __name__ == "__main__":
    raise SystemExit(main())
