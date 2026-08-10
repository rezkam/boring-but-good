#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["perplexity-webui-scraper[cli]>=1.0.2"]
# ///
from __future__ import annotations

import argparse
from collections.abc import Callable, Iterable
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
CHROME_TOKEN_SCRIPT = SCRIPT_DIR / "chrome-token.mjs"


class TokenValidationError(Exception):
    pass


def eprint(*parts: object) -> None:
    print(*parts, file=sys.stderr)


def die(message: str, code: int = 1) -> None:
    eprint(f"error: {message}")
    raise SystemExit(code)


def read_text_arg(parts: list[str] | None, default: str = "") -> str:
    if parts:
        if len(parts) == 1 and parts[0] == "-":
            return sys.stdin.read().strip()
        return " ".join(parts).strip()
    if not sys.stdin.isatty():
        return sys.stdin.read().strip()
    return default


def write_output(text: str, save_path: str | None) -> None:
    if save_path:
        path = Path(save_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    print(text)


def add_token_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token", help="Perplexity session token. Prefer Browser Tools or token files for routine use.")
    parser.add_argument("--token-file", help="File containing only the Perplexity session token.")
    parser.add_argument("--no-chrome", action="store_true", help="Do not try Browser Tools Chrome profile extraction.")


def get_chrome_token() -> tuple[str | None, str | None]:
    if not CHROME_TOKEN_SCRIPT.exists():
        return None, "chrome token helper is missing"
    try:
        proc = subprocess.run(
            ["node", str(CHROME_TOKEN_SCRIPT)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
    except FileNotFoundError:
        return None, "node is not installed"
    except subprocess.TimeoutExpired:
        return None, "chrome token extraction timed out"

    token = proc.stdout.strip()
    if proc.returncode == 0 and token:
        return token, None
    return None, (proc.stderr.strip() or "chrome token extraction failed")


def resolve_token(args: argparse.Namespace, required: bool = True) -> tuple[str | None, str | None]:
    if getattr(args, "token", None):
        return args.token.strip(), "--token"

    if getattr(args, "token_file", None):
        path = Path(args.token_file).expanduser()
        if not path.exists():
            if required:
                die(f"token file not found: {path}")
            return None, None
        token = path.read_text().strip()
        if token:
            return token, str(path)

    chrome_error = None
    if not getattr(args, "no_chrome", False):
        token, chrome_error = get_chrome_token()
        if token:
            return token, "Browser Tools Chrome profile"

    for name in ("PERPLEXITY_SESSION_TOKEN", "PPLX_SESSION_TOKEN"):
        token = os.environ.get(name, "").strip()
        if token:
            return token, name

    if required:
        detail = f" Browser Tools error: {chrome_error}." if chrome_error else ""
        die(
            "no Perplexity session token found. Use a Browser Tools synced Chrome profile, "
            "set PERPLEXITY_SESSION_TOKEN, use --token-file, log in to perplexity.ai in the Default Chrome profile, "
            f"or run token --wizard.{detail}"
        )
    return None, chrome_error


def is_authentication_error(exc: BaseException) -> bool:
    return exc.__class__.__name__ in ("AuthenticationError", "TokenValidationError")


def is_query_processing_error(exc: BaseException) -> bool:
    return exc.__class__.__name__ == "ResponseParsingError" and "Query processing failed" in str(exc)


def auth_retry_limit(args: argparse.Namespace) -> int:
    retries = getattr(args, "auth_retries", getattr(args, "max_retries", 0))
    try:
        return max(0, int(retries))
    except (TypeError, ValueError):
        return 0


def token_has_live_session(token: str) -> bool:
    try:
        validate_token_live(token)
        return True
    except Exception as exc:
        if is_authentication_error(exc):
            return False
        return True


def should_try_chrome_fallback(args: argparse.Namespace, source: str | None) -> bool:
    if getattr(args, "no_chrome", False):
        return False
    return source not in (None, "--token", "Browser Tools Chrome profile")


def chrome_fallback_token(
    args: argparse.Namespace,
    rejected_token: str | None,
    rejected_source: str | None,
) -> tuple[str | None, str | None]:
    if not should_try_chrome_fallback(args, rejected_source):
        return None, None

    token, error = get_chrome_token()
    if token and token != rejected_token:
        return token, None
    if token:
        return None, "Browser Tools returned the same rejected token"
    return None, error


def auth_failure_message(source: str | None, chrome_error: str | None = None) -> str:
    source_name = source or "configured token"
    hints = [
        f"Perplexity authentication failed for {source_name}; session token invalid or expired.",
    ]
    if source in ("PERPLEXITY_SESSION_TOKEN", "PPLX_SESSION_TOKEN"):
        hints.append(
            f"Unset or refresh {source}; Browser Tools Chrome profile is tried before environment tokens unless --no-chrome is used. "
            "For one command with only Browser Tools auth, run `env -u PERPLEXITY_SESSION_TOKEN -u PPLX_SESSION_TOKEN ...`."
        )
    elif source == "Browser Tools Chrome profile":
        hints.append("Log in to perplexity.ai in the selected Chrome profile, then retry. Use PPLX_BROWSER_TOOLS_SYNC=1 to force a fresh profile sync.")
    elif source == "--token":
        hints.append("Pass a fresh token, or omit --token to use Browser Tools Chrome profile auth.")
    else:
        hints.append("Refresh the configured token, or use Browser Tools with a logged-in Chrome profile.")

    if chrome_error:
        hints.append(f"Chrome fallback was not usable: {chrome_error}.")
    return " ".join(hints)


def die_authentication(source: str | None, chrome_error: str | None = None) -> None:
    die(auth_failure_message(source, chrome_error), code=3)


def try_authenticated_operation(
    args: argparse.Namespace,
    token: str,
    source: str | None,
    operation: Callable[[str], Any],
) -> tuple[bool, Any]:
    retries = auth_retry_limit(args)
    session_checked = False
    for attempt in range(retries + 1):
        try:
            return True, operation(token)
        except Exception as exc:
            if is_query_processing_error(exc):
                if not session_checked:
                    session_checked = True
                    if not token_has_live_session(token):
                        return False, None
                if attempt < retries:
                    eprint(
                        f"warning: Perplexity query processing failed for {source}; "
                        f"retrying request {attempt + 1}/{retries}"
                    )
                    continue
                raise
            if not is_authentication_error(exc):
                raise
            if not session_checked:
                session_checked = True
                if not token_has_live_session(token):
                    return False, None
            if attempt < retries:
                eprint(f"warning: Perplexity returned 403 for {source}; retrying authenticated request {attempt + 1}/{retries}")
                continue
            return False, None
    return False, None


def run_with_auth_retry(args: argparse.Namespace, operation: Callable[[str], Any]) -> Any:
    token, source = resolve_token(args)
    ok, result = try_authenticated_operation(args, token or "", source, operation)
    if ok:
        return result

    fallback_token, fallback_error = chrome_fallback_token(args, token, source)
    if fallback_token:
        eprint(f"warning: authentication failed for {source}; retrying with Browser Tools Chrome profile")
        ok, result = try_authenticated_operation(args, fallback_token, "Browser Tools Chrome profile", operation)
        if ok:
            return result
        die_authentication("Browser Tools Chrome profile")

    die_authentication(source, fallback_error)


def normalize_source_focus(values: list[str] | None) -> str | list[str]:
    if not values:
        return "web"
    return values[0] if len(values) == 1 else values


def allowed_models() -> list[Any]:
    try:
        from perplexity_webui_scraper import MODELS
    except Exception as exc:
        die(f"could not import perplexity-webui-scraper: {exc}")
    return [model for model in MODELS.list_all() if model.min_tier != "max"]


def resolve_allowed_model(model_id: str) -> Any:
    try:
        from perplexity_webui_scraper import MODELS
    except Exception as exc:
        die(f"could not import perplexity-webui-scraper: {exc}")

    try:
        model = MODELS.resolve(model_id)
    except ValueError:
        available = ", ".join(model.id for model in allowed_models())
        die(f"unknown model {model_id!r}. Available models: {available}")

    if model.min_tier == "max":
        available = ", ".join(model.id for model in allowed_models())
        die(f"model {model_id!r} requires Max tier and is not exposed by this skill. Available models: {available}")

    return model


def allowed_model_by_tool_name(tool_name: str) -> Any:
    for model in allowed_models():
        if model.tool_name == tool_name:
            return model

    available = ", ".join(model.tool_name for model in allowed_models())
    die(f"unknown tool {tool_name!r}. Available tools: {available}")


def add_conversation_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default="perplexity/best", help="Model ID. Run `models` to list valid IDs.")
    parser.add_argument("--system", help="Instruction text prepended to the first user query.")
    parser.add_argument("--file", action="append", default=[], help="Local file attachment. Repeatable.")
    parser.add_argument("--stream", action="store_true", help="Stream response deltas.")
    parser.add_argument("--citation-mode", choices=["clean", "markdown", "default"], default="clean")
    parser.add_argument("--search-focus", choices=["web", "writing"], default="web")
    parser.add_argument(
        "--source-focus",
        action="append",
        choices=["web", "academic", "social", "finance", "all"],
        help="Source filter. Repeat to pass a list.",
    )
    parser.add_argument("--time-range", choices=["all", "day", "week", "month", "year"], default="all")
    parser.add_argument("--language", default="en-US")
    parser.add_argument("--timezone")
    parser.add_argument("--latitude", type=float)
    parser.add_argument("--longitude", type=float)
    parser.add_argument("--space-uuid")
    parser.add_argument("--save-to-library", action="store_true")


def add_client_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--timeout", type=int, default=3600, help="Request timeout in seconds.")
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument(
        "--auth-retries",
        type=int,
        default=6,
        help="Retries for transient authenticated WebUI 403 and query-processing failures.",
    )
    parser.add_argument("--requests-per-second", type=float, default=0.5)
    parser.add_argument(
        "--logging-level",
        choices=["disabled", "debug", "info", "warning", "error", "critical"],
        default="disabled",
    )
    parser.add_argument("--log-file")


def source_dict(item: Any) -> dict[str, Any]:
    return {
        "title": getattr(item, "title", "") or "",
        "url": getattr(item, "url", "") or "",
        "snippet": getattr(item, "snippet", "") or "",
    }


def render_markdown(turns: list[dict[str, Any]]) -> str:
    blocks: list[str] = []
    multi = len(turns) > 1
    for index, turn in enumerate(turns, 1):
        if multi:
            blocks.append(f"## Turn {index}\n")
        blocks.append(turn.get("answer") or "")
        sources = turn.get("search_results") or []
        if sources:
            blocks.append("\n## Sources")
            for i, source in enumerate(sources, 1):
                title = source.get("title") or source.get("url") or f"Source {i}"
                url = source.get("url") or ""
                snippet = source.get("snippet") or ""
                line = f"{i}. [{title}]({url})" if url else f"{i}. {title}"
                if snippet:
                    line += f" - {snippet}"
                blocks.append(line)
        blocks.append("")
    return "\n".join(blocks).strip()


def stream_direct(conversation: Any, query: str, files: list[str] | None) -> None:
    last = ""
    conversation.ask(query, files=files or None, stream=True)
    for response in conversation:
        current = response.last_chunk or response.answer or ""
        if not current or current == last:
            continue
        prefix_len = 0
        max_len = min(len(last), len(current))
        while prefix_len < max_len and last[prefix_len] == current[prefix_len]:
            prefix_len += 1
        delta = current[prefix_len:]
        if delta:
            print(delta, end="", flush=True)
            last = current
    print()


def cmd_ask(args: argparse.Namespace) -> int:
    try:
        from perplexity_webui_scraper import ClientConfig, ConversationConfig, Coordinates, Perplexity
    except Exception as exc:
        die(f"could not import perplexity-webui-scraper. Run through `uv run scripts/pplx.py`: {exc}")

    resolve_allowed_model(args.model)

    if (args.latitude is None) != (args.longitude is None):
        die("pass both --latitude and --longitude, or neither")

    coordinates = None
    if args.latitude is not None and args.longitude is not None:
        coordinates = Coordinates(latitude=args.latitude, longitude=args.longitude)

    def make_conversation_config() -> ConversationConfig:
        return ConversationConfig(
            model=args.model,
            citation_mode=args.citation_mode,
            search_focus=args.search_focus,
            source_focus=normalize_source_focus(args.source_focus),
            time_range=args.time_range,
            save_to_library=args.save_to_library,
            language=args.language,
            timezone=args.timezone,
            coordinates=coordinates,
            space_uuid=args.space_uuid,
        )
    client_config = ClientConfig(
        timeout=args.timeout,
        max_retries=args.max_retries,
        requests_per_second=args.requests_per_second,
        logging_level=args.logging_level,
        log_file=args.log_file,
    )

    turns = args.turn[:] if args.turn else []
    if not turns:
        prompt = read_text_arg(args.query, default="Analyze the attached file or prompt.")
        if not prompt and not args.file:
            die("provide a query, stdin, --turn, or --file")
        turns = [prompt or "Analyze the attached file or prompt."]

    if args.system:
        turns[0] = f"[System]: {args.system}\n\n{turns[0]}"

    def execute(token: str) -> list[dict[str, Any]]:
        response_turns: list[dict[str, Any]] = []
        with Perplexity(token, config=client_config) as client:
            conversation = client.create_conversation(make_conversation_config())
            for index, prompt in enumerate(turns):
                files = args.file if index == 0 and args.file else None
                if args.stream and args.format == "answer":
                    stream_direct(conversation, prompt, files)
                else:
                    if args.stream:
                        conversation.ask(prompt, files=files or None, stream=True)
                        for _response in conversation:
                            pass
                    else:
                        conversation.ask(prompt, files=files or None)

                turn_data = {
                    "query": prompt,
                    "answer": conversation.answer or "",
                    "search_results": [source_dict(item) for item in conversation.search_results],
                    "conversation_uuid": conversation.uuid,
                }
                if args.include_raw:
                    turn_data["raw_data"] = getattr(conversation, "_raw_data", {})
                response_turns.append(turn_data)
        return response_turns

    response_turns = run_with_auth_retry(args, execute)

    payload = {
        "model": args.model,
        "config": {
            "citation_mode": args.citation_mode,
            "search_focus": args.search_focus,
            "source_focus": normalize_source_focus(args.source_focus),
            "time_range": args.time_range,
            "language": args.language,
            "timezone": args.timezone,
            "space_uuid": args.space_uuid,
            "save_to_library": args.save_to_library,
        },
        "turns": response_turns,
    }

    if args.format == "json":
        output = json.dumps(payload, ensure_ascii=False, indent=2)
    elif args.format == "answer":
        output = response_turns[-1].get("answer") or ""
    else:
        output = render_markdown(response_turns)

    if not (args.stream and args.format == "answer"):
        write_output(output, args.save)
    elif args.save:
        Path(args.save).expanduser().write_text(output)
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    items = [model.model_dump() for model in allowed_models()]

    if args.format == "json":
        print(json.dumps(items, ensure_ascii=False, indent=2))
        return 0

    for item in items:
        model_id = item.get("id", "")
        name = item.get("name", "")
        tier = item.get("min_tier", "")
        tool = item.get("tool_name", "")
        print(f"{model_id:45} {tier:5} {tool:28} {name}")
    return 0


def validate_token_live(token: str) -> None:
    try:
        from perplexity_webui_scraper.http.client import HTTPClient
    except Exception as exc:
        die(f"could not import perplexity-webui-scraper. Run through `uv run scripts/pplx.py`: {exc}")

    with HTTPClient(token, timeout=20, max_retries=0, requests_per_second=0) as http:
        response = http.get("/api/auth/session")

    try:
        data = response.json()
    except Exception as exc:
        raise TokenValidationError("auth session endpoint did not return JSON") from exc

    user = data.get("user") if isinstance(data, dict) else None
    if not isinstance(user, dict) or not user.get("id"):
        raise TokenValidationError("auth session endpoint did not return a logged-in user")


def cmd_token(args: argparse.Namespace) -> int:
    if args.wizard:
        cmd = [sys.executable, "-m", "perplexity_webui_scraper.cli", "get-session-token"]
        if args.email:
            cmd.append(args.email)
        return subprocess.call(cmd)

    token, source = resolve_token(args)
    if args.validate:
        try:
            validate_token_live(token or "")
        except Exception as exc:
            if not is_authentication_error(exc):
                raise
            fallback_token, fallback_error = chrome_fallback_token(args, token, source)
            if not fallback_token:
                die_authentication(source, fallback_error)
            eprint(f"warning: authentication failed for {source}; retrying with Browser Tools Chrome profile")
            try:
                validate_token_live(fallback_token)
            except Exception as retry_exc:
                if not is_authentication_error(retry_exc):
                    raise
                die_authentication("Browser Tools Chrome profile")
            token = fallback_token
            source = "Browser Tools Chrome profile"

    if args.show:
        print(token or "")
    elif args.validate:
        print(f"token valid from {source}; length={len(token or '')}")
    else:
        print(f"token available from {source}; length={len(token or '')}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Perplexity WebUI skill wrapper")
    sub = parser.add_subparsers(dest="command", required=True)

    models = sub.add_parser("models", help="List available models")
    models.add_argument("--format", choices=["table", "json"], default="table")
    models.set_defaults(func=cmd_models)

    token = sub.add_parser("token", help="Check, show, or generate a session token")
    add_token_args(token)
    token.add_argument("--show", action="store_true", help="Print the token. Only use when explicitly requested.")
    token.add_argument("--validate", action="store_true", help="Make a live read-only auth check without printing the token.")
    token.add_argument("--wizard", action="store_true", help="Run the interactive token wizard from the package.")
    token.add_argument("--email", help="Email passed to the token wizard.")
    token.set_defaults(func=cmd_token)

    ask = sub.add_parser("ask", help="Ask through the direct package client")
    add_token_args(ask)
    add_conversation_args(ask)
    add_client_args(ask)
    ask.add_argument("query", nargs="*", help="Question. Use '-' to read stdin.")
    ask.add_argument("--turn", action="append", default=[], help="Multi-turn prompt. Repeatable.")
    ask.add_argument("--format", choices=["answer", "markdown", "json"], default="markdown")
    ask.add_argument("--include-raw", action="store_true", help="Include parser raw data in JSON output.")
    ask.add_argument("--save", help="Save the printed output to a file.")
    ask.set_defaults(func=cmd_ask)

    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        eprint("interrupted")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
