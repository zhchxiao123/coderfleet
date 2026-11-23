import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Acp, type AgentMessage } from './acp.js';
import { cleanContainer, launchAcp } from './docker.js';
import { entries, message, readConfig, record, Store, text, type Project, type Turn } from './state.js';

interface PendingPermission {
  readonly requestId: string | number;
  readonly key: string;
  readonly title: string;
  readonly details: string;
  readonly allow?: string;
  readonly deny?: string;
}

const TURN_TIMEOUT = 30 * 60 * 1000;
const APPROVAL_TIMEOUT = 10 * 60 * 1000;

class AntigravityTurn {
  private readonly permissions: PendingPermission[] = [];
  private approvalExpires = 0;
  private cancelled = false;
  private dirty = false;
  private lastSaved = 0;
  private permissionOpen = false;
  private asyncError?: Error;

  public constructor(
    private readonly store: Store,
    private readonly turn: Turn,
    private readonly rpc: Acp,
  ) {}

  public async run(): Promise<void> {
    this.rpc.onMessage(event => {
      try { this.onEvent(event); }
      catch (error) { this.asyncError = new Error(message(error)); }
    });
    const initialized = await this.rpc.request('initialize', {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'CoderFleet Node', version: '0.1.0' },
    });
    if (initialized.protocolVersion !== 1) throw new Error('Antigravity negotiated an unsupported ACP protocol');
    const capabilities = record(record(initialized.agentCapabilities).sessionCapabilities);
    const params = { cwd: '/workspace', mcpServers: [] };
    const resumeId = this.turn.resumeId;
    if (resumeId && !('resume' in capabilities)) throw new Error('The agent cannot resume the original session');
    const session = resumeId
      ? await this.rpc.request('session/resume', { ...params, sessionId: resumeId })
      : await this.rpc.request('session/new', params);
    if (resumeId && session.sessionId !== undefined && session.sessionId !== resumeId) {
      throw new Error('Antigravity returned a different session ID on resume');
    }
    const sessionId = resumeId || text(session.sessionId);
    if (!sessionId) throw new Error('Antigravity returned no session ID');
    this.turn.sessionId = sessionId;
    this.save();
    try {
      const options = entries(session.configOptions).filter(option => option.type === 'select');
      const mode = options.find(option => option.category === 'mode');
      if (mode && mode.currentValue !== 'default') {
        await this.rpc.request('session/set_config_option', { sessionId, configId: mode.id, value: 'default' });
      } else if (!mode && record(session.modes).currentModeId !== 'default') {
        if (!entries(record(session.modes).availableModes).some(item => item.id === 'default')) {
          throw new Error('Antigravity did not advertise a mode with explicit approval');
        }
        await this.rpc.request('session/set_mode', { sessionId, modeId: 'default' });
      }
      const model = options.find(option => option.category === 'model');
      const requestedModel = this.turn.requestedModel;
      if (requestedModel && !model) throw new Error('Antigravity did not advertise a model selector');
      if (model && requestedModel && model.currentValue !== requestedModel) {
        await this.rpc.request('session/set_config_option', { sessionId, configId: model.id, value: requestedModel });
      }
      this.turn.model = requestedModel || text(model?.currentValue);
      this.turn.status = 'running';
      this.save();
      if (this.store.control(this.turn.id, 'cancel')) {
        this.turn.status = 'cancelled';
        return;
      }
      this.permissionOpen = true;
      const result = await this.prompt(sessionId);
      if (this.cancelled || result.stopReason === 'cancelled') this.turn.status = 'cancelled';
      else if (result.stopReason === 'end_turn') this.turn.status = 'done';
      else throw new Error('Antigravity stopped with ' + (text(result.stopReason) || 'an unknown reason'));
    } finally {
      this.permissionOpen = false;
      delete this.turn.permission;
      if ('close' in capabilities) await this.rpc.request('session/close', { sessionId }, 5_000);
    }
  }

  private async prompt(sessionId: string): Promise<Record<string, unknown>> {
    type Result = { ok: true; value: Record<string, unknown> } | { ok: false; error: unknown };
    let result: Result | undefined;
    void this.rpc.request('session/prompt', {
      sessionId, prompt: [{ type: 'text', text: this.turn.prompt }],
    }, TURN_TIMEOUT).then(
      value => { result = { ok: true, value }; },
      error => { result = { ok: false, error }; },
    );
    let cancelExpires = 0;
    while (!result) {
      if (this.asyncError) throw this.asyncError;
      if (this.dirty && Date.now() - this.lastSaved >= 100) this.save();
      if (!this.cancelled && this.store.control(this.turn.id, 'cancel')) {
        this.rpc.notify('session/cancel', { sessionId });
        this.cancelled = true;
        cancelExpires = Date.now() + 5_000;
        while (this.permissions.length) this.resolvePermission();
      }
      if (this.cancelled && Date.now() >= cancelExpires) throw new Error('Antigravity did not settle after cancellation');
      const permission = this.permissions[0];
      if (permission) {
        const command = this.store.control(this.turn.id, permission.key);
        if (command?.type === 'permission') this.resolvePermission(command.decision === 'allow' ? permission.allow : permission.deny);
        else if (Date.now() >= this.approvalExpires) this.resolvePermission(permission.deny);
      }
      await sleep(40);
    }
    if (!result.ok) throw result.error;
    return result.value;
  }

  private onEvent(event: AgentMessage): void {
    const sameSession = this.turn.sessionId && event.params.sessionId === this.turn.sessionId;
    if (event.method === 'session/request_permission' && event.id !== undefined) {
      if (!sameSession || this.cancelled || !this.permissionOpen) {
        this.rpc.reply(event.id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      const tool = record(event.params.toolCall);
      const choices = entries(event.params.options);
      const once = (kind: string): string => text(choices.find(choice => choice.kind === kind)?.optionId);
      this.permissions.push({
        requestId: event.id, key: randomUUID(), title: text(tool.title) || 'Tool approval',
        details: JSON.stringify(tool.rawInput ?? tool.content ?? {}, null, 2).slice(0, 16_000),
        allow: once('allow_once'), deny: once('reject_once'),
      });
      if (this.permissions.length === 1) this.showPermission();
      return;
    }
    if (event.id !== undefined) {
      this.rpc.unsupported(event.id);
      return;
    }
    if (!sameSession || event.method !== 'session/update' || !this.permissionOpen) return;
    const update = record(event.params.update);
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.turn.answer = (this.turn.answer + text(record(update.content).text)).slice(0, 4_000_000);
      this.dirty = true;
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = text(update.toolCallId);
      if (!id) return;
      const index = this.turn.tools.findIndex(tool => tool.id === id);
      const previous = this.turn.tools[index];
      const tool = { id, title: text(update.title) || previous?.title || 'Tool', status: text(update.status) || previous?.status || 'running' };
      if (index < 0) this.turn.tools.push(tool);
      else this.turn.tools[index] = tool;
      this.dirty = true;
    }
  }

  private resolvePermission(option?: string): void {
    const permission = this.permissions[0];
    if (!permission) return;
    this.rpc.reply(permission.requestId, {
      outcome: option ? { outcome: 'selected', optionId: option } : { outcome: 'cancelled' },
    });
    this.permissions.shift();
    this.showPermission();
  }

  private showPermission(): void {
    const permission = this.permissions[0];
    if (permission && !this.cancelled) {
      this.turn.permission = { id: permission.key, title: permission.title, details: permission.details, allow: Boolean(permission.allow) };
      this.approvalExpires = Date.now() + APPROVAL_TIMEOUT;
    } else delete this.turn.permission;
    this.save();
  }

  private save(): void {
    this.store.saveTurn(this.turn);
    this.dirty = false;
    this.lastSaved = Date.now();
  }
}

