// Container and image lifecycle, following coderfleet/docker_ops.py: every
// change regenerates docker-compose.yml, then runs `docker compose` against
// the services of the affected project. Long-running Docker commands run as
// operations whose output the desktop client polls.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { imageName, writeCompose } from './compose.js';
import { loadConfig, readWorkspace, removeProject, truthy, WorkspaceError, type WorkspaceProject } from './conf.js';

const run = promisify(execFile);
const MAX_OUTPUT = 2 * 1024 * 1024;

export type OperationKind = 'build' | 'start' | 'stop' | 'restart' | 'remove';
export type OperationStatus = 'running' | 'succeeded' | 'failed';
export interface Operation {
  readonly id: string;
  readonly kind: OperationKind;
  readonly target: string;
  readonly startedAt: string;
  status: OperationStatus;
  output: string;
  finishedAt?: string;
  error?: string;
}

export interface ContainerState { readonly name: string; readonly state: string; readonly status: string }

export class Lifecycle {
  private readonly operations = new Map<string, Operation>();
  private readonly busy = new Map<string, string>();

  public constructor(private readonly workspace: string, private readonly dockerPath: string) {}

  public operation(id: string): Operation | undefined { return this.operations.get(id); }
  public recent(): Operation[] {
    return [...this.operations.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 30);
  }

  /** States of all CoderFleet-related containers, from one `docker ps` call. */
  public async containers(): Promise<Map<string, ContainerState>> {
    const { stdout } = await run(this.dockerPath, ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'], { timeout: 10_000, maxBuffer: 4_000_000 });
    const result = new Map<string, ContainerState>();
    for (const line of stdout.split('\n')) {
      const [name, state, status] = line.split('\t');
      if (name) result.set(name, { name, state: state ?? '', status: status ?? '' });
    }
    return result;
  }

  public async image(): Promise<{ name: string; exists: boolean; dockerfile: boolean }> {
    const name = imageName(loadConfig(this.workspace));
    let exists = true;
    try { await run(this.dockerPath, ['image', 'inspect', '--format', '{{.Id}}', name], { timeout: 10_000 }); }
    catch { exists = false; }
    return { name, exists, dockerfile: existsSync(join(this.workspace, 'Dockerfile')) };
  }

  public async dockerAvailable(): Promise<string> {
    try {
      const { stdout } = await run(this.dockerPath, ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
      return stdout.trim();
    } catch { return ''; }
  }

  private project(name: string): WorkspaceProject {
    const project = readWorkspace(this.workspace).projects.find(item => item.name === name);
    if (!project) throw new WorkspaceError('项目不存在');
    if (project.account.runtime !== 'container') throw new WorkspaceError('该项目的账号不使用容器');
    return project;
  }

  private services(project: WorkspaceProject): string[] {
    return truthy(project.record.IDE ?? 'off') ? [project.service, 'ide-project-' + project.name] : [project.service];
  }

  private compose(): string[] { return ['compose', '-f', join(this.workspace, 'docker-compose.yml')]; }

  private start(kind: OperationKind, target: string, steps: (log: (text: string) => void, exec: (args: string[]) => Promise<void>) => Promise<void>): Operation {
    const key = kind === 'build' ? 'image' : 'project:' + target;
    const current = this.busy.get(key);
    if (current) throw new WorkspaceError('另一个操作正在进行，请等它完成');
    const operation: Operation = { id: randomUUID(), kind, target, startedAt: new Date().toISOString(), status: 'running', output: '' };
    this.operations.set(operation.id, operation);
    this.busy.set(key, operation.id);
    const log = (text: string): void => {
      operation.output += text;
      if (operation.output.length > MAX_OUTPUT) operation.output = operation.output.slice(-MAX_OUTPUT);
    };
    const exec = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
      log('$ docker ' + args.join(' ') + '\n');
      const child = spawn(this.dockerPath, args, { cwd: this.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => log(String(chunk)));
      child.stderr.on('data', chunk => log(String(chunk)));
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('docker ' + args[0] + ' 退出码 ' + code)));
    });
    void steps(log, exec).then(
      () => { operation.status = 'succeeded'; },
      error => { operation.status = 'failed'; operation.error = error instanceof Error ? error.message : String(error); log('\n' + operation.error + '\n'); },
    ).finally(() => {
      operation.finishedAt = new Date().toISOString();
      this.busy.delete(key);
    });
    return operation;
  }

  /** Regenerates docker-compose.yml; returns the number of container projects. */
  public async writeCompose(): Promise<number> {
    return (await writeCompose(this.workspace, this.dockerPath)).projects;
  }

  public build(): Operation {
    const config = loadConfig(this.workspace);
    const dockerfile = join(this.workspace, 'Dockerfile');
    if (!existsSync(dockerfile)) throw new WorkspaceError('工作区里没有 Dockerfile：' + dockerfile);
    const image = imageName(config);
    return this.start('build', image, async (_log, exec) => {
      // Image builds use Docker's own network, not the relay.
      await exec(['build', '--platform', config.BUILD_PLATFORM || 'linux/amd64', '--tag', image, '--file', dockerfile, this.workspace]);
    });
  }

  public startProject(name: string): Operation {
    const project = this.project(name);
    if (!project.active) throw new WorkspaceError('项目已停用，请先启用');
    return this.start('start', name, async (_log, exec) => {
      await this.writeCompose();
      await exec([...this.compose(), 'up', '-d', ...this.services(project)]);
    });
  }

  public stopProject(name: string): Operation {
    const project = this.project(name);
    return this.start('stop', name, async (_log, exec) => {
      await exec([...this.compose(), 'stop', ...this.services(project)]);
    });
  }

  public restartProject(name: string): Operation {
    const project = this.project(name);
    return this.start('restart', name, async (_log, exec) => {
      await this.writeCompose();
      await exec([...this.compose(), 'stop', ...this.services(project)]);
      await exec([...this.compose(), 'up', '-d', ...this.services(project)]);
    });
  }

  /** Stops and removes the project's containers, then removes it from projects.conf. Files stay. */
  public removeProject(name: string): Operation {
    const project = this.project(name);
    return this.start('remove', name, async (log, exec) => {
      const containers = await this.containers();
      for (const container of [project.container, 'coderfleet-ide-' + project.name]) {
        if (containers.has(container)) await exec(['rm', '--force', container]);
      }
      removeProject(this.workspace, name);
      if (readWorkspace(this.workspace).projects.some(item => item.active && item.account.runtime === 'container')) await this.writeCompose();
      log('已从 projects.conf 移除；项目目录和账号数据保留。\n');
    });
  }
}
