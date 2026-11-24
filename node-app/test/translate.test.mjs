import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { complete, systemLLM, TranslationCache, translateText } from '../dist/translate.js';

/** A fake Anthropic/OpenAI endpoint that "translates" by upper-casing prose. */
function fakeLLM(log) {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw);
        const content = body.messages.at(-1).content;
        log.push({ url: request.url, headers: request.headers, body, content });
        // Code and URLs stay as they are; hex placeholders survive upper-casing.
        const upper = content.replace(/(`+)[\s\S]*?\1|https?:\/\/\S+/g, match => '\0' + Buffer.from(match).toString('hex') + '\0')
          .toUpperCase().replace(/\0([^\0]*)\0/g, (_, value) => Buffer.from(value.toLowerCase(), 'hex').toString());
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/v1/messages') {
          // The first call for "LONG" content stops at the length limit.
          const cut = content.includes('LIMIT') && !log.some(item => item.limited);
          if (cut) log.at(-1).limited = true;
          response.end(JSON.stringify(cut ? { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'PART' }] }
            : { stop_reason: 'end_turn', content: [{ type: 'text', text: upper }], usage: { output_tokens: 5 } }));
        } else response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: upper } }], usage: { completion_tokens: 5 } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('translation keeps code, splits long replies, retries cut-off parts and goes through the proxy', async () => {
  const log = [];
  const llm = await fakeLLM(log);
  const base = 'http://127.0.0.1:' + llm.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'coderfleet-translate-'));
  // An HTTP proxy that records what it forwards.
  const proxied = [];
  const proxy = createServer((request, response) => {
    proxied.push(request.url);
    const target = new URL(request.url);
    const upstream = connect(Number(target.port), target.hostname, () => {
      upstream.write(request.method + ' ' + target.pathname + ' HTTP/1.1\r\n' + Object.entries(request.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
      request.pipe(upstream);
    });
    upstream.pipe(response.socket);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(join(dir, 'config.conf'), 'SYSTEM_LLM_API_KEY=k1\nSYSTEM_LLM_MODEL=m1\nSYSTEM_LLM_BASE_URL=' + base + '\n');
    const config = systemLLM(dir);
    assert.deepEqual(config, { provider: 'anthropic', apiKey: 'k1', model: 'm1', baseUrl: base, proxy: '' });

    const reply = 'Hello `code()` world.\n\n```js\nconst x = 1;\n```\n\n- item one\n- item two\n';
    assert.equal(await translateText(config, reply), 'HELLO `code()` WORLD.\n\n```js\nconst x = 1;\n```\n\n- ITEM ONE\n- ITEM TWO\n');
    assert.ok(log.every(item => !item.content.includes('const x')), 'code blocks are never sent');
    assert.equal(log[0].headers['x-api-key'], 'k1');
    assert.match(log[0].body.system, /Translate the user's message into 简体中文/);

    // A long reply is split at paragraph boundaries; a part cut off at the limit is retried in halves.
    log.length = 0;
    const long = Array.from({ length: 6 }, (_, index) => 'paragraph ' + index + ' ' + 'word '.repeat(80).trim() + (index === 2 ? ' LIMIT' : '')).join('\n\n');
    const result = await translateText(config, long);
    assert.equal(result, long.toUpperCase());
    assert.ok(log.length >= 3 && log.some(item => item.limited), 'split and retried');

    // OpenAI-compatible endpoint through SYSTEM_LLM_PROXY.
    writeFileSync(join(dir, 'config.conf'), 'SYSTEM_LLM_PROVIDER=openai\nSYSTEM_LLM_API_KEY=k2\nSYSTEM_LLM_MODEL=m2\nSYSTEM_LLM_BASE_URL=' + base + '/v1\nSYSTEM_LLM_PROXY=http://127.0.0.1:' + proxy.address().port + '\n');
    assert.equal(await complete(systemLLM(dir), 'hi', 'sys', 100), 'HI');
    assert.deepEqual(proxied, [base + '/v1/chat/completions']);
    assert.equal(log.at(-1).headers.authorization, 'Bearer k2');
    assert.deepEqual(log.at(-1).body.messages.map(item => item.role), ['system', 'user']);

    // The cache file is the Python service's: translations/<sha256(target\0text)[:32]>.json, version 2.
    const cache = new TranslationCache(join(dir, 'translations'));
    cache.put('Hello', '简体中文', '你好');
    const name = createHash('sha256').update('简体中文\0Hello').digest('hex').slice(0, 32);
    const saved = JSON.parse(readFileSync(join(dir, 'translations', name + '.json'), 'utf8'));
    assert.deepEqual([saved.id, saved.target, saved.translated, saved.version], [name, '简体中文', '你好', 2]);
    assert.equal(cache.get('Hello', '简体中文'), '你好');
    writeFileSync(join(dir, 'translations', name + '.json'), JSON.stringify({ ...saved, version: 1 }));
    assert.equal(cache.get('Hello', '简体中文'), undefined, 'unchecked legacy entries are translated again');
    assert.ok(!existsSync(join(dir, 'translations', 'x.json')));
  } finally {
    llm.close(); proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
