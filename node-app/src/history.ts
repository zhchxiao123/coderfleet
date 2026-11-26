// Reads task logs written by the Python service, in each CLI's native output
// format, and converts them to the normalized stream-json events the
// conversation view uses. Ported from the per-type parsers in
// coderfleet/account_type_registry.py (_events_* and _extract_*).
// Logs written by this service are already normalized.
import { entries, record, text, type RecordValue } from './state.js';

type Event = RecordValue;

const delta = (value: string): Event => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } } });
const toolUse = (id: string, name: string, input: unknown): Event => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: record(input) }] } });
const toolResult = (id: string, isError: boolean, content: unknown = ''): Event => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
const session = (id: string): Event => ({ type: 'system', subtype: 'coderfleet_session', session_id: id, history: true });

function args(value: unknown): RecordValue {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return { arguments: value }; }
  }
  return record(value);
}

/** Per-type state: some formats need numbering or deduplication across lines. */
interface Converter { line(event: RecordValue): Event[]; plain?(line: string): Event[] }

function claude(): Converter {
  // Claude CLI logs carry whole assistant messages; SDK logs also stream deltas.
  // The caller decides from the whole log whether deltas exist.
  return { line: event => [event] };
}

function codex(): Converter {
  const started = new Set<string>();
  const item = (value: RecordValue, completed: boolean): Event[] => {
    const id = text(value.id);
    switch (value.type) {
      case 'agent_message': return completed && text(value.text) ? [delta(text(value.text))] : [];
      case 'command_execution':
      case 'file_change':
      case 'mcp_tool_call':
      case 'web_search': {
        const name = value.type === 'command_execution' ? 'Shell' : value.type === 'file_change' ? 'Edit files'
          : value.type === 'web_search' ? 'Web search' : [text(value.server), text(value.tool)].filter(Boolean).join(' · ') || 'MCP tool';
        const input = value.type === 'command_execution' ? { command: value.command } : value.type === 'file_change' ? { changes: value.changes }
          : value.type === 'web_search' ? { query: value.query } : { arguments: value.arguments };
        const events: Event[] = [];
        if (!started.has(id)) { started.add(id); events.push(toolUse(id, name, input)); }
        if (completed) events.push(toolResult(id, value.status === 'failed' || (typeof value.exit_code === 'number' && value.exit_code !== 0), value.aggregated_output ?? value.result ?? value.error ?? ''));
        return events;
      }
      default: return [];
    }
  };
  return {
    line: event => {
      const type = text(event.type);
      if (type === 'thread.started' && text(event.thread_id)) return [session(text(event.thread_id))];
      if (type === 'item.started' || type === 'item.completed') return item(record(event.item), type === 'item.completed');
      // The flat tool_call / tool_result pair from older Codex versions.
      if (type === 'tool_call') return [toolUse(text(event.id), text(event.name), args(event.arguments ?? event.input))];
      if (type === 'tool_result') return [toolResult(text(event.tool_call_id), event.is_error === true, event.result ?? event.output ?? '')];
      if (type === 'message' && event.role === 'assistant') return entries(event.content).filter(block => block.type === 'text').map(block => delta(text(block.text)));
      if (type === 'turn.failed') return [{ type: 'error', message: text(record(event.error).message) || 'Codex turn failed' }];
      return [];
    },
  };
}

function opencode(): Converter {
  const started = new Set<string>();
  let announced = false;
  return {
    line: event => {
      const events: Event[] = [];
      const id = text(event.sessionID) || text(event.session_id) || text(event.sessionId) || text(record(event.session).id);
      if (id && !announced) { announced = true; events.push(session(id)); }
      const part = record(event.part);
      if (event.type === 'tool_use') {
        const call = text(part.callID) || text(part.id);
        const state = record(part.state);
        if (!started.has(call)) { started.add(call); events.push(toolUse(call, text(part.tool) || 'tool', state.input)); }
        if (state.status === 'completed' || state.status === 'error') events.push(toolResult(call, state.status === 'error', state.output ?? state.error ?? ''));
      } else if (event.type === 'text' && part.type === 'text' && text(part.text)) events.push(delta(text(part.text)));
      else if (event.role === 'assistant' || event.type === 'message' || event.type === 'assistant') {
        if (typeof event.content === 'string') events.push(delta(event.content));
        else for (const block of entries(event.content)) if (block.type === 'text') events.push(delta(text(block.text)));
      }
      return events;
    },
  };
}

