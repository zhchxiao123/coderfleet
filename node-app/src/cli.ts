// Backend command line. The desktop App runs `serve` for this computer; on a
// remote Docker host the installer runs `init`, then `serve` as a service.
//   serve [config]   start the service (default config: ~/.coderfleet-backend/config.json)
//   init [config]    create the configuration with a random token if missing; print it as JSON
//   status [config]  exit 0 when the configured service answers its health check
//   version          print the backend version
//   job list | show <conversation> | accept|discard <conversation> | start <project> <prompt>
//                    做完为止 jobs of the running service (config: --config <path>)
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serve } from './server.js';
import { atomicJSON, message, readConfig } from './state.js';
import { VERSION } from './version.js';

const home = process.env.CODERFLEET_BACKEND_HOME || join(homedir(), '.coderfleet-backend');
const argv = process.argv.slice(2);
const flag = argv.indexOf('--config');
const flagged = flag >= 0 ? argv.splice(flag, 2)[1] : undefined;
const [mode, rawPath] = argv;
const configPath = resolve(flagged || (mode === 'job' ? '' : rawPath) || join(home, 'config.json'));

const JOB_STATES: Readonly<Record<string, string>> = { working: '在做', waiting: '等你', review: '待验收', accepted: '已收下', discarded: '已丢弃' };
interface JobView { conversationId: string; projectId: string; title: string; branch: string; state: string; error?: string; mergeError?: string; createdAt: string;
  phase?: string; reason?: string; criteria?: { text: string; state: string; note: string }[];
  review?: { account: string; verdict: string; error?: string } }

/** Calls the running service with the configured token. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const config = readConfig(configPath);
  const response = await fetch('http://127.0.0.1:' + config.port + '/v1/' + path, {
    method, headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
  return result;
}

function jobLine(job: JobView): string {
  return [job.conversationId, (JOB_STATES[job.state] ?? job.state).padEnd(4, '　'), job.projectId, job.branch, job.title].join('  ');
}

async function jobCommand(verb: string | undefined, args: string[]): Promise<void> {
  if (verb === 'list') {
    const list = await call<JobView[]>('GET', 'jobs');
    console.log(list.length ? list.map(jobLine).join('\n') : '没有「做完为止」的事');
  } else if (verb === 'show' && args[0]) {
    const { job } = await call<{ job: JobView | null }>('GET', 'conversations/' + args[0] + '/job');
    if (!job) throw new Error('这个对话没有在做的事');
    console.log(jobLine(job));
    if (job.error) console.log('出错：' + job.error);
    if (job.criteria?.length) {
      console.log('做完的标准：');
      for (const item of job.criteria) console.log('  ' + (item.state === 'done' ? '✓' : item.state === 'ask' ? '?' : '·') + ' ' + item.text + (item.note ? ' —— ' + item.note : ''));
    } else console.log('做完的标准：还没有列出');
    if (job.reason === 'question') console.log('有标准要你来定（上面标 ? 的）');
    else if (job.reason === 'checks') console.log('改了几轮，还有标准没做到');
    if (job.phase === 'reviewing') console.log('审查中…');
    else if (job.review) console.log('审查（' + job.review.account + '）：' + ({ pass: '通过', changes: '要改', unclear: '没给出结论', failed: '没跑成' }[job.review.verdict] ?? job.review.verdict) + (job.review.error ? '，' + job.review.error : ''));
    if (job.mergeError) console.log(job.mergeError);
    const changes = await call<{ files: { path: string; added: number; removed: number }[]; added: number; removed: number }>('GET', 'conversations/' + args[0] + '/job/changes');
    console.log('变更 ' + changes.files.length + ' 个文件  +' + changes.added + ' -' + changes.removed);
    for (const file of changes.files) console.log('  +' + file.added + ' -' + file.removed + '  ' + file.path);
  } else if ((verb === 'accept' || verb === 'discard') && args[0]) {
    const { job } = await call<{ job: JobView }>('POST', 'conversations/' + args[0] + '/job/' + verb, {});
    console.log(jobLine(job));
  } else if (verb === 'start' && args[0] && args[1]) {
    const conversation = await call<{ id: string }>('POST', 'conversations', { projectId: args[0] });
    try { await call('POST', 'conversations/' + conversation.id + '/turns', { prompt: args.slice(1).join(' '), job: true }); }
    catch (error) { await call('DELETE', 'conversations/' + conversation.id).catch(() => undefined); throw error; }
    console.log(conversation.id);
  } else if (verb === 'continue' && args[0] && args[1]) {
    // In a conversation already going: from this message on it is a job.
    await call('POST', 'conversations/' + args[0] + '/turns', { prompt: args.slice(1).join(' '), job: true });
    console.log(args[0]);
  } else throw new Error('Usage: coderfleet-backend job list | show <conversation> | accept|discard <conversation> | start <project> <prompt> | continue <conversation> <prompt> [--config config.json]');
}

try {
  if (mode === 'serve') {
    // Turns run in containers, so stopping the service never stops their work.
    const stop = (): void => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3_000).unref();
    };
    const server = await serve(configPath, { onShutdown: stop });
    console.log(new Date().toISOString() + ' CoderFleet backend ' + VERSION + ' (pid ' + process.pid + ') listening on ' + JSON.stringify(server.address()));
    const close = () => server.close();
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  } else if (mode === 'init') {
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      atomicJSON(configPath, {
        port: Number(process.env.CODERFLEET_BACKEND_PORT) || 8877,
        token: randomBytes(32).toString('base64url'),
        workspace: process.env.CODERFLEET_WORKSPACE || join(homedir(), '.coderfleet'),
        stateDirectory: join(dirname(configPath), 'state'),
      });
    }
    const config = readConfig(configPath);
    console.log(JSON.stringify({ port: config.port, token: config.token, version: VERSION, configPath, workspace: config.workspace }));
  } else if (mode === 'status') {
    const config = readConfig(configPath);
    const response = await fetch('http://127.0.0.1:' + config.port + '/v1/health', {
      headers: { Authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(3_000),
    });
    const health = await response.json() as { build?: string };
    if (!response.ok) throw new Error('Health check failed with HTTP ' + response.status);
    console.log(JSON.stringify({ running: true, version: health.build ?? '' }));
  } else if (mode === 'job') {
    await jobCommand(argv[1], argv.slice(2));
  } else if (mode === 'version') {
    console.log(VERSION);
  } else throw new Error('Usage: coderfleet-backend serve|init|status [config.json] | job … | version');
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
