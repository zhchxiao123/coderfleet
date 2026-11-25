// Backend command line. The desktop App runs `serve` for this computer; on a
// remote Docker host the installer runs `init`, then `serve` as a service.
//   serve [config]   start the service (default config: ~/.coderfleet-backend/config.json)
//   init [config]    create the configuration with a random token if missing; print it as JSON
//   status [config]  exit 0 when the configured service answers its health check
//   version          print the backend version
//   job list | show <conversation> | accept|discard <conversation> | start <project> <prompt>
//                    做完为止 jobs of the running service (config: --config <path>)
//   schedule list | show <id> | add <project> <rule> <prompt> [--job] | edit <id> … | on|off|run|remove <id>
//                    定时: things the service starts by itself (rule: daily HH:MM | weekly 1,3 HH:MM | every <hours>)
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ruleFromWords } from './schedules.js';
import { serve } from './server.js';
import { atomicJSON, message, readConfig } from './state.js';
import { VERSION } from './version.js';

const home = process.env.CODERFLEET_BACKEND_HOME || join(homedir(), '.coderfleet-backend');
const argv = process.argv.slice(2);
const flag = argv.indexOf('--config');
const flagged = flag >= 0 ? argv.splice(flag, 2)[1] : undefined;
const [mode, rawPath] = argv;
const configPath = resolve(flagged || (mode === 'job' || mode === 'schedule' ? '' : rawPath) || join(home, 'config.json'));

