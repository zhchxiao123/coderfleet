// Copies the Claude Agent SDK's ESM runtime (sdk.mjs and its chunks) into
// dist/vendor. Workers load it inside the container next to the system `claude`.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const target = join(root, 'dist', 'vendor', 'claude-agent-sdk');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of readdirSync(source)) {
  if (name === 'sdk.mjs' || /^core-[\w]+\.mjs$/.test(name) || name === 'package.json' || name === 'LICENSE.md') cpSync(join(source, name), join(target, name));
}

// xterm.js for the in-App terminal (loaded by the renderer as a classic script).
const ui = join(root, 'ui', 'vendor');
rmSync(ui, { recursive: true, force: true });
mkdirSync(ui, { recursive: true });
cpSync(join(root, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), join(ui, 'xterm.js'));
cpSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(ui, 'xterm.css'));
