// Lists the models the container's Claude account may use, as Claude Code
// itself lists them (`/model`): `node claude-models.js <sdk_directory> <cwd>` prints
// the SDK's `supportedModels()` as JSON. Only the initialize handshake runs —
// no message is sent, so it costs no tokens.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ModelInfo { value: string; resolvedModel?: string; displayName: string; description: string }
interface Query { supportedModels(): Promise<ModelInfo[]>; close(): void }
type QueryFunction = (input: { prompt: AsyncIterable<never>; options: Record<string, unknown> }) => Query;

async function* idle(): AsyncGenerator<never> { await new Promise(() => undefined); }

const [directory, cwd] = process.argv.slice(2);
if (!directory || !cwd) {
  process.stderr.write('Usage: claude-models <sdk_directory> <cwd>\n');
  process.exit(2);
}
let path: string;
try { path = execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 10_000 }).trim(); }
catch { process.stderr.write('Claude Code is not installed in this container\n'); process.exit(1); }
const sdk = await import(pathToFileURL(join(directory, 'sdk.mjs')).href) as { query: QueryFunction };
// Same settings sources as a turn, so an `availableModels` setting narrows the list here too.
const query = sdk.query({ prompt: idle(), options: { cwd, pathToClaudeCodeExecutable: path, settingSources: ['user', 'project', 'local'] } });
try {
  const models = await query.supportedModels();
  process.stdout.write(JSON.stringify((models ?? []).map(model => ({
    value: model.value, resolvedModel: model.resolvedModel ?? '', displayName: model.displayName, description: model.description,
  }))) + '\n');
} finally {
  query.close();
}
// The idle prompt stream would keep the event loop alive.
process.exit(0);
