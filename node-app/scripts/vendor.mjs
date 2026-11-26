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

// Codex SDK (a single ESM file) and the OpenCode SDK client, used by the workers.
const codex = join(root, 'dist', 'vendor', 'codex-sdk');
mkdirSync(codex, { recursive: true });
cpSync(join(root, 'node_modules', '@openai', 'codex-sdk', 'dist', 'index.js'), join(codex, 'index.js'));
cpSync(join(root, 'node_modules', '@openai', 'codex-sdk', 'LICENSE'), join(codex, 'LICENSE'));
cpSync(join(root, 'node_modules', '@opencode-ai', 'sdk', 'dist'), join(root, 'dist', 'vendor', 'opencode-sdk'), {
  recursive: true, filter: source => !/\.d\.ts$|\.map$/.test(source),
});

// xterm.js for the in-App terminal (loaded by the renderer as a classic script).
const ui = join(root, 'ui', 'vendor');
rmSync(ui, { recursive: true, force: true });
mkdirSync(ui, { recursive: true });
cpSync(join(root, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), join(ui, 'xterm.js'));
cpSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(ui, 'xterm.css'));

// A hash of the compiled backend: the App replaces a local backend of another build.
{
  const { createHash } = await import('node:crypto');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const dist = join(root, 'dist');
  const hash = createHash('sha256');
  for (const name of readdirSync(dist).filter(name => name.endsWith('.js')).sort()) hash.update(name).update(readFileSync(join(dist, name)));
  writeFileSync(join(dist, 'build-id'), hash.digest('hex').slice(0, 12) + '\n');
}
