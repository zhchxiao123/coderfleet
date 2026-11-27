// Translation of assistant replies, ported from coderfleet/server/system_llm.py,
// translate.py and translation_cache.py. Calls go to the system LLM configured in
// config.conf (SYSTEM_LLM_*), never to a pooled account. Replies are split at
// Markdown boundaries, code stays as is, a part cut off by the length limit is
// retried in smaller pieces, and only a complete translation is cached. The cache
// is the Python service's translations/<sha256(target\0text)[:32]>.json, shared.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig } from './conf.js';
import { atomicJSON, record, text } from './state.js';

export class SystemLLMError extends Error {}
export class OutputLimitError extends SystemLLMError {}
class IncompleteTranslation extends SystemLLMError {}

export interface SystemLLMConfig { provider: string; apiKey: string; model: string; baseUrl: string; proxy: string }

export function systemLLM(workspace: string): SystemLLMConfig {
  const config = loadConfig(workspace);
  return {
    provider: (text(config.SYSTEM_LLM_PROVIDER) || 'anthropic').trim().toLowerCase(), apiKey: text(config.SYSTEM_LLM_API_KEY).trim(),
    model: text(config.SYSTEM_LLM_MODEL).trim(), baseUrl: text(config.SYSTEM_LLM_BASE_URL).trim().replace(/\/+$/, ''), proxy: text(config.SYSTEM_LLM_PROXY).trim(),
  };
}

export const configured = (llm: SystemLLMConfig): boolean => Boolean(llm.apiKey && llm.model);

/** Sends one request, through `proxy` (an HTTP proxy, CONNECT for HTTPS) when given; answers once the response's head is in. */
function open(proxy: string, url: string, method: string, headers: Record<string, string>, payload: Buffer | undefined, idle: number, signal?: AbortSignal): Promise<IncomingMessage> {
  const target = new URL(url);
  const allHeaders = { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) };
  const https = target.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => reject(error instanceof SystemLLMError ? error : new SystemLLMError('请求上游失败: ' + (error instanceof Error ? error.message : String(error))));
    if (signal?.aborted) { fail(new SystemLLMError('请求已取消')); return; }
    const send = (options: Record<string, unknown>): void => {
      const call = (https ? httpsRequest : httpRequest)({ method, headers: allHeaders, timeout: idle, ...options }, resolve);
      call.on('timeout', () => call.destroy(new SystemLLMError('请求上游超时')));
      call.on('error', fail);
      // Also ends a response that is still streaming.
      signal?.addEventListener('abort', () => call.destroy(new SystemLLMError('请求已取消')), { once: true });
      call.end(payload);
    };
    const base = { host: target.hostname, port: Number(target.port) || (https ? 443 : 80), path: target.pathname + target.search };
    if (!proxy) { send(base); return; }
    const via = new URL(proxy);
    if (!https) { send({ host: via.hostname, port: Number(via.port) || 80, path: url, headers: { ...allHeaders, host: target.host } }); return; }
    const tunnel = httpRequest({ host: via.hostname, port: Number(via.port) || 80, method: 'CONNECT', path: base.host + ':' + base.port, timeout: 30_000 });
    tunnel.on('connect', (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); fail(new SystemLLMError('代理拒绝连接: ' + response.statusCode)); return; }
      send({ ...base, createConnection: () => tlsConnect({ socket, servername: base.host }), agent: false });
    });
    tunnel.on('timeout', () => tunnel.destroy(new SystemLLMError('连接代理超时')));
    tunnel.on('error', fail);
    tunnel.end();
  });
}

/** POSTs JSON, through SYSTEM_LLM_PROXY when set. */
async function post(llm: SystemLLMConfig, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const response = await open(llm.proxy, url, 'POST', headers, Buffer.from(JSON.stringify(body)), 60_000);
  const chunks: Buffer[] = [];
  try { for await (const chunk of response) chunks.push(chunk as Buffer); }
  catch (error) { throw error instanceof SystemLLMError ? error : new SystemLLMError('请求上游失败: ' + (error instanceof Error ? error.message : String(error))); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((response.statusCode ?? 500) >= 400) throw new SystemLLMError('上游返回 ' + response.statusCode + ': ' + raw.slice(0, 300));
  try { return record(JSON.parse(raw)); } catch { throw new SystemLLMError('上游响应非 JSON: ' + raw.slice(0, 200)); }
}

/**
 * `fetch` through SYSTEM_LLM_PROXY, for a caller that reads the answer as it streams. The proxy
 * is this request's alone: nothing of the process (its environment, its other requests) changes.
 */
export function proxyFetch(proxy: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const payload = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const sent: Record<string, string> = {};
    request.headers.forEach((value, name) => { sent[name] = value; });
    const response = await open(proxy, request.url, request.method, sent, payload, 300_000, request.signal);
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
    const status = response.statusCode ?? 502;
    return new Response(status === 204 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, statusText: response.statusMessage ?? '', headers });
  };
}

