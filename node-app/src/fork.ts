// Forking a Claude conversation at a finished turn, as the Python service does
// (conversation_forks.py, Scheduler.fork_conversation): the fork resumes the
// source session at that turn's last assistant message with a new session ID,
// shows the earlier turns read-only, and shares the project files (nothing is
// rolled back).
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record, text, type Conversation, type ConversationFork, type Turn } from './state.js';

export class ForkError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The last top-level assistant message of a successful turn (completed_turn_checkpoint). */
export function checkpoint(turn: Turn, log: string): string {
  if (turn.type !== 'claude' || turn.status !== 'done') throw new ForkError('只能从已完成的 Claude 回答分叉');
  if (!turn.sessionId) throw new ForkError('这轮回答没有会话记录，无法分叉');
  let last: Record<string, unknown> | undefined;
  let successful = false;
  for (const line of log.split('\n')) {
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { continue; }
    if (event.parent_tool_use_id || event.session_id !== turn.sessionId) continue;
    if (event.type === 'assistant') last = event;
    else if (event.type === 'result') successful = event.subtype === 'success' && event.is_error !== true;
  }
  if (!successful || !last) throw new ForkError('日志里没有完整的成功回答，无法定位分叉点');
  const content = record(last.message).content;
  if (!Array.isArray(content)) throw new ForkError('日志里的回复结构不完整，无法定位分叉点');
  if (content.some(block => record(block).type === 'tool_use')) throw new ForkError('不能在还没结束的工具调用处分叉');
  const uuid = text(last.uuid);
  if (!UUID.test(uuid)) throw new ForkError('旧日志缺少消息 ID，无法分叉');
  return uuid;
}

/** The account's Claude transcript of a session: accounts/<name>/projects/<dir>/<session>.jsonl. */
export function transcript(workspace: string, account: string, sessionId: string): string | undefined {
  if (!UUID.test(sessionId) || !/^[\w.-]+$/.test(account)) return undefined;
  const root = join(workspace, 'accounts', account, 'projects');
  let found: string[] = [];
  try {
    found = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name, sessionId + '.jsonl'))
      .filter(path => existsSync(path));
  } catch { return undefined; }
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Builds the fork of `source` at `turn`. `ownTurns` are the source's turns;
 * the fork inherits the source's own inherited turns plus its finished turns up
 * to and including `turn`.
 */
export function forkOf(workspace: string, source: Conversation, ownTurns: readonly Turn[], turn: Turn, log: string, id: string, name: string): Conversation {
  if (source.type !== 'claude') throw new ForkError('只有 Claude 对话可以分叉');
  if (turn.conversationId !== source.id || (source.account && turn.account !== source.account)) throw new ForkError('这轮回答不属于这个对话或账号');
  const uuid = checkpoint(turn, log);
  const path = transcript(workspace, turn.account ?? '', turn.sessionId ?? '');
  if (!path) throw new ForkError('找不到这个会话的 Claude 记录，无法分叉');
  if (!readFileSync(path, 'utf8').split('\n').some(line => { try { return record(JSON.parse(line)).uuid === uuid; } catch { return false; } })) {
    throw new ForkError('分叉点不在 Claude 会话记录里，无法分叉');
  }
  const time = (value: Turn): number => Date.parse(value.finishedAt ?? value.createdAt) || 0;
  const inherited = [...(source.fork?.inherited_task_ids ?? [])];
  for (const item of [...ownTurns].sort((a, b) => time(a) - time(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (!['done', 'failed', 'cancelled'].includes(item.status)) continue;
    inherited.push(item.id);
    if (item.id === turn.id) break;
  }
  const fork: ConversationFork = {
    source_conversation_id: source.id, source_task_id: turn.id, source_session_id: turn.sessionId as string, message_uuid: uuid,
    target_session_id: randomUUID(), inherited_task_ids: inherited, model: turn.model ?? turn.requestedModel ?? '',
  };
  return {
    id, projectId: source.projectId, name: name.trim().slice(0, 100) || source.name + ' · 分叉', createdAt: new Date().toISOString(),
    account: source.account, type: source.type, project: source.project, fork,
  };
}
