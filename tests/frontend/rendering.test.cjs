const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const jsDir = path.resolve(__dirname, '../../coderfleet/server/static/js');

// Minimal DOM for the real renderer's programmatic image/text nodes.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.className = '';
    this._html = '';
    this._text = '';
    this.classList = {
      add: (...names) => { this.className += ' ' + names.join(' '); },
      remove: () => {},
    };
  }
  set innerHTML(value) { this._html = value; this._text = ''; this.children = []; }
  get innerHTML() { return this._html + this.children.map(child => child.innerHTML).join(''); }
  set textContent(value) { this._text = value; this._html = ''; this.children = []; }
  get textContent() { return this._text + this._html + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  after(child) {
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, child);
    child.parentNode = this.parentNode;
  }
  addEventListener() {}
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.tagName === selector ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

function loadUi(fetchImpl = async () => ({ status: 200 })) {
  const context = vm.createContext({
    console, TextEncoder, Headers,
    document: { createElement: tag => new Element(tag), addEventListener() {} },
    window: { fetch: fetchImpl },
    fetch: fetchImpl,
    localStorage: { getItem: () => '' },
    _finishedLogCache: new Map(),
    logCacheGet: async () => null,
    logCacheSet() {},
  });
  for (const name of ['utils.js', 'renderer.js', 'chat.js']) {
    vm.runInContext(fs.readFileSync(path.join(jsDir, name), 'utf8'), context, { filename: name });
  }
  context.Renderer = vm.runInContext('ChatLogRenderer', context);
  return context;
}

function makeTool(renderer, id) {
  const body = new Element();
  const output = body.appendChild(new Element());
  renderer.toolMap[id] = {
    name: 'Read', statusEl: new Element(), badgeEl: new Element(),
    outputEl: output, exitEl: new Element(), bodyEl: body, btnEl: new Element(),
  };
  return output;
}

test('active history resumes raw SSE after the last fetched byte, including image metadata', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aZ09+/'.repeat(16000) } };
  const previous = {
    type: 'user', tool_use_result: { metadata: 'x'.repeat(2048), image },
    message: { content: [{ type: 'tool_result', tool_use_id: 'previous-image', content: [image] }] },
  };
  const { tool_use_result, ...displayEvent } = previous;
  const header = '=== CoderFleet Task Log ===\n======================================\n';
  const raw = header + JSON.stringify(previous) + '\n';
  const light = header + JSON.stringify(displayEvent) + '\n';
  const next = JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'next-tool', content: '完成' },
  ] } }) + '\n';
  for (const status of ['running', 'pending', 'scheduled']) {
    const context = loadUi(async url => ({ text: async () => url.includes('light=1') ? light : raw }));
    const history = await context._fetchTaskLogCached({ id: 'active', status });
    const offset = new TextEncoder().encode(history).byteLength;
    const renderer = new context.Renderer(null);
    renderer.inner = new Element();
    const completed = [];
    renderer._fillTool = id => completed.push(id);
    const suffix = Buffer.from(raw + next).subarray(offset).toString('utf8');
    for (const line of suffix.trimEnd().split('\n')) renderer._processLine(line);
    assert.equal(renderer.inner.children.length, 0, status + ': image encoding became raw error text');
    assert.deepEqual(completed, ['next-tool'], status + ': history was replayed or the next event was lost');
  }
});

test('finished history keeps its compact response and persistent cache', async () => {
  const finished = '=== CoderFleet Task Log ===\n======================================\n{}\n======================================\nfinished: done\n';
  const requests = [];
  const context = loadUi(async url => { requests.push(url); return { text: async () => finished }; });
  let saved = '';
  context.logCacheSet = (id, text) => { saved = text; };
  assert.equal(await context._fetchTaskLogCached({ id: 'finished', status: 'done' }), finished);
  assert.ok(requests[0].includes('light=1'));
  assert.equal(saved, finished);
  assert.equal(await context._fetchTaskLogCached({ id: 'finished', status: 'done' }), finished);
  assert.equal(requests.length, 1);
});

test('Claude mixed image/text results retain both the thumbnail and the explanation', () => {
  const context = loadUi();
  const renderer = new context.Renderer(null);
  const output = makeTool(renderer, 'mixed');
  renderer._event({ type: 'user', message: { content: [{
    type: 'tool_result', tool_use_id: 'mixed', content: [
      { type: 'text', text: '图片的说明文字' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ],
  }] } });
  assert.equal(output.querySelectorAll('img').length, 1);
  assert.equal(output.querySelectorAll('img')[0].src, 'data:image/png;base64,aW1hZ2U=');
  assert.ok(output.textContent.includes('图片的说明文字'));
});

test('image-only results render without a spurious no-output message', () => {
  const context = loadUi();
  const renderer = new context.Renderer(null);
  const output = makeTool(renderer, 'image');
  renderer._event({ type: 'user', message: { content: [{
    type: 'tool_result', tool_use_id: 'image', content: [
      { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
    ],
  }] } });
  assert.equal(output.querySelectorAll('img').length, 1);
  assert.equal(output.textContent, '');
});

test('malformed image fragments do not dump base64 into the error timeline', () => {
  const context = loadUi();
  const renderer = new context.Renderer(null);
  renderer.inner = new Element();
  const fragment = 'QPA' + 'aZ09+/'.repeat(16000) + '"}}';
  renderer._processLine(fragment);
  assert.equal(renderer.inner.children.length, 1);
  assert.ok(renderer.inner.textContent.length < 2100);
  assert.ok(!/[A-Za-z0-9+/]{256}/.test(renderer.inner.textContent));
});

test('ordinary raw diagnostics stay readable while long raw text is bounded', () => {
  const context = loadUi();
  const renderer = new context.Renderer(null);
  renderer.inner = new Element();
  renderer._processLine('Connection failed: retry later');
  assert.equal(renderer.inner.children[0].textContent, 'Connection failed: retry later');
  renderer._processLine('工具暂时无法连接，请重试。'.repeat(10000));
  assert.ok(renderer.inner.children[1].textContent.length < 2100);
});
