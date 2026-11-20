# Long translations were accepted and cached after truncation

## Symptom

Long assistant replies translated only partially. Refreshing or trying again could return the same short result, and translating a growing streamed reply could lose its newly added ending.

## Causes

`translate_text` sent the whole message with a fixed 4096-token output budget. `SystemLLM` returned any text from a successful HTTP response without checking `stop_reason` / `finish_reason`, so a length-limited prefix was indistinguishable from a complete translation. The content-addressed cache then preserved that result indefinitely.

The browser cached translations by content-element identity without an original-text revision. Subsequent stream paints and late translation responses could therefore restore an earlier short snapshot over the complete message.

A real synthetic-document check also found that intact section markers did not prove intact bodies: splitting immediately after a heading could produce an orphaned leading paragraph that the model omitted while reporting normal completion.

## Fix

- Provider adapters reject output/context-limit termination with a typed error; refusals, filtering and non-text completion paths fail explicitly.
- Translation splits source text without inventing separators, preserves fenced code and protected code/URL atoms, keeps headings with their bodies, and bounds network concurrency to three.
- Output limits and missing paragraph/heading/list/inline-code structure trigger smaller-piece retries. Any unrecoverable piece cancels siblings and prevents a partial document from reaching the cache.
- Version-2 cache entries attest to the new completion policy; legacy entries remain on disk and are regenerated on demand.
- Browser state belongs to an exact original Markdown snapshot. Stream growth invalidates the old request/cache; unchanged settlement preserves the selected translation; stale results cannot overwrite a newer snapshot.

## Prevention and evidence

`tests/test_translation_long_text.py` covers both provider wire formats, final-paragraph retention, Markdown/code preservation, adaptive retries, cancellation and API/cache boundaries. `tests/test_system_llm.py` covers stop reasons and compatible nullable usage. `tests/frontend/translation.test.cjs` covers long rendering, source changes, stale success/failure, empty responses and retries; it runs through `tests/test_frontend_rendering.py`.

The original regressions failed before the fix. A 13,891-character synthetic document was then translated through the configured system model with all 26 nonempty sections, the final marker and literal code retained. Browser component acceptance used the real shared renderer and API handler in an isolated loopback fixture. Production installation remains a separate, guarded operation that must wait for running work to finish.

Provider protocol references: [Anthropic stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), [OpenAI completion finish reasons](https://developers.openai.com/api/reference/resources/chat).
