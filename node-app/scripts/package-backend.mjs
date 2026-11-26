// Builds the self-contained backend bundle for a Linux Docker host:
//   bundles/coderfleet-backend-<version>-linux-<arch>.tar.gz
// containing coderfleet-backend/{bin,node,dist,template,package.json,VERSION,install.sh}.
//   node scripts/package-backend.mjs [--arch x64|arm64] [--node /path/to/linux/node]
// Without --node, the official Node.js build is downloaded from nodejs.org,
// verified against SHASUMS256.txt and cached in .cache/node.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const arch = option('--arch') || 'x64';
if (!['x64', 'arm64'].includes(arch)) throw new Error('--arch must be x64 or arm64');
const nodeVersion = process.env.CODERFLEET_BUNDLE_NODE || 'v22.23.2';
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function nodeBinary() {
  const given = option('--node');
  if (given) return given;
  const cache = join(root, '.cache', 'node');
  const name = 'node-' + nodeVersion + '-linux-' + arch;
  const binary = join(cache, name, 'bin', 'node');
  if (existsSync(binary)) return binary;
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, name + '.tar.xz');
  const base = 'https://nodejs.org/dist/' + nodeVersion + '/';
  console.log('Downloading ' + base + name + '.tar.xz');
  execFileSync('curl', ['-fsSL', '--retry', '3', '-C', '-', '-o', archive, base + name + '.tar.xz'], { stdio: 'inherit' });
  const sums = execFileSync('curl', ['-fsSL', base + 'SHASUMS256.txt'], { encoding: 'utf8' });
  const expected = sums.split('\n').find(line => line.endsWith('  ' + name + '.tar.xz'))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (!expected || expected !== actual) { rmSync(archive, { force: true }); throw new Error('Node.js checksum mismatch for ' + name); }
  execFileSync('tar', ['-xJf', archive, '-C', cache, name + '/bin/node']);
  return binary;
}

const node = nodeBinary();
const out = join(root, 'bundles');
const stage = join(out, '.stage-' + arch);
const app = join(stage, 'coderfleet-backend');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(app, 'bin'), { recursive: true });
mkdirSync(join(app, 'node'), { recursive: true });
cpSync(node, join(app, 'node', 'node'));
chmodSync(join(app, 'node', 'node'), 0o755);
// The backend only: the Electron main process is not shipped.
cpSync(join(root, 'dist'), join(app, 'dist'), { recursive: true, filter: source => !/[\\/]desktop\.js$/.test(source) });
cpSync(join(root, 'template'), join(app, 'template'), { recursive: true });
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'coderfleet-backend', version, type: 'module', private: true }, null, 2) + '\n');
writeFileSync(join(app, 'VERSION'), version + '\n');
cpSync(join(root, 'backend', 'coderfleet-backend'), join(app, 'bin', 'coderfleet-backend'));
cpSync(join(root, 'backend', 'install.sh'), join(app, 'install.sh'));
chmodSync(join(app, 'bin', 'coderfleet-backend'), 0o755);
chmodSync(join(app, 'install.sh'), 0o755);
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) if (name.endsWith('-linux-' + arch + '.tar.gz')) rmSync(join(out, name));
const file = join(out, 'coderfleet-backend-' + version + '-linux-' + arch + '.tar.gz');
execFileSync('tar', ['-czf', file, '-C', stage, 'coderfleet-backend']);
rmSync(stage, { recursive: true, force: true });
console.log(file);
