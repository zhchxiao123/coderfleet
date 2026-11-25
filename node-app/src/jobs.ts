// 做完为止: a conversation that works in its own git worktree and branch until the
// user accepts (the agent merges it where it belongs) or discards it.
// A job is a record attached to one conversation, kept in the backend's own
// state directory; every git operation runs inside the project's container.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type WorkspaceProject } from './conf.js';
import { assertContainer, containerPath, quote } from './docker.js';
import { atomicJSON, record, text } from './state.js';

const run = promisify(execFile);
const WORK = '.coderfleet-work';
const ROOT = containerPath('').replace(/\/$/, '');
/** Kept out of `git status` in the project and in every worktree of it. */
const EXCLUDED = ['/' + WORK + '/', '/.coderfleet-uploads', '/.coderfleet-tasks/'];

/**
 * working: a turn runs (or the next one is about to start);
 * waiting: the last turn failed or was stopped — the user says how to go on;
 * review: the agent stopped by itself — accept, ask for changes, or discard;
 * accepted | discarded: closed, its worktree and branch are gone.
 */
export type JobState = 'working' | 'waiting' | 'review' | 'accepted' | 'discarded';
export interface ChangedFile { readonly path: string; readonly added: number; readonly removed: number; readonly status: 'added' | 'modified' | 'deleted' }
export interface Changes { readonly files: ChangedFile[]; readonly added: number; readonly removed: number }
/**
 * One line of what "done" means for this job. The agent writes the list itself, from the
 * PRD or issue it was given or from the user's words, as a fenced block in its reply:
 *   ```标准
 *   - [ ] 还没做到的
 *   - [x] 做到了的 —— 证据
 *   - [?] 要用户定的 —— 要定什么
 *   ```
 * The latest block in the conversation is the current list, whoever wrote it (the author
 * when it starts and stops, the reviewer when it has checked each line).
 */
export interface Criterion { readonly text: string; readonly state: 'open' | 'done' | 'ask'; readonly note: string }
/** What the reviewer said about the changes. `unclear`: it gave no verdict line; `failed`: its turn did not finish. */
export interface Review {
  readonly account: string;
  readonly verdict: 'pass' | 'changes' | 'unclear' | 'failed';
  readonly turnId: string;
  readonly error?: string;
  readonly at: string;
}
/** The work goes back to the agent this many times (criteria not met, or the reviewer wants changes) before the user is asked. */
export const CHECK_ROUNDS = 3;

export interface Job {
  readonly id: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly branch: string;
  /** The worktree, as a container path. */
  readonly directory: string;
  /** The commit the branch started from, and the branch checked out in the project then. */
  readonly base: string;
  readonly baseBranch: string;
  /** The project had uncommitted changes at the start; they are not in the worktree. */
  readonly dirtyAtStart: boolean;
  readonly state: JobState;
  /** While working: the reviewer's turn runs (the author's does not). */
  readonly phase?: 'reviewing';
  /** Times the work went back to the agent since the user last spoke. */
  readonly round?: number;
  /** The last review. */
  readonly review?: Review;
  /**
   * Why it waits: `failed`, `stopped` (the turn's error comes with it); `question`: a criterion
   * needs the user's decision; `checks` / `review`: criteria still unmet, or the reviewer still
   * wanting changes, after CHECK_ROUNDS rounds; `merge`: accepted, but the agent's turn ended
   * with the branch not merged (it asked where to, or could not).
   */
  readonly reason?: string;
  readonly error?: string;
  /**
   * The user accepted: the agent has been asked to merge the branch. From then on each of its
   * turns ends with a look at whether the branch is merged, instead of the criteria.
   */
  readonly accepting?: boolean;
  /** What the last look found still missing. */
  readonly mergeError?: string;
  /** What was merged, kept after the worktree is gone, and the branch it went into ('' when there was nothing to merge into any). */
  readonly merged?: Changes;
  readonly mergedInto?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt?: string;
}

export function open(job: Job): boolean { return job.state !== 'accepted' && job.state !== 'discarded'; }

