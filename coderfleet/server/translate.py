"""
translate.py — 气泡翻译

按 Markdown 边界分块翻译，代码块保持原样；长度受限的块缩小后重试。
只有所有块都完整完成才返回，调用方不能把半截译文缓存成成功结果。
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass

from coderfleet.server.system_llm import SystemLLM, SystemLLMError, SystemLLMOutputLimitError

_SYSTEM_PROMPT = (
    "You are a translation engine. Translate the user's message into {target}. "
    "Output ONLY the translation — no preamble, no explanation, no quotes around it. "
    "Preserve all Markdown structure, code blocks, inline code, links and formatting "
    "exactly. Leave code, identifiers and URLs untranslated."
    " Translate ALL input content without omitting, summarizing or adding content."
)

_CHUNK_CHARS = 2000
_CONCURRENCY = 3
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)")
_INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)")
_PROTECTED = re.compile(_INLINE_CODE.pattern + r"|!?\[[^\]\n]*\]\([^\)\n]*\)|https?://[^\s]+")
_HEADING = re.compile(r"^ {0,3}(#{1,6})[ \t]+", re.MULTILINE)
_LIST_ITEM = re.compile(r"^[ \t]*(?:[-+*]|\d+[.)])[ \t]+", re.MULTILINE)


class _IncompleteTranslation(SystemLLMError):
    """Provider claimed completion, but required document structure was omitted."""


@dataclass(frozen=True)
class _Part:
    text: str
    literal: bool = False


def _split_prose(text: str, limit: int) -> list[_Part]:
    """Lossless splitting: never invent a newline or cut a code/link atom."""
    parts: list[_Part] = []
    while len(text) > limit:
        end = limit
        for separator in ("\n\n", "\n", ". ", " "):
            boundary = text.rfind(separator, limit // 2, limit)
            if boundary >= 0:
                end = boundary + len(separator)
                break
        # Avoid a request ending with the next section's heading while its body
        # starts another request as an apparently unrelated leading paragraph.
        trailing_heading = re.search(r"(?:^|\n)( {0,3}#{1,6}[ \t]+[^\r\n]+)\r?\n(?:[ \t]*\r?\n)*$", text[:end])
        if trailing_heading and trailing_heading.start(1) > 0:
            end = trailing_heading.start(1)
        literal = False
        for match in _PROTECTED.finditer(text):
            if match.start() >= end:
                break
            if match.start() < end < match.end():
                # An oversized code/URL atom is preserved directly, not sent as
                # malformed half-Markdown to independent model requests.
                if match.start() == 0:
                    end, literal = match.end(), True
                else:
                    end = match.start()
                break
        parts.append(_Part(text[:end], literal))
        text = text[end:]
    if text:
        parts.append(_Part(text))
    return parts


def _structure(text: str) -> tuple[int, list[str], int, list[str]]:
    blocks = re.split(r"\r?\n[ \t]*\r?\n", text.strip())
    paragraphs = sum(bool(block.strip()) and not re.fullmatch(r" {0,3}#{1,6}[ \t]+[^\r\n]+", block.strip()) for block in blocks)
    return (paragraphs, _HEADING.findall(text), len(_LIST_ITEM.findall(text)),
            [match[0] for match in _INLINE_CODE.finditer(text)])


def _translation_parts(text: str) -> list[_Part]:
    parts: list[_Part] = []
    buffer: list[str] = []
    fence = ""
    for line in text.splitlines(keepends=True):
        if fence:
            buffer.append(line)
            if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}[ \t]*(?:\r?\n)?", line):
                parts.append(_Part("".join(buffer), True))
                buffer, fence = [], ""
        else:
            opening = _FENCE.match(line)
            if opening and opening[1][0] == "`" and "`" in line[opening.end(1):]:
                opening = None  # Same-line backtick spans are not fenced blocks.
            if opening:
                parts.extend(_split_prose("".join(buffer), _CHUNK_CHARS))
                buffer, fence = [line], opening[1]
            else:
                buffer.append(line)
    if buffer:
        remainder = "".join(buffer)
        parts.extend([_Part(remainder, True)] if fence else _split_prose(remainder, _CHUNK_CHARS))
    return parts


async def translate_text(llm: SystemLLM, text: str, target: str = "简体中文") -> str:
    if not text.strip():
        return ""
    semaphore = asyncio.Semaphore(_CONCURRENCY)

    async def translate_part(part: _Part, depth: int = 0) -> str:
        if part.literal or not part.text.strip():
            return part.text
        source = part.text
        left = len(source) - len(source.lstrip())
        right = len(source.rstrip())
        content = source[left:right]
        try:
            async with semaphore:
                translated = await llm.complete(
                    [{"role": "user", "content": content}],
                    system=_SYSTEM_PROMPT.format(target=target),
                    max_tokens=4096,
                )
            if not translated.strip() or _structure(content) != _structure(translated):
                raise _IncompleteTranslation("译文缺少段落或 Markdown 结构，翻译未完成")
        except (SystemLLMOutputLimitError, _IncompleteTranslation) as error:
            if len(content) <= 1 or depth >= 12:
                raise SystemLLMError("模型未能返回完整译文，请重试或更换系统模型") from error
            smaller = _split_prose(content, max(1, len(content) // 2))
            translated = "".join([await translate_part(piece, depth + 1) for piece in smaller])
        return source[:left] + translated + source[right:]

    tasks = [asyncio.create_task(translate_part(part)) for part in _translation_parts(text)]
    try:
        return "".join(await asyncio.gather(*tasks))
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
