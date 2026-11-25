// Runs one program without a shell, in its own process group, with a fixed small
// environment. Everything it started dies with it: on timeout, on stop, and when
// the program itself exits.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';

export const TAIL_LINES = 200;
const TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2000;

/** What a command sees; nothing of the helper's own environment besides these. */
export function childEnvironment(path: readonly string[], platform: NodeJS.Platform = process.platform): Record<string, string> {
  const user = userInfo().username;
  const environment: Record<string, string> = {
    PATH: path.join(':'), HOME: homedir(), LANG: process.env.LANG || 'en_US.UTF-8',
    USER: user, LOGNAME: user, TMPDIR: tmpdir(),
  };
  if (platform === 'darwin' && process.env.DEVELOPER_DIR) environment.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
  return environment;
}

/** Keeps the end of a stream: at most TAIL_LINES lines and TAIL_BYTES characters. */
class Tail {
  private text = '';
  private dropped = false;
  add(chunk: string): void {
    this.text += chunk;
    if (this.text.length > TAIL_BYTES * 4) this.trim();
  }
  private trim(): void {
    if (this.text.length > TAIL_BYTES) { this.text = this.text.slice(-TAIL_BYTES); this.dropped = true; }
    const lines = this.text.split('\n');
    const keep = lines[lines.length - 1] === '' ? TAIL_LINES + 1 : TAIL_LINES;
    if (lines.length > keep) { this.text = lines.slice(-keep).join('\n'); this.dropped = true; }
  }
  end(): { text: string; truncated: boolean } {
    this.trim();
    return { text: this.text, truncated: this.dropped };
  }
}

export interface Outcome {
  readonly exit_code: number | null;
  readonly signal?: string;
  readonly timed_out: boolean;
  readonly stopped: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly seconds: number;
}

/** `stop(true)` kills at once instead of asking first. */
export interface Running { readonly done: Promise<Outcome>; stop(force?: boolean): void }

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* the group is already gone */ }
}

export function run(input: {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  /** Receives everything the program prints, in the order it arrives. */
  readonly logPath?: string;
}): Running {
  const started = Date.now();
  const log = input.logPath ? createWriteStream(input.logPath, { flags: 'wx', mode: 0o644 }) : undefined;
  log?.on('error', () => { /* a full disk must not take the helper down; the tail is still returned */ });
  const child = spawn(input.file, [...input.args], { cwd: input.cwd, env: input.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = new Tail();
  const stderr = new Tail();
  let timedOut = false;
  let stopped = false;
  let hard: NodeJS.Timeout | undefined;
  const terminate = (force = false): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    if (force) { killGroup(pid, 'SIGKILL'); return; }
    if (hard) return;
    killGroup(pid, 'SIGTERM');
    hard = setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout.add(chunk); log?.write(chunk); });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr.add(chunk); log?.write(chunk); });
  const done = new Promise<Outcome>((resolve, reject) => {
    let status: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('error', error => {
      clearTimeout(timer);
      log?.end();
      reject(error);
    });
    // The program is gone; whatever it left running in its group goes too, which also
    // closes the pipes so `close` below can fire.
    child.on('exit', (code, signal) => {
      status = { code, signal };
      if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      const out = stdout.end();
      const err = stderr.end();
      const finish = (): void => resolve({
        exit_code: (status ?? { code }).code,
        ...((status ?? { signal }).signal ? { signal: (status ?? { signal }).signal as string } : {}),
        timed_out: timedOut, stopped,
        stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated,
        seconds: Math.round((Date.now() - started) / 100) / 10,
      });
      if (log) log.end(finish); else finish();
    });
  });
  return { done, stop(force) { stopped = true; terminate(force); } };
}