/** What the first turn of a job is told before the user's own words. `continued`: the conversation was already going when the job started. */
export function preamble(job: Job, continued = false): string {
  return [
    (continued ? '从现在起，这件事换到一个独立的工作目录里做：' : '你在一个独立的工作目录里做这件事：') + job.directory + '（git 分支 ' + job.branch + '，从 ' + ROOT + ' 现在的提交分出来）。',
    ...(continued ? ['- 前面对话里说过的需求和定下的做法都算数。'] : []),
    ...(job.dirtyAtStart ? ['- ' + ROOT + ' 里还没提交的改动不在这个目录里；这件事要用到它们的话，先告诉我。'] : []),
    '- 只改这个目录里的文件；不要改 ' + ROOT + ' 下的其他位置，不要切换分支，不要合并或推送。',
    '- 这个目录是新建的，依赖还没有装；要跑测试就先自己装。',
    '- 能自己决定的不要问我，直接决定，最后说明你定了什么、哪些没有验证。',
    '',
    '动手之前，先定下「做完的标准」：几条能逐条验证的话，说的是结果，不是步骤。',
    '- 我给了 PRD、issue 或别的需求文件，就从里面的验收标准来；没有就按我说的话（包括前面聊定的）定。项目自己的规矩（比如要求跑的测试）也算。',
    '- 写成下面这样的代码块，然后直接开工，不用等我确认：',
    '', '```标准', '- [ ] 第一条标准', '- [ ] 第二条标准', '```', '',
    '- 之后我在对话里要求增删标准，就照着改。',
    '- 停下之前逐条核对，把这个代码块完整地再写一遍：做到的写 `- [x] 标准 —— 证据`（跑了什么、结果怎样）；',
    '  必须由我来定、你定不了的写 `- [?] 标准 —— 要我定什么`；没做到的不要停，接着做。',
    '- 你停下之后，会有另一个 AI 只读地逐条核对，所以证据要经得起查。不要为了通过而删改测试或标准。',
    '', '要做的事：', '',
  ].join('\n');
}

const FENCE = /^[ \t]*```[ \t]*(?:标准|做完的标准)[ \t]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
/** The criteria in one reply: its last ```标准 block; undefined when it has none. */
export function criteriaIn(answer: string): Criterion[] | undefined {
  const body = [...answer.replace(/\r\n?/g, '\n').matchAll(FENCE)].at(-1)?.[1];
  if (body === undefined) return undefined;
  const items: Criterion[] = [];
  for (const line of body.split('\n')) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX?？])\]\s*)?(.+)$/.exec(line);
    if (!item) continue;
    const [text, ...note] = (item[2] as string).split(/\s+(?:——|--|—)\s+/);
    const mark = item[1] ?? ' ';
    items.push({ text: (text as string).trim(), state: mark === ' ' ? 'open' : /x/i.test(mark) ? 'done' : 'ask', note: note.join(' —— ').trim() });
  }
  return items;
}

/** The job's current criteria: the latest list any of its turns wrote. */
export function criteria(turns: readonly { answer: string }[]): Criterion[] {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const found = criteriaIn((turns[index] as { answer: string }).answer);
    if (found?.length) return found;
  }
  return [];
}

function listed(items: readonly Criterion[]): string {
  return ['```标准', ...items.map(item => '- [' + (item.state === 'done' ? 'x' : item.state === 'ask' ? '?' : ' ') + '] ' + item.text + (item.note ? ' —— ' + item.note : '')), '```'].join('\n');
}

/** What the agent is told when it stopped with no criteria, or with some not met. */
export function unmetFeedback(items: readonly Criterion[], round: number): string {
  if (!items.length) {
    return ['你停下了，但没有列出「做完的标准」（第 ' + round + ' 轮，最多 ' + CHECK_ROUNDS + ' 轮）。',
      '请按要做的事定下标准，逐条核对，写成：', '', '```标准', '- [x] 标准 —— 证据', '```', '',
      '没做到的接着做完；必须由我来定的写 `- [?] 标准 —— 要我定什么`。'].join('\n');
  }
  return ['你停下了，但这些标准还没有做到（第 ' + round + ' 轮，最多 ' + CHECK_ROUNDS + ' 轮）：', '',
    ...items.filter(item => item.state === 'open').map(item => '- ' + item.text), '',
    '接着做，做到后把整个 ```标准 代码块连同证据再写一遍。确实必须由我来定的，把那条写成 `- [?] 标准 —— 要我定什么`。'].join('\n');
}