function kimi(): Converter {
  return {
    line: event => {
      if (event.role === 'meta' && event.type === 'session.resume_hint' && text(event.session_id)) return [session(text(event.session_id))];
      // Kimi's tool results carry no error flag.
      if (event.role === 'tool') return [toolResult(text(event.tool_call_id), false, event.content ?? '')];
      if (event.role !== 'assistant') return [];
      const events: Event[] = [];
      if (typeof event.content === 'string' && event.content) events.push(delta(event.content));
      else for (const block of entries(event.content)) if (block.type === 'text') events.push(delta(text(block.text)));
      for (const call of entries(event.tool_calls)) events.push(toolUse(text(call.id), text(record(call.function).name), args(record(call.function).arguments)));
      return events;
    },
    plain: line => {
      const match = /To resume this session:\s+kimi\s+-r\s+(\S+)/.exec(line);
      return match ? [session(match[1] as string)] : [];
    },
  };
}

function grok(): Converter {
  return {
    line: event => {
      if (event.type === 'text_delta') return [delta(text(event.text))];
      if (event.type === 'text') return [delta(text(event.data) || text(event.text))];
      const id = text(event.sessionId) || text(event.session_id) || text(event.sessionID);
      return id ? [session(id)] : [];
    },
    plain: line => {
      const match = /^grok_session_id=(\S+)/.exec(line);
      return match ? [session(match[1] as string)] : [];
    },
  };
}

function pi(): Converter {
  return {
    line: event => {
      if (event.type === 'session' && text(event.id)) return [session(text(event.id))];
      if (event.type === 'tool_execution_start') return [toolUse(text(event.toolCallId), text(event.toolName), event.args)];
      if (event.type === 'tool_execution_end') {
        const result = record(event.result);
        return [toolResult(text(event.toolCallId), event.isError === true, typeof event.result === 'string' ? event.result : result.content ?? '')];
      }
      if (event.type !== 'message_end' || record(event.message).role !== 'assistant') return [];
      return entries(record(event.message).content).filter(block => block.type === 'text').map(block => delta(text(block.text)));
    },
  };
}

function hermes(): Converter {
  return {
    line: () => [],
    plain: line => {
      const match = /^Session:\s+(\S+)/.exec(line);
      return match ? [session(match[1] as string)] : [delta(line + '\n')];
    },
  };
}

const CONVERTERS: Readonly<Record<string, () => Converter>> = {
  claude, antigravity: claude, codex, opencode, kimi, grok, pi, hermes,
};

/**
 * Normalized events for a log. `native` is true for logs written by the
 * Python service's CLI backends, which use each tool's own format.
 */
export function normalizeLog(type: string, native: boolean, content: string): Event[] {
  const converter = native ? (CONVERTERS[type] ?? claude)() : claude();
  const lines = content.split('\n');
  const parsed: (RecordValue | string)[] = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return line;
    try { return record(JSON.parse(trimmed)); } catch { return line; }
  });
  // Claude-format logs: use streamed deltas when the log has them, otherwise the
  // whole assistant messages (CLI logs without partial messages).
  const claudeFormat = !native || CONVERTERS[type] === claude || !CONVERTERS[type];
  const hasDeltas = claudeFormat && parsed.some(item => typeof item !== 'string' && record(record(item.event).delta).type === 'text_delta');
  const events: Event[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      if (item.trim() && converter.plain) events.push(...converter.plain(item));
      continue;
    }
    if (claudeFormat) {
      if (item.type === 'system' && item.subtype === 'init' && text(item.session_id)) events.push(session(text(item.session_id)));
      if (item.type === 'assistant' && !hasDeltas && !item.parent_tool_use_id) {
        for (const block of entries(record(item.message).content)) if (block.type === 'text' && text(block.text)) events.push(delta(text(block.text)));
      }
      if (item.type === 'result' && item.is_error === true) events.push({ type: 'error', message: text(item.result) || text(item.error) || 'The run failed' });
    }
    events.push(...converter.line(item));
  }
  return events;
}