/** One stateless completion (SystemLLM.complete). */
export async function complete(llm: SystemLLMConfig, content: string, system: string, maxTokens: number): Promise<string> {
  if (!configured(llm)) throw new SystemLLMError('系统 LLM 未配置（缺少 SYSTEM_LLM_API_KEY 或 SYSTEM_LLM_MODEL）');
  const messages = [{ role: 'user', content }];
  if (llm.provider === 'anthropic') {
    const data = await post(llm, (llm.baseUrl || 'https://api.anthropic.com') + '/v1/messages',
      { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      { model: llm.model, max_tokens: maxTokens, messages, ...(system ? { system } : {}) });
    const reason = data.stop_reason;
    if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') throw new OutputLimitError('模型输出未完成（' + reason + '）');
    if (reason === 'refusal' || reason === 'pause_turn' || reason === 'tool_use') throw new SystemLLMError('模型未返回完整文本（' + reason + '）');
    const output = Number(record(data.usage).output_tokens ?? 0);
    if (reason === undefined || reason === null) { if (output >= maxTokens) throw new OutputLimitError('模型输出达到长度上限，未确认完成'); }
    return (Array.isArray(data.content) ? data.content : []).map(block => record(block)).filter(block => block.type === 'text').map(block => text(block.text)).join('').trim();
  }
  if (llm.provider === 'openai') {
    const data = await post(llm, (llm.baseUrl || 'https://api.openai.com/v1') + '/chat/completions',
      { Authorization: 'Bearer ' + llm.apiKey, 'content-type': 'application/json' },
      { model: llm.model, max_tokens: maxTokens, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] });
    const choice = record((Array.isArray(data.choices) ? data.choices : [])[0]);
    if (!Object.keys(choice).length) throw new SystemLLMError('上游未返回 choices');
    const reason = choice.finish_reason;
    if (reason === 'length') throw new OutputLimitError('模型输出未完成（length）');
    if (reason === 'content_filter' || reason === 'tool_calls' || reason === 'function_call') throw new SystemLLMError('模型未返回完整文本（' + reason + '）');
    if (record(choice.message).refusal) throw new SystemLLMError('模型拒绝了本次请求');
    const output = Number(record(data.usage).completion_tokens ?? 0);
    if ((reason === undefined || reason === null) && output >= maxTokens) throw new OutputLimitError('模型输出达到长度上限，未确认完成');
    return text(record(choice.message).content).trim();
  }
  throw new SystemLLMError('未知的 SYSTEM_LLM_PROVIDER: ' + llm.provider);
}

const SYSTEM_PROMPT = (target: string): string => 'You are a translation engine. Translate the user\'s message into ' + target + '. '
  + 'Output ONLY the translation — no preamble, no explanation, no quotes around it. '
  + 'Preserve all Markdown structure, code blocks, inline code, links and formatting '
  + 'exactly. Leave code, identifiers and URLs untranslated.'
  + ' Translate ALL input content without omitting, summarizing or adding content.';

const CHUNK = 2000;
const CONCURRENCY = 3;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/;
const INLINE_CODE = String.raw`(?<!\`)(\`+)(?!\`)[\s\S]*?(?<!\`)\1(?!\`)`;
const PROTECTED = new RegExp(INLINE_CODE + String.raw`|!?\[[^\]\n]*\]\([^\)\n]*\)|https?://[^\s]+`, 'g');

interface Part { text: string; literal: boolean }

