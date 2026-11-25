// Subscription usage (5-hour and 7-day windows) of logged-in Claude Code and
// Codex accounts; a port of coderfleet/usage_probe.py and the scheduler's
// polling. The request is made inside one of the account's running containers
// with the container's python3, so it leaves through the container's network
// (the relay) like the account's own traffic; this service never calls the
// usage endpoints itself. Tokens are only read: the CLI refreshes them.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Account, type WorkspaceProject } from './conf.js';
import { assertContainer, execText } from './docker.js';
import { message, record, text } from './state.js';

export interface UsageWindow {
  /** Percent used, 0–100. */
  readonly used: number;
  readonly resetsAt: string;
}

export interface AccountUsage {
  readonly fiveHour?: UsageWindow;
  readonly sevenDay?: UsageWindow;
  readonly plan: string;
  readonly fetchedAt: string;
  /** Why the latest probe gave no numbers; the windows are then the last ones read. */
  readonly error: string;
}

const BUSY_DELAY = 300_000;
const IDLE_DELAY = 3_600_000;
const PROBE_TIMEOUT = 25_000;

const REQUEST = `
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        print(json.dumps({"status": resp.status, "body": resp.read().decode()}))
except urllib.error.HTTPError as e:
    print(json.dumps({"status": e.code, "body": e.read().decode(errors="ignore")}))
except Exception as e:
    print(json.dumps({"error": "network_error"}))
`;

const CLAUDE_SCRIPT = `
import json, sys, urllib.request, urllib.error
try:
    with open("/home/byclaw/.claude/.credentials.json") as f:
        oauth = json.load(f)["claudeAiOauth"]
    token = oauth["accessToken"]
    print(json.dumps({"plan": oauth.get("subscriptionType", "")}))
except Exception:
    print(json.dumps({"error": "no_credentials"}))
    sys.exit(0)
req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
    "Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json",
    "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.197",
})
` + REQUEST;

const CODEX_SCRIPT = `
import json, sys, urllib.request, urllib.error
try:
    with open("/home/byclaw/.codex/auth.json") as f:
        tokens = json.load(f).get("tokens") or {}
    token = tokens["access_token"]
except Exception:
    print(json.dumps({"error": "no_credentials"}))
    sys.exit(0)
headers = {"Authorization": "Bearer " + token, "Accept": "application/json", "User-Agent": "codex_cli_rs/0.142.5"}
if tokens.get("account_id"):
    headers["ChatGPT-Account-Id"] = tokens["account_id"]
req = urllib.request.Request("https://chatgpt.com/backend-api/wham/usage", headers=headers)
` + REQUEST;

export function usageSupported(account: Account): boolean {
  return (account.type === 'claude' || account.type === 'codex') && account.auth === 'login' && account.runtime === 'container';
}

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}

function claudeWindow(value: unknown): UsageWindow | undefined {
  const raw = record(value);
  const used = percent(raw.utilization);
  return used === undefined ? undefined : { used, resetsAt: text(raw.resets_at) };
}

function codexWindow(value: unknown): UsageWindow | undefined {
  const raw = record(value);
  const used = percent(raw.used_percent);
  if (used === undefined) return undefined;
  return { used, resetsAt: typeof raw.reset_at === 'number' ? new Date(raw.reset_at * 1000).toISOString() : '' };
}

/** The probe prints one JSON object per line: the plan (Claude), then the response or an error. */
export function parseProbe(type: string, stdout: string, fetchedAt: string): AccountUsage {
  const failed = (error: string): AccountUsage => ({ plan: '', fetchedAt, error });
  let plan = '';
  let response: Record<string, unknown> | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try { parsed = record(JSON.parse(line)); } catch { continue; }
    if (typeof parsed.plan === 'string') plan = parsed.plan;
    else response = parsed;
  }
  if (!response) return failed('empty_response');
  if (response.error) return failed(text(response.error));
  const status = response.status;
  if (status === 401 || (type === 'codex' && status === 403)) return failed('unauthorized');
  if (status === 429) return failed('rate_limited');
  if (status !== 200) return failed('http_' + String(status));
  let data: Record<string, unknown>;
  try { data = record(JSON.parse(text(response.body))); } catch { return failed('invalid_json'); }
  if (type === 'codex') {
    const limits = record(data.rate_limit);
    return { fiveHour: codexWindow(limits.primary_window), sevenDay: codexWindow(limits.secondary_window), plan: text(data.plan_type), fetchedAt, error: '' };
  }
  return { fiveHour: claudeWindow(data.five_hour), sevenDay: claudeWindow(data.seven_day), plan, fetchedAt, error: '' };
}

