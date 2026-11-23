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
