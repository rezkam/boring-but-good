#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
import unittest


SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("pplx", SCRIPT_DIR / "pplx.py")
assert SPEC and SPEC.loader
pplx = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pplx)


class AuthenticationError(Exception):
    pass


class ResponseParsingError(Exception):
    pass


class AuthRetryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_resolve_token = pplx.resolve_token
        self.original_get_chrome_token = pplx.get_chrome_token
        self.original_validate_token_live = pplx.validate_token_live
        self.original_eprint = pplx.eprint
        pplx.validate_token_live = lambda token: None
        pplx.eprint = lambda *parts: None

    def tearDown(self) -> None:
        pplx.resolve_token = self.original_resolve_token
        pplx.get_chrome_token = self.original_get_chrome_token
        pplx.validate_token_live = self.original_validate_token_live
        pplx.eprint = self.original_eprint

    @staticmethod
    def args(**overrides: object) -> argparse.Namespace:
        values = {
            "no_chrome": False,
            "token": None,
            "token_file": None,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_stale_env_token_falls_back_to_chrome_cookie(self) -> None:
        pplx.resolve_token = lambda args: ("stale", "PERPLEXITY_SESSION_TOKEN")
        pplx.get_chrome_token = lambda: ("fresh", None)
        pplx.validate_token_live = lambda token: (_ for _ in ()).throw(AuthenticationError("expired"))
        calls: list[str] = []

        def operation(token: str) -> str:
            calls.append(token)
            if token == "stale":
                raise AuthenticationError("expired")
            return "ok"

        result = pplx.run_with_auth_retry(self.args(), operation)

        self.assertEqual(result, "ok")
        self.assertEqual(calls, ["stale", "fresh"])

    def test_explicit_token_does_not_fall_back_to_chrome_cookie(self) -> None:
        pplx.resolve_token = lambda args: ("bad", "--token")
        pplx.get_chrome_token = lambda: ("fresh", None)
        pplx.validate_token_live = lambda token: (_ for _ in ()).throw(AuthenticationError("expired"))
        calls: list[str] = []

        def operation(token: str) -> str:
            calls.append(token)
            raise AuthenticationError("expired")

        with self.assertRaises(SystemExit) as raised:
            pplx.run_with_auth_retry(self.args(), operation)

        self.assertEqual(raised.exception.code, 3)
        self.assertEqual(calls, ["bad"])

    def test_no_chrome_disables_fallback(self) -> None:
        pplx.resolve_token = lambda args: ("stale", "PPLX_SESSION_TOKEN")
        pplx.get_chrome_token = lambda: ("fresh", None)
        pplx.validate_token_live = lambda token: (_ for _ in ()).throw(AuthenticationError("expired"))
        calls: list[str] = []

        def operation(token: str) -> str:
            calls.append(token)
            raise AuthenticationError("expired")

        with self.assertRaises(SystemExit) as raised:
            pplx.run_with_auth_retry(self.args(no_chrome=True), operation)

        self.assertEqual(raised.exception.code, 3)
        self.assertEqual(calls, ["stale"])

    def test_live_session_403_retries_same_token(self) -> None:
        pplx.resolve_token = lambda args: ("valid", "Browser Tools Chrome profile")
        pplx.validate_token_live = lambda token: None
        calls: list[str] = []

        def operation(token: str) -> str:
            calls.append(token)
            if len(calls) == 1:
                raise AuthenticationError("transient 403")
            return "ok"

        result = pplx.run_with_auth_retry(self.args(max_retries=2), operation)

        self.assertEqual(result, "ok")
        self.assertEqual(calls, ["valid", "valid"])

    def test_query_processing_failure_retries_same_token(self) -> None:
        pplx.resolve_token = lambda args: ("valid", "Browser Tools Chrome profile")
        calls: list[str] = []

        def operation(token: str) -> str:
            calls.append(token)
            if len(calls) == 1:
                raise ResponseParsingError("Failed to parse API response: Query processing failed")
            return "ok"

        result = pplx.run_with_auth_retry(self.args(max_retries=2), operation)

        self.assertEqual(result, "ok")
        self.assertEqual(calls, ["valid", "valid"])

    def test_query_processing_failure_with_invalid_env_token_falls_back(self) -> None:
        pplx.resolve_token = lambda args: ("stale", "PERPLEXITY_SESSION_TOKEN")
        pplx.get_chrome_token = lambda: ("fresh", None)

        def validate(token: str) -> None:
            if token == "stale":
                raise AuthenticationError("expired")

        pplx.validate_token_live = validate
        calls: list[str] = []

        def operation(token: str) -> str:
            calls.append(token)
            if token == "stale":
                raise ResponseParsingError("Failed to parse API response: Query processing failed")
            return "ok"

        result = pplx.run_with_auth_retry(self.args(max_retries=2), operation)

        self.assertEqual(result, "ok")
        self.assertEqual(calls, ["stale", "fresh"])


if __name__ == "__main__":
    unittest.main()