const JOB_STATES: Readonly<Record<string, string>> = { working: '在做', waiting: '等你', review: '待验收', accepted: '已收下', discarded: '已丢弃' };
interface JobView { conversationId: string; projectId: string; title: string; branch: string; state: string; error?: string; mergeError?: string; mergedInto?: string; createdAt: string;
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
    const { job, earlier } = await call<{ job: JobView | null; earlier?: JobView[] }>('GET', 'conversations/' + args[0] + '/job');
    if (!job) throw new Error('这个对话没有在做的事');
    // The conversation's earlier jobs first, then the current one in full.
    for (const past of earlier ?? []) console.log(jobLine(past));
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
    if (job.reason === 'merge') console.log('收下了，还没有合并：它在对话里说了原因，回它一句它就接着合并');
    if (job.mergeError) console.log(job.mergeError);
    if (job.state === 'accepted') console.log(job.mergedInto ? '合并进了 ' + job.mergedInto : '没有要合并的改动');
    const changes = await call<{ files: { path: string; added: number; removed: number }[]; added: number; removed: number }>('GET', 'conversations/' + args[0] + '/job/changes');
    console.log('变更 ' + changes.files.length + ' 个文件  +' + changes.added + ' -' + changes.removed);
    for (const file of changes.files) console.log('  +' + file.added + ' -' + file.removed + '  ' + file.path);
  } else if ((verb === 'accept' || verb === 'discard') && args[0]) {
    const { job } = await call<{ job: JobView }>('POST', 'conversations/' + args[0] + '/job/' + verb, {});
    console.log(jobLine(job));
    // Accepting hands the merge to the agent: where it goes, or what it asks, is in the conversation.
    if (verb === 'accept') console.log('已经让它合并：合并好就自动收下；它拿不准合并到哪会先问，用 job show ' + args[0] + ' 看结果');
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

interface RunView { at: string; result: string; conversationId?: string; note?: string; manual?: boolean; gone?: boolean; name?: string; status?: string; error?: string; job?: string }
interface ScheduleView { id: string; projectId: string; prompt: string; label: string; job: boolean; enabled: boolean; nextAt: string; busy: boolean; last: RunView | null; runs?: RunView[] }

const stamp = (iso: string): string => {
  const date = new Date(iso);
  const two = (value: number): string => String(value).padStart(2, '0');
  return Number.isFinite(date.getTime()) ? two(date.getMonth() + 1) + '-' + two(date.getDate()) + ' ' + two(date.getHours()) + ':' + two(date.getMinutes()) : '';
};
function scheduleLine(item: ScheduleView): string {
  return [item.id, item.enabled ? '开' : '关', item.projectId, item.label + (item.job ? ' · 做完为止' : ''), item.enabled ? '下次 ' + stamp(item.nextAt) : '已停用',
    item.prompt.replace(/\s+/g, ' ').slice(0, 60)].join('  ');
}
/** What became of a run, in the words the App uses. */
function runText(run: RunView): string {
  if (run.result === 'skipped') return '跳过：上次还在做';
  if (run.result === 'missed') return '错过';
  if (run.result === 'starting') return '正在开始';
  if (run.result === 'failed') return '没开始：' + (run.note ?? '');
  if (run.gone) return '对话已删除';
  const state = run.job ? JOB_STATES[run.job] ?? run.job
    : run.status === 'done' ? '做完了' : run.status === 'failed' ? '失败' + (run.error ? '：' + run.error : '') : run.status === 'cancelled' ? '已停止' : '在做';
  return state + '  ' + run.conversationId + '  ' + (run.name ?? '');
}

const SCHEDULE_USAGE = 'Usage: coderfleet-backend schedule list | show <id> | add <project> <rule> <prompt> [--job] | edit <id> rule <rule> | edit <id> prompt <prompt>'
  + ' | edit <id> job on|off | edit <id> project <project> | on|off|run|remove <id> [--config config.json]\n  rule: daily HH:MM | weekly 1,3 HH:MM (1 = 周一 … 7 = 周日) | every <小时数>';

async function scheduleCommand(verb: string | undefined, args: string[]): Promise<void> {
  const [id, field, ...rest] = args;
  if (verb === 'list') {
    const list = await call<ScheduleView[]>('GET', 'schedules');
    console.log(list.length ? list.map(scheduleLine).join('\n') : '没有定时');
  } else if (verb === 'show' && id) {
    const item = await call<ScheduleView>('GET', 'schedules/' + id);
    console.log(scheduleLine(item));
    console.log(item.prompt);
    console.log(item.runs?.length ? item.runs.map(run => '  ' + stamp(run.at) + (run.manual ? ' 手动' : '') + '  ' + runText(run)).join('\n') : '还没有跑过');
  } else if (verb === 'add' && id) {
    const words = args.slice(1).filter(word => word !== '--job');
    const { rule, used } = ruleFromWords(words);
    const prompt = words.slice(used).join(' ');
    if (!prompt) throw new Error(SCHEDULE_USAGE);
    console.log(scheduleLine(await call<ScheduleView>('POST', 'schedules', { projectId: id, rule, prompt, job: args.includes('--job') })));
  } else if (verb === 'edit' && id && field && rest.length) {
    const change = field === 'rule' ? { rule: ruleFromWords(rest).rule } : field === 'prompt' ? { prompt: rest.join(' ') }
      : field === 'job' && (rest[0] === 'on' || rest[0] === 'off') ? { job: rest[0] === 'on' } : field === 'project' ? { projectId: rest[0] } : undefined;
    if (!change) throw new Error(SCHEDULE_USAGE);
    console.log(scheduleLine(await call<ScheduleView>('PUT', 'schedules/' + id, change)));
  } else if ((verb === 'on' || verb === 'off') && id) {
    console.log(scheduleLine(await call<ScheduleView>('PUT', 'schedules/' + id, { enabled: verb === 'on' })));
  } else if (verb === 'run' && id) {
    console.log((await call<{ conversationId: string }>('POST', 'schedules/' + id + '/run', {})).conversationId);
  } else if (verb === 'remove' && id) {
    await call('DELETE', 'schedules/' + id);
    console.log('已删除 ' + id);
  } else throw new Error(SCHEDULE_USAGE);
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
  } else if (mode === 'schedule') {
    await scheduleCommand(argv[1], argv.slice(2));
  } else if (mode === 'version') {
    console.log(VERSION);
  } else throw new Error('Usage: coderfleet-backend serve|init|status [config.json] | job … | schedule … | version');
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