/** What the reviewer is asked: check the changes against each criterion, change nothing, end with a verdict line. */
export function reviewPrompt(job: Job, task: string, items: readonly Criterion[]): string {
  return [
    '请核对另一个 AI 在这个目录里做的改动：' + job.directory + '（git 分支 ' + job.branch + '）。',
    '- 全部改动是 `git diff ' + job.base + '`（包含还没提交的）；新建的文件用 `git status --short` 找。',
    '- 只读：不要修改、创建或删除任何文件，不要提交。可以运行测试来验证。',
    '- 下面是这件事「做完的标准」和它自己给的证据。逐条核对：看改动，必要时自己跑一遍，不要只信它的说法。',
    '- 另外只找真问题：会出错的、漏掉的情况、和周围代码明显不一致的。不挑风格，不提可有可无的建议。',
    '- 把标准原样抄成下面的代码块：确实做到的写 `- [x] 标准 —— 你核对到的证据`，没做到的写 `- [ ] 标准 —— 差在哪`。',
    '- 最后单独一行写结论：有标准没做到或有必须改的问题写 `结论：要改`，否则写 `结论：通过`。',
    '', listed(items), '', '它被要求做的事：', task,
  ].join('\n');
}

/** The reviewer's verdict: its verdict line, and no criterion it left unmet; `unclear` when it gave no line. */
export function reviewVerdict(answer: string): 'pass' | 'changes' | 'unclear' {
  const found = [...answer.matchAll(/结论\s*[:：]\s*[`*]*\s*(通过|要改)/g)].at(-1)?.[1];
  if (criteriaIn(answer)?.some(item => item.state !== 'done')) return 'changes';
  return found === '通过' ? 'pass' : found === '要改' ? 'changes' : 'unclear';
}

/** What the author is told when the reviewer asked for changes. */
export function reviewFeedback(account: string, answer: string): string {
  return [
    '另一个 AI（' + account + '）核对了你的改动，认为要改。它的意见：', '', answer.trim(), '',
    '逐条处理：确实是问题的就改掉；你认为不成立的，说明理由，不用改。改完把整个 ```标准 代码块连同证据再写一遍。',
  ].join('\n');
}

/**
 * What the agent is told when the user accepts. Where the changes belong is its call: the
 * branch was cut from whatever the project had checked out, which need not be where they go.
 */
export function acceptPrompt(job: Job): string {
  return [
    '我收下这件事了，请把改动合并回去。前面「不要合并」的要求到此为止，其余照旧。',
    '- 先把工作目录 ' + job.directory + ' 里还没提交的改动提交到分支 ' + job.branch + '。',
    '- 合并到哪个分支由你判断：这个分支是从 ' + ROOT + (job.baseBranch ? ' 的 ' + job.baseBranch + ' 分支' : '') + '（提交 ' + job.base.slice(0, 12) + '）分出来的，一般合并回那里；'
      + '但对话里我说过别的去处，或者这件事的改动实际做在别的分支上，就按实际来。拿不准就先问我，不要猜。',
    '- 用普通的 git merge（不要 squash、rebase 或 cherry-pick），在检出了目标分支的那个目录里合并；不要替我切换 ' + ROOT + ' 的分支，不要动别人没提交的改动，不要推送。',
    '- 有冲突就解决并确认改动仍然正确；解决不了，或者目标分支现在合并不了，就停下告诉我原因。',
    '- 不要自己删除这个工作目录和分支 ' + job.branch + '：确认它已经合并进别的分支后，它们会被自动清理。',
    '- 最后用一两句话告诉我：合并进了哪个分支，或者为什么还没有合并。',
  ].join('\n');
}

export class JobError extends Error {}

export class Jobs {
  private readonly path: string;

  public constructor(stateDirectory: string, private readonly dockerPath: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.path = join(stateDirectory, 'jobs.json');
  }

  // ── Records ──────────────────────────────────────────

  private read(): Record<string, Job> {
    try {
      const raw = record(JSON.parse(readFileSync(this.path, 'utf8')));
      return Object.fromEntries(Object.entries(raw).filter(([, value]) => text(record(value).id))) as unknown as Record<string, Job>;
    } catch { return {}; }
  }

  /** One synchronous read-modify-write (no await between load and save). */
  private update<T>(change: (all: Record<string, Job>) => T): T {
    const all = this.read();
    const result = change(all);
    atomicJSON(this.path, all);
    return result;
  }

  public list(): Job[] { return Object.values(this.read()).sort((left, right) => right.createdAt.localeCompare(left.createdAt)); }

  public get(conversationId: string): Job | undefined { return this.read()[conversationId]; }

  /** Changes the job if it is still in one of `from` states; returns the saved job, or undefined when it was not. */
  public patch(conversationId: string, from: readonly JobState[], change: Partial<Job>): Job | undefined {
    return this.update(all => {
      const job = all[conversationId];
      if (!job || !from.includes(job.state)) return undefined;
      const next: Job = { ...job, ...change, updatedAt: new Date().toISOString() };
      // `undefined` in a change clears the field.
      for (const [key, value] of Object.entries(next)) if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
      all[conversationId] = next;
      return next;
    });
  }

  public forget(conversationId: string): void { this.update(all => { delete all[conversationId]; }); }

  // ── Git, inside the project container ────────────────

  private async exec(project: WorkspaceProject, argv: string[], timeout = 60_000): Promise<string> {
    try {
      const { stdout } = await run(this.dockerPath, ['exec', project.container, ...argv], { timeout, maxBuffer: 8_000_000 });
      return stdout;
    } catch (error) {
      const output = (text(record(error).stderr) + '\n' + text(record(error).stdout)).trim();
      throw new JobError(output.split('\n').slice(-12).join('\n') || 'git 命令失败');
    }
  }

  private git(project: WorkspaceProject, directory: string, ...args: string[]): Promise<string> {
    return this.exec(project, ['git', '-c', 'safe.directory=*', '-c', 'core.quotepath=false', '-C', directory, ...args]);
  }

  /** Commits need an author; a repository without one gets CoderFleet's. */
  private async identity(project: WorkspaceProject): Promise<string[]> {
    try { if ((await this.git(project, ROOT, 'config', 'user.email')).trim()) return []; } catch { /* not set */ }
    return ['-c', 'user.name=CoderFleet', '-c', 'user.email=coderfleet@localhost'];
  }

  /** Whether a job can start in this project, and why not. */
  public async support(project: WorkspaceProject): Promise<{ supported: boolean; reason: string }> {
    const no = (reason: string) => ({ supported: false, reason });
    if (project.account.type !== 'claude' && project.account.type !== 'codex') return no('目前只支持 Claude Code 和 Codex 账号');
    try { await assertContainer(this.dockerPath, project); } catch { return no('项目容器没有运行'); }
    let prefix = '';
    try { prefix = (await this.git(project, ROOT, 'rev-parse', '--show-prefix')).trim(); }
    catch { return no('项目不是 git 仓库，或它的 .git 在容器里访问不到'); }
    if (prefix) return no('项目目录不是 git 仓库的根目录');
    try { await this.git(project, ROOT, 'rev-parse', '--verify', '--quiet', 'HEAD'); }
    catch { return no('仓库还没有任何提交'); }
    return { supported: true, reason: '' };
  }

  /** Creates the record, then its worktree and branch from the project's HEAD. */
  public async start(project: WorkspaceProject, conversationId: string, id: string, title: string): Promise<Job> {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
    const branch = 'cf/' + (slug ? slug + '-' + id.slice(0, 4) : id);
    const now = new Date().toISOString();
    const draft: Job = {
      id, conversationId, projectId: project.name, title: title.replace(/\s+/g, ' ').slice(0, 80), branch, directory: ROOT + '/' + WORK + '/' + id,
      base: '', baseBranch: '', dirtyAtStart: false, state: 'working', createdAt: now, updatedAt: now,
    };
    this.update(all => {
      if (all[conversationId]) throw new JobError('这个对话已经有一件在做的事');
      all[conversationId] = draft;
    });
    try {
      const base = (await this.git(project, ROOT, 'rev-parse', 'HEAD')).trim();
      const baseBranch = (await this.git(project, ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
      // The shared exclude file: work directories, uploads and task files never show as changes.
      const exclude = EXCLUDED.map(line => 'grep -qxF ' + quote(line) + ' "$f" 2>/dev/null || echo ' + quote(line) + ' >> "$f"').join('; ');
      await this.exec(project, ['bash', '-c', 'set -e; cd ' + quote(ROOT) + '; d=$(git -c safe.directory=\'*\' rev-parse --git-common-dir); mkdir -p "$d/info"; f="$d/info/exclude"; ' + exclude]);
      const dirty = (await this.git(project, ROOT, 'status', '--porcelain')).trim() !== '';
      await this.git(project, ROOT, 'worktree', 'add', '-b', branch, draft.directory, base);
      // Attachments are resolved under the turn's directory; they live in the project's.
      await this.exec(project, ['ln', '-sfn', ROOT + '/.coderfleet-uploads', draft.directory + '/.coderfleet-uploads']);
      return this.patch(conversationId, ['working'], { base, baseBranch: baseBranch === 'HEAD' ? '' : baseBranch, dirtyAtStart: dirty }) as Job;
    } catch (error) {
      await this.remove(project, draft).catch(() => undefined);
      this.forget(conversationId);
      throw error;
    }
  }

  /** Everything the worktree differs from its base by, committed or not (the index is left alone). */
  public async changes(project: WorkspaceProject, job: Job): Promise<Changes> {
    if (!open(job)) return job.merged ?? { files: [], added: 0, removed: 0 };
    const script = [
      'set -e', 'cd ' + quote(job.directory), 'g() { git -c safe.directory=\'*\' -c core.quotepath=false "$@"; }',
      'export GIT_INDEX_FILE="$(mktemp -u)"', 'trap \'rm -f "$GIT_INDEX_FILE"\' EXIT',
      'g read-tree HEAD', 'g add -A', 'g diff --cached --no-renames --numstat ' + quote(job.base),
      'echo ---', 'g diff --cached --no-renames --name-status ' + quote(job.base),
    ].join('\n');
    const lines = (await this.exec(project, ['bash', '-c', script])).split('\n');
    const mark = lines.indexOf('---');
    const kinds = new Map(lines.slice(mark + 1).filter(Boolean).map(line => { const [kind, ...rest] = line.split('\t'); return [rest.join('\t'), kind] as const; }));
    const files = lines.slice(0, mark).filter(Boolean).map(line => {
      const [added, removed, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const kind = kinds.get(path);
      return { path, added: Number(added) || 0, removed: Number(removed) || 0, status: kind === 'A' ? 'added' as const : kind === 'D' ? 'deleted' as const : 'modified' as const };
    });
    return { files, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) };
  }

  private async remove(project: WorkspaceProject, job: Job): Promise<void> {
    await this.git(project, ROOT, 'worktree', 'remove', '--force', job.directory).catch(() => undefined);
    await this.exec(project, ['rm', '-rf', job.directory]).catch(() => undefined);
    await this.git(project, ROOT, 'worktree', 'prune').catch(() => undefined);
    await this.git(project, ROOT, 'branch', '-D', job.branch).catch(() => undefined);
  }

  /**
   * After a turn of an accepted job: when nothing is left uncommitted and the branch's commit
   * is in another local branch, the worktree and branch are removed and the job is closed.
   * Otherwise it waits for the user, with what is still missing in `mergeError`.
   */
  public async finish(project: WorkspaceProject, job: Job): Promise<Job> {
    const waiting = (mergeError: string): Job => this.patch(job.conversationId, ['working'], { state: 'waiting', phase: undefined, reason: 'merge', error: undefined, mergeError }) as Job;
    let tip = '';
    let holders: string[] = [];
    try {
      if ((await this.git(project, job.directory, 'status', '--porcelain')).trim()) return waiting('工作目录里还有没提交的改动。');
      tip = (await this.git(project, ROOT, 'rev-parse', '--verify', 'refs/heads/' + job.branch)).trim();
      holders = (await this.git(project, ROOT, 'for-each-ref', '--contains', tip, '--format=%(refname:short)', 'refs/heads'))
        .split('\n').map(line => line.trim()).filter(name => name && name !== job.branch);
    } catch (error) { return waiting('没能确认有没有合并：' + (error instanceof Error ? error.message : String(error)).split('\n').slice(-2).join(' ')); }
    // With no commit of its own there is nothing to merge.
    if (!holders.length && tip !== job.base) return waiting('分支 ' + job.branch + ' 还没有合并进别的分支。');
    const merged = await this.changes(project, job);
    await this.remove(project, job);
    return this.patch(job.conversationId, ['working'], {
      state: 'accepted', phase: undefined, accepting: undefined, merged, mergeError: undefined, reason: undefined, error: undefined, closedAt: new Date().toISOString(),
      mergedInto: holders.includes(job.baseBranch) ? job.baseBranch : holders.slice(0, 3).join('、'),
    }) as Job;
  }

  public async discard(project: WorkspaceProject, job: Job): Promise<Job> {
    await this.remove(project, job);
    return this.patch(job.conversationId, ['review', 'waiting', 'working'], { state: 'discarded', accepting: undefined, mergeError: undefined, closedAt: new Date().toISOString() }) as Job;
  }
}
