#!/usr/bin/env python3
"""
Convert markdown on stdin to Atlassian Document Format (ADF) JSON on stdout.

Supports the markdown subset that shows up in Jira ticket descriptions:
  - Headings (#, ##, ..., ######)
  - Paragraphs
  - Bullet lists (- or *) and ordered lists (1.)
  - Fenced code blocks (```lang ... ```)
  - Inline code (`x`), bold (**x**), italic (*x*), and links ([text](url))

Anything not in that subset becomes plain paragraph text. Intentionally minimal
so the conversion is predictable and easy to reason about; not a full CommonMark
implementation.

Reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
"""

import json
import re
import sys


_INLINE_PATTERN = re.compile(
    r"(?P<code>`[^`]+`)"
    r"|(?P<link>\[(?P<linktext>[^\]]+)\]\((?P<linkurl>[^)]+)\))"
    r"|(?P<bold>\*\*[^*]+\*\*)"
    r"|(?P<italic>(?<!\*)\*(?!\*)[^*\n]+\*(?!\*))"
)


def parse_inline(text):
    """Parse a single-line string into a list of ADF inline nodes."""
    nodes = []
    pos = 0
    while pos < len(text):
        m = _INLINE_PATTERN.search(text, pos)
        if not m:
            tail = text[pos:]
            if tail:
                nodes.append({"type": "text", "text": tail})
            break
        if m.start() > pos:
            nodes.append({"type": "text", "text": text[pos:m.start()]})
        if m.group("code"):
            inner = m.group("code")[1:-1]
            nodes.append({"type": "text", "text": inner, "marks": [{"type": "code"}]})
        elif m.group("link"):
            nodes.append({
                "type": "text",
                "text": m.group("linktext"),
                "marks": [{"type": "link", "attrs": {"href": m.group("linkurl")}}],
            })
        elif m.group("bold"):
            inner = m.group("bold")[2:-2]
            nodes.append({"type": "text", "text": inner, "marks": [{"type": "strong"}]})
        elif m.group("italic"):
            inner = m.group("italic")[1:-1]
            nodes.append({"type": "text", "text": inner, "marks": [{"type": "em"}]})
        pos = m.end()
    return nodes


def _list_item(text):
    return {
        "type": "listItem",
        "content": [{"type": "paragraph", "content": parse_inline(text)}],
    }


def parse_markdown(md):
    lines = md.split("\n")
    blocks = []
    para_buf = []
    i = 0

    def flush_paragraph():
        if para_buf:
            joined = " ".join(line.strip() for line in para_buf).strip()
            if joined:
                blocks.append({"type": "paragraph", "content": parse_inline(joined)})
            para_buf.clear()

    while i < len(lines):
        line = lines[i]

        # Blank line ends the current paragraph
        if not line.strip():
            flush_paragraph()
            i += 1
            continue

        # Heading: # to ######
        m = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if m:
            flush_paragraph()
            blocks.append({
                "type": "heading",
                "attrs": {"level": len(m.group(1))},
                "content": parse_inline(m.group(2)),
            })
            i += 1
            continue

        # Fenced code block
        m = re.match(r"^```(\w*)\s*$", line)
        if m:
            flush_paragraph()
            lang = m.group(1)
            i += 1
            code_lines = []
            while i < len(lines) and not re.match(r"^```\s*$", lines[i]):
                code_lines.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1  # consume closing fence
            block = {"type": "codeBlock", "content": [{"type": "text", "text": "\n".join(code_lines)}]}
            if lang:
                block["attrs"] = {"language": lang}
            blocks.append(block)
            continue

        # Bullet list
        m = re.match(r"^[-*]\s+(.+)$", line)
        if m:
            flush_paragraph()
            items = []
            while i < len(lines):
                lm = re.match(r"^[-*]\s+(.+)$", lines[i])
                if not lm:
                    break
                items.append(_list_item(lm.group(1)))
                i += 1
            blocks.append({"type": "bulletList", "content": items})
            continue

        # Ordered list
        m = re.match(r"^\d+\.\s+(.+)$", line)
        if m:
            flush_paragraph()
            items = []
            while i < len(lines):
                lm = re.match(r"^\d+\.\s+(.+)$", lines[i])
                if not lm:
                    break
                items.append(_list_item(lm.group(1)))
                i += 1
            blocks.append({"type": "orderedList", "content": items})
            continue

        # Default: accumulate into a paragraph
        para_buf.append(line)
        i += 1

    flush_paragraph()

    # ADF rejects an empty doc; surface a single empty paragraph so the PUT succeeds
    # when the caller passes an all-whitespace string.
    if not blocks:
        blocks = [{"type": "paragraph", "content": []}]

    return {"type": "doc", "version": 1, "content": blocks}


def main():
    md = sys.stdin.read()
    doc = parse_markdown(md)
    json.dump(doc, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
