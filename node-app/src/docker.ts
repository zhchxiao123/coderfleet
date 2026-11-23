import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { type Project } from './state.js';

const run = promisify(execFile);
const owner = 'io.coderfleet.node.turn';

export function containerName(id: string): string { return 'coderfleet-node-' + id; }

function argumentsFor(project: Project, interactive: boolean): string[] {
  mkdirSync(project.accountDirectory, { recursive: true, mode: 0o700 });
  if (!statSync(project.workspace).isDirectory()) throw new Error('Project workspace is not a directory');
  const args = ['run', '--rm', interactive ? '-it' : '-i', '--network', project.network,
    '--entrypoint', 'agy', '--workdir', '/workspace',
    '--mount', 'type=bind,source=' + project.workspace + ',target=/workspace',
    '--mount', 'type=bind,source=' + project.accountDirectory + ',target=/home/byclaw/.gemini'];
  for (const server of project.dns) args.push('--dns', server);
  if (project.containerUser) args.push('--user', project.containerUser);
  args.push('--env', 'HOME=/home/byclaw');
  for (const key of Object.keys(project.environment)) args.push('--env', key);
  return args;
}

export function launchAcp(project: Project, turnId: string): ChildProcessWithoutNullStreams {
  return spawn(project.dockerPath, [...argumentsFor(project, false), '--name', containerName(turnId),
    '--label', owner + '=' + turnId, project.image, 'acp', '--disable-telemetry'], { stdio: 'pipe', env: { ...process.env, ...project.environment } });
}

export function login(project: Project): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(project.dockerPath, [...argumentsFor(project, true), project.image, 'acp', '--login'], { stdio: 'inherit', env: { ...process.env, ...project.environment } });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

export async function models(project: Project): Promise<readonly { id: string; label: string }[]> {
  const { stdout } = await run(project.dockerPath, [...argumentsFor(project, false), project.image, 'models'], { timeout: 25_000, maxBuffer: 512_000, env: { ...process.env, ...project.environment } });
  return stdout.trim().split('\n').flatMap(line => {
    const [id, label] = line.trim().split('\t');
    return id && label ? [{ id, label }] : [];
  });
}

export async function cleanContainer(dockerPath: string, turnId: string): Promise<void> {
  const { stdout } = await run(dockerPath, ['ps', '-aq', '--filter', 'label=' + owner + '=' + turnId], { timeout: 10_000 });
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return;
  if (ids.length !== 1 || !ids[0] || !/^[a-f0-9]{12,64}$/.test(ids[0])) throw new Error('Uncertain turn container ownership');
  try { await run(dockerPath, ['rm', '-f', ids[0]], { timeout: 15_000 }); }
  catch (error) {
    const probe = await run(dockerPath, ['ps', '-aq', '--filter', 'label=' + owner + '=' + turnId], { timeout: 10_000 });
    if (probe.stdout.trim()) throw error;
  }
}