/** Lossless splitting: never invents a newline or cuts a code or link atom. */
function splitProse(input: string, limit: number): Part[] {
  const parts: Part[] = [];
  let rest = input;
  while (rest.length > limit) {
    let end = limit;
    for (const separator of ['\n\n', '\n', '. ', ' ']) {
      const boundary = rest.lastIndexOf(separator, limit - separator.length);
      if (boundary >= Math.floor(limit / 2)) { end = boundary + separator.length; break; }
    }
    const heading = /(?:^|\n)( {0,3}#{1,6}[ \t]+[^\r\n]+)\r?\n(?:[ \t]*\r?\n)*$/.exec(rest.slice(0, end));
    if (heading && heading.index + heading[0].indexOf(heading[1] as string) > 0) end = heading.index + heading[0].indexOf(heading[1] as string);
    let literal = false;
    for (const match of rest.matchAll(PROTECTED)) {
      const start = match.index ?? 0;
      if (start >= end) break;
      const stop = start + match[0].length;
      if (start < end && end < stop) {
        if (start === 0) { end = stop; literal = true; } else end = start;
        break;
      }
    }
    parts.push({ text: rest.slice(0, end), literal });
    rest = rest.slice(end);
  }
  if (rest) parts.push({ text: rest, literal: false });
  return parts;
}

/** Paragraph count, heading markers, list items and inline code spans: must survive translation. */
function structure(input: string): string {
  const blocks = input.trim().split(/\r?\n[ \t]*\r?\n/);
  const paragraphs = blocks.filter(block => block.trim() && !/^ {0,3}#{1,6}[ \t]+[^\r\n]+$/.test(block.trim())).length;
  const headings = [...input.matchAll(/^ {0,3}(#{1,6})[ \t]+/gm)].map(match => match[1]);
  const items = [...input.matchAll(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm)].length;
  const code = [...input.matchAll(new RegExp(INLINE_CODE, 'g'))].map(match => match[1]);
  return JSON.stringify([paragraphs, headings, items, code]);
}

function translationParts(input: string): Part[] {
  const parts: Part[] = [];
  let buffer: string[] = [];
  let fence = '';
  for (const line of input.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (fence) {
      buffer.push(line);
      if (new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*(?:\\r?\\n)?$').test(line)) {
        parts.push({ text: buffer.join(''), literal: true });
        buffer = []; fence = '';
      }
    } else {
      let opening = FENCE.exec(line);
      if (opening && (opening[1] as string)[0] === '`' && line.slice((opening[1] as string).length + line.indexOf(opening[1] as string)).includes('`')) opening = null;
      if (opening) {
        parts.push(...splitProse(buffer.join(''), CHUNK));
        buffer = [line]; fence = opening[1] as string;
      } else buffer.push(line);
    }
  }
  if (buffer.length) {
    const remainder = buffer.join('');
    parts.push(...(fence ? [{ text: remainder, literal: true }] : splitProse(remainder, CHUNK)));
  }
  return parts;
}

export async function translateText(llm: SystemLLMConfig, input: string, target = '简体中文'): Promise<string> {
  if (!input.trim()) return '';
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    while (running >= CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve));
    running += 1;
    try { return await work(); } finally { running -= 1; waiting.shift()?.(); }
  };
  const translatePart = async (part: Part, depth = 0): Promise<string> => {
    if (part.literal || !part.text.trim()) return part.text;
    const source = part.text;
    const left = source.length - source.trimStart().length;
    const right = source.trimEnd().length;
    const content = source.slice(left, right);
    let translated: string;
    try {
      translated = await slot(() => complete(llm, content, SYSTEM_PROMPT(target), 4096));
      if (!translated.trim() || structure(content) !== structure(translated)) throw new IncompleteTranslation('译文缺少段落或 Markdown 结构，翻译未完成');
    } catch (error) {
      if (!(error instanceof OutputLimitError || error instanceof IncompleteTranslation)) throw error;
      if (content.length <= 1 || depth >= 12) throw new SystemLLMError('模型未能返回完整译文，请重试或更换系统模型');
      const pieces = splitProse(content, Math.max(1, Math.floor(content.length / 2)));
      translated = '';
      for (const piece of pieces) translated += await translatePart(piece, depth + 1);
    }
    return source.slice(0, left) + translated + source.slice(right);
  };
  return (await Promise.all(translationParts(input).map(part => translatePart(part)))).join('');
}

/** The Python service's content-addressed cache: same file name, fields and version. */
export class TranslationCache {
  public constructor(private readonly directory: string) {}

  private path(input: string, target: string): string {
    return join(this.directory, createHash('sha256').update(target + '\0' + input, 'utf8').digest('hex').slice(0, 32) + '.json');
  }

  public get(input: string, target: string): string | undefined {
    try {
      const value = record(JSON.parse(readFileSync(this.path(input, target), 'utf8')));
      return value.version === 2 && text(value.translated).trim() ? text(value.translated) : undefined;
    } catch { return undefined; }
  }

  public put(input: string, target: string, translated: string): void {
    mkdirSync(this.directory, { recursive: true });
    const path = this.path(input, target);
    atomicJSON(path, { id: path.slice(-37, -5), target, translated, source_preview: input.slice(0, 80), created: new Date().toISOString(), version: 2 });
  }
}
