const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.style = {};
    this.className = '';
    this._html = '';
    this.classList = { add: (...names) => { this.className += ' ' + names.join(' '); } };
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html + this.children.map(child => child.innerHTML).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(selector) {
    if (selector === '.chat-log') return this.log || (this.log = new Element());
    return null;
  }
}

function renderer() {
  const context = vm.createContext({
    document: { createElement: () => new Element(), addEventListener() {} }, console,
    window: { fetch: async () => ({ status: 200 }) }, Headers, TextEncoder,
    localStorage: { getItem: () => '' },
  });
  const directory = path.resolve(__dirname, '../../coderfleet/server/static/js');
  for (const name of ['utils.js', 'renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(directory, name), 'utf8'), context);
  }
  const Renderer = vm.runInContext('ChatLogRenderer', context);
  const container = new Element();
  const result = new Renderer(container, true);
  result.renderExecuting();
  return { result, container };
}

test('SDK turn results do not finish the Task before its durable footer', () => {
  const { result, container } = renderer();
  result.push(JSON.stringify({ type: 'system', subtype: 'coderfleet_backend', execution_backend: 'sdk' }));
  result.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  assert.equal(container.log.children.filter(child => child.className.includes('chat-footer')).length, 0);
  result.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  assert.equal(container.log.children.filter(child => child.className.includes('chat-footer')).length, 0);
  result.push('finished: 2026-11-09 19:00:00 [killed]');
  const footers = container.log.children.filter(child => child.className.includes('chat-footer'));
  assert.equal(footers.length, 1);
  assert.match(footers[0].innerHTML, /任务已终止/);
});

test('legacy CLI results still render their completion footer', () => {
  const { result, container } = renderer();
  result.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  assert.equal(container.log.children.filter(child => child.className.includes('chat-footer')).length, 1);
});