/** The account has no running container to ask from. */
export class NoContainerError extends Error {}

export class UsageTracker {
  private readonly probing = new Map<string, Promise<AccountUsage>>();
  private polling = false;

  public constructor(private readonly workspace: string, private readonly dockerPath: string) {}

  private path(name: string): string { return join(this.workspace, 'accounts', name, 'usage-cache.json'); }

  /**
   * The last result, from the file the Python service also writes
   * (`accounts/<name>/usage-cache.json`), so the two services share probes.
   */
  public cached(name: string): AccountUsage | undefined {
    let raw: Record<string, unknown>;
    try { raw = record(JSON.parse(readFileSync(this.path(name), 'utf8'))); } catch { return undefined; }
    const fetchedAt = text(raw.fetched_at);
    if (!fetchedAt) return undefined;
    return { fiveHour: claudeWindow(raw.five_hour), sevenDay: claudeWindow(raw.seven_day), plan: text(raw.subscription_type), fetchedAt, error: text(raw.error) };
  }

  private save(name: string, usage: AccountUsage): void {
    const window = (value?: UsageWindow) => value ? { utilization: value.used, resets_at: value.resetsAt || null } : null;
    const path = this.path(name);
    if (!existsSync(join(this.workspace, 'accounts', name))) return;
    const temporary = path + '.' + process.pid + '.tmp';
    writeFileSync(temporary, JSON.stringify({
      five_hour: window(usage.fiveHour), seven_day: window(usage.sevenDay), subscription_type: usage.plan, fetched_at: usage.fetchedAt, error: usage.error,
    }));
    renameSync(temporary, path);
  }

  /** Probes now from one of the account's running containers; concurrent calls share one probe. */
  public refresh(account: Account, projects: readonly WorkspaceProject[]): Promise<AccountUsage> {
    const running = this.probing.get(account.name);
    if (running) return running;
    const probe = this.probe(account, projects).finally(() => this.probing.delete(account.name));
    this.probing.set(account.name, probe);
    return probe;
  }

  private async probe(account: Account, projects: readonly WorkspaceProject[]): Promise<AccountUsage> {
    let container = '';
    let refused: unknown;
    for (const project of projects) {
      if (project.account.name !== account.name) continue;
      // Also refuses a relay account's container that could reach the network directly.
      try { await assertContainer(this.dockerPath, project); container = project.container; break; } catch (error) { refused = error; }
    }
    if (!container) throw new NoContainerError(refused ? message(refused) : 'The account has no project');
    const fetchedAt = new Date().toISOString();
    let usage: AccountUsage;
    try {
      usage = parseProbe(account.type, await execText(this.dockerPath, container, ['python3', '-c', account.type === 'codex' ? CODEX_SCRIPT : CLAUDE_SCRIPT], PROBE_TIMEOUT), fetchedAt);
    } catch { usage = { plan: '', fetchedAt, error: 'probe_failed' }; }
    if (usage.error) {
      // Keep the last numbers next to the error; a signed-out account has none to trust.
      const last = usage.error === 'unauthorized' || usage.error === 'no_credentials' ? undefined : this.cached(account.name);
      usage = { ...usage, fiveHour: last?.fiveHour, sevenDay: last?.sevenDay, plan: last?.plan ?? '' };
    }
    this.save(account.name, usage);
    return usage;
  }

  /**
   * Probes the accounts whose last result is old: 5 minutes while one of the
   * account's turns runs, otherwise an hour. Accounts without a running
   * container are left as they are.
   */
  public async poll(accounts: readonly Account[], projects: readonly WorkspaceProject[], busy: ReadonlySet<string>): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const account of accounts) {
        if (!usageSupported(account)) continue;
        const last = Date.parse(this.cached(account.name)?.fetchedAt ?? '');
        if (Date.now() - last < (busy.has(account.name) ? BUSY_DELAY : IDLE_DELAY)) continue;
        await this.refresh(account, projects).catch(() => undefined);
      }
    } finally { this.polling = false; }
  }
}
