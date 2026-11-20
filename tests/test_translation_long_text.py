"""Translation must never treat a provider's length-limited prefix as complete."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from coderfleet.server.system_llm import SystemLLM, SystemLLMError
from coderfleet.server.translate import translate_text
from coderfleet.server.translation_cache import TranslationCache, _key


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_long_translation_preserves_the_last_paragraph(provider: str) -> None:
    source = "# Report\n\n" + ("A detailed paragraph with important requirements.\n\n" * 240) + "END_OF_DOCUMENT_92841"

    def handler(request: httpx.Request) -> httpx.Response:
        text = json.loads(request.content)["messages"][-1]["content"]
        truncated = len(text) > 3000
        output = text[:3000] if truncated else text
        if provider == "anthropic":
            body = {"content": [{"type": "text", "text": output}], "stop_reason": "max_tokens" if truncated else "end_turn"}
        else:
            body = {"choices": [{"message": {"content": output}, "finish_reason": "length" if truncated else "stop"}]}
        return httpx.Response(200, json=body)

    llm = SystemLLM(provider=provider, api_key="test", model="test", transport=httpx.MockTransport(handler))
    result = asyncio.run(translate_text(llm, source))
    assert result.endswith("END_OF_DOCUMENT_92841"), "The last paragraph was silently lost"
    assert result == source


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
def test_an_unrecoverable_output_limit_is_an_error(provider: str) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        body = ({"content": [{"type": "text", "text": "partial"}], "stop_reason": "max_tokens"}
                if provider == "anthropic" else
                {"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]})
        return httpx.Response(200, json=body)

    llm = SystemLLM(provider=provider, api_key="test", model="test", transport=httpx.MockTransport(handler))
    with pytest.raises(SystemLLMError):
        asyncio.run(translate_text(llm, "x"))


def test_legacy_unverified_translation_is_not_served_as_complete(tmp_path: Path) -> None:
    source, target = "Long original document", "简体中文"
    key = _key(source, target)
    (tmp_path / f"{key}.json").write_text(json.dumps({
        "id": key, "target": target, "translated": "a truncated legacy prefix",
    }), encoding="utf-8")
    assert TranslationCache(tmp_path).get(source, target) is None


def _echo_llm(seen: list[str], limit: int = 100000) -> SystemLLM:
    def handler(request: httpx.Request) -> httpx.Response:
        text = json.loads(request.content)["messages"][-1]["content"]
        seen.append(text)
        return httpx.Response(200, json={
            "content": [{"type": "text", "text": text[:limit]}],
            "stop_reason": "max_tokens" if len(text) > limit else "end_turn",
        })
    return SystemLLM(api_key="test", model="test", transport=httpx.MockTransport(handler))


def test_markdown_whitespace_unicode_and_fenced_code_are_preserved() -> None:
    code = "````python\r\n" + "print('do not translate this')\r\n" * 500 + "```\r\n````\r\n"
    source = "  # Heading\r\n\r\n" + "一段内容 with Unicode 🙂 and `inline` code.\r\n" * 200 + code + "\r\nTHE_LAST_PARAGRAPH\r\n"
    seen: list[str] = []
    result = asyncio.run(translate_text(_echo_llm(seen), source))
    assert result == source
    assert all(len(chunk) <= 2000 for chunk in seen)
    assert all("print('do not translate this')" not in chunk for chunk in seen)


def test_tilde_and_unclosed_code_fences_do_not_call_a_model() -> None:
    for source in ["~~~js\nconst value = 1;\n~~~\n", "```python\nunfinished_code()\n"]:
        assert asyncio.run(translate_text(SystemLLM(), source)) == source


def test_same_line_backticks_do_not_hide_the_following_prose() -> None:
    seen: list[str] = []
    source = "```inline code``` is an example.\nThe next paragraph needs translation."
    assert asyncio.run(translate_text(_echo_llm(seen), source)) == source
    assert any("next paragraph" in chunk for chunk in seen)


def test_oversized_inline_code_is_kept_without_cutting_its_delimiters() -> None:
    code = "``" + "a`b_" * 2000 + "``"
    source = "An explanation. " + code + " The complete final sentence."
    seen: list[str] = []
    assert asyncio.run(translate_text(_echo_llm(seen), source)) == source
    assert all(len(chunk) <= 2000 for chunk in seen)
    assert all("a`b_" not in chunk for chunk in seen)


def test_output_limited_chunks_are_split_again_without_losing_text() -> None:
    source = "A lengthy paragraph with all requirements intact. " * 240 + "FINAL_62814"
    seen: list[str] = []
    assert asyncio.run(translate_text(_echo_llm(seen, limit=400), source)) == source
    assert any(len(chunk) > 400 for chunk in seen)
    assert any(len(chunk) <= 400 for chunk in seen)


def test_chunk_network_concurrency_is_bounded_and_order_is_preserved() -> None:
    async def scenario() -> None:
        active = peak = 0
        arrived = asyncio.Event()
        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal active, peak
            text = json.loads(request.content)["messages"][-1]["content"]
            active += 1
            peak = max(peak, active)
            if active == 3:
                arrived.set()
            await arrived.wait()
            active -= 1
            return httpx.Response(200, json={"content": [{"type": "text", "text": text}], "stop_reason": "end_turn"})
        llm = SystemLLM(api_key="test", model="test", transport=httpx.MockTransport(handler))
        source = "All paragraphs must remain in the original order. " * 400
        assert await asyncio.wait_for(translate_text(llm, source), timeout=2) == source
        assert peak == 3
    asyncio.run(scenario())


def test_a_chunk_failure_cancels_siblings_instead_of_returning_a_partial_document() -> None:
    async def scenario() -> None:
        cancelled = 0
        wait = asyncio.Event()
        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal cancelled
            text = json.loads(request.content)["messages"][-1]["content"]
            if "FAIL_726" in text:
                return httpx.Response(503, text="unavailable")
            try:
                await wait.wait()
            except asyncio.CancelledError:
                cancelled += 1
                raise
            raise AssertionError("Sibling should have been cancelled")
        llm = SystemLLM(api_key="test", model="test", transport=httpx.MockTransport(handler))
        with pytest.raises(SystemLLMError, match="503"):
            await asyncio.wait_for(translate_text(llm, "A " * 1200 + "FAIL_726 " + "B " * 3000), timeout=2)
        assert cancelled >= 1
    asyncio.run(scenario())


def test_failed_translation_endpoint_does_not_write_a_partial_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException
    from coderfleet.server import main
    llm = _echo_llm([], limit=0)
    monkeypatch.setattr(main, "translation_cache", TranslationCache(tmp_path))
    monkeypatch.setattr(SystemLLM, "from_config", classmethod(lambda cls, _path: llm))
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.translate(main.TranslateRequest(text="The whole document")))
    assert error.value.status_code == 502
    assert not list(tmp_path.glob("*.json"))


def test_successful_long_translation_endpoint_caches_only_the_whole_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from coderfleet.server import main
    seen: list[str] = []
    llm = _echo_llm(seen, limit=500)
    monkeypatch.setattr(main, "translation_cache", TranslationCache(tmp_path))
    monkeypatch.setattr(SystemLLM, "from_config", classmethod(lambda cls, _path: llm))
    request = main.TranslateRequest(text="Every paragraph must survive. " * 400 + "END_92763")
    first = asyncio.run(main.translate(request))
    calls = len(seen)
    second = asyncio.run(main.translate(request))
    assert first.translated == request.text
    assert second.translated == request.text
    assert not first.cached and second.cached
    assert len(seen) == calls
    record = json.loads(next(tmp_path.glob("*.json")).read_text())
    assert record["version"] == 2


def test_a_normal_stop_that_omits_a_paragraph_is_retried_in_smaller_pieces() -> None:
    source = "Leading paragraph that must be retained.\n\n## Heading\n\nThe complete body."
    requests: list[str] = []
    def handler(request: httpx.Request) -> httpx.Response:
        text = json.loads(request.content)["messages"][-1]["content"]
        requests.append(text)
        output = text.split("\n\n", 1)[-1] if text == source else text
        return httpx.Response(200, json={"content": [{"type": "text", "text": output}], "stop_reason": "end_turn"})
    llm = SystemLLM(api_key="test", model="test", transport=httpx.MockTransport(handler))
    assert asyncio.run(translate_text(llm, source)) == source
    assert len(requests) > 1


def test_chunk_boundaries_keep_section_headings_with_their_bodies() -> None:
    source = "# Report\n\n" + "\n\n".join(f"## Section {i}\n\n" + "Body text retained. " * 23 for i in range(20))
    seen: list[str] = []
    assert asyncio.run(translate_text(_echo_llm(seen), source)) == source
    assert all(not chunk.splitlines()[-1].startswith("## ") for chunk in seen)