export async function executeTurn(configPath: string, turnId: string): Promise<void> {
  const config = readConfig(configPath);
  const store = new Store(config.stateDirectory);
  const turn = store.turn(turnId);
  if (!turn || turn.status !== 'starting' || turn.workerPid) return;
  const project: Project | undefined = config.projects.find(item => item.id === turn.projectId);
  turn.workerPid = process.pid;
  store.saveTurn(turn);
  let child: ReturnType<typeof launchAcp> | undefined;
  try {
    if (!project) throw new Error('The project configuration is missing');
    if (store.control(turnId, 'cancel')) turn.status = 'cancelled';
    else {
      child = launchAcp(project, turn.id);
      await new AntigravityTurn(store, turn, new Acp(child)).run();
    }
  } catch (error) {
    turn.status = store.control(turnId, 'cancel') ? 'cancelled' : 'failed';
    turn.error = message(error);
  } finally {
    delete turn.permission;
    child?.stdin.end();
    try {
      if (child && child.exitCode === null && child.signalCode === null && child.pid) {
        // EOF lets the CLI exit on its own. Docker cleanup handles a hung child.
        await sleep(300);
      }
      await cleanContainer(config.dockerPath, turn.id);
    } catch {
      turn.status = 'blocked';
      turn.error = 'Docker cleanup could not be confirmed. The conversation is blocked until the container is removed.';
    }
    child?.kill();
    store.saveTurn(turn);
  }
}
