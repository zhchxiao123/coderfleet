// 领航's engine: one run of the system model with tools, on pi's agent loop (the
// @earendil-works/pi-coding-agent SDK, shipped whole in dist/vendor/pi). The loop, the streamed
// answer, the retries of a failed request and the compaction of a run that outgrows the model's
// context are pi's. What the model may do is not: pi's own tools (files, shell) are left out,
// its project files (AGENTS.md, skills, extensions, settings) are not read, and the session
// lives in memory. The only tools are the ones the caller passes.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { message, record, text } from './state.js';
import { configured, proxyFetch, type SystemLLMConfig } from './translate.js';

/** A tool the model may call: its name, what it is for, and the JSON Schema of its input. */
export interface ToolSpec { readonly name: string; readonly description: string; readonly parameters: Record<string, unknown> }
export interface ToolCall { readonly name: string; readonly input: Record<string, unknown> }
/** An image the prompt comes with: base64 data and its type. */
export interface Image { readonly data: string; readonly mimeType: string }

export class EngineError extends Error {}
/** The run was stopped from outside (`signal`): it ends there and is not carried on. */
export class StoppedError extends EngineError {}

export interface RunOptions {
  readonly llm: SystemLLMConfig;
  /** Where pi keeps its (empty) credential file; the key itself stays in memory. */
  readonly directory: string;
  readonly system: string;
  readonly prompt: string;
  /** Shown to the model with the prompt; it is then registered as taking images. */
  readonly images?: readonly Image[];
  readonly tools: readonly ToolSpec[];
  /** Performs a call. `end`: the run is over with it, the model is not asked again. */
  call(call: ToolCall): Promise<{ output: string; end?: boolean }>;
  readonly limitMs: number;
  /** Stops the run the way its time limit does. */
  readonly signal?: AbortSignal;
  /** What the model has written so far in the message it is on. */
  onText?(text: string): void;
  onTool?(call: ToolCall): void;
}

// The part of pi's SDK used here.
interface PiModel { readonly id: string; readonly contextWindow: number; readonly maxTokens: number }
type PiStream = (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
interface PiRuntime {
  getModels(): readonly PiModel[];
  getModel(provider: string, id: string): PiModel | undefined;
  registerProvider(id: string, config: Record<string, unknown>): void;
  setRuntimeApiKey(provider: string, key: string): Promise<void>;
  streamSimple: PiStream;
  completeSimple: PiStream;
}
interface PiMessage { readonly role: string; readonly content?: unknown; readonly stopReason?: string; readonly errorMessage?: string }
interface PiEvent {
  readonly type: string; readonly message?: PiMessage; readonly toolName?: string; readonly args?: unknown;
  readonly assistantMessageEvent?: { readonly type: string; readonly delta?: string };
}
interface PiSession {
  readonly messages: readonly PiMessage[];
  subscribe(listener: (event: PiEvent) => void): () => void;
  prompt(text: string, options?: { images?: readonly { type: 'image'; data: string; mimeType: string }[] }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}
interface Pi {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
  ModelRuntime: { create(options: Record<string, unknown>): Promise<PiRuntime> };
  SessionManager: { inMemory(cwd: string): unknown };
  SettingsManager: { inMemory(settings: Record<string, unknown>): unknown };
  createExtensionRuntime(): unknown;
}

let loaded: Promise<Pi> | undefined;
const pi = (): Promise<Pi> => loaded ??= import(new URL('./vendor/pi/index.js', import.meta.url).href) as Promise<Pi>;

const PROVIDER = 'coderfleet-system';
const APIS: Record<string, { api: string; baseUrl: string }> = {
  anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  openai: { api: 'openai-completions', baseUrl: 'https://api.openai.com/v1' },
};
/** For a model pi's catalog does not know: small enough for any current model, so a long run is compacted in time. */
const CONTEXT_WINDOW = 100_000;
/** A decision is short; this also fits every model's output limit. */
const MAX_OUTPUT = 4096;

/** Runs the model until it stops calling tools (its last words are the answer) or a call ends the run. */
export async function run(options: RunOptions): Promise<{ text: string; ended: boolean }> {
  const { llm } = options;
  if (!configured(llm)) throw new EngineError('系统 LLM 未配置（缺少 SYSTEM_LLM_API_KEY 或 SYSTEM_LLM_MODEL）');
  const provider = APIS[llm.provider];
  if (!provider) throw new EngineError('未知的 SYSTEM_LLM_PROVIDER: ' + llm.provider);
  const sdk = await pi();
  mkdirSync(options.directory, { recursive: true });
  const runtime = await sdk.ModelRuntime.create({ authPath: join(options.directory, 'auth.json'), modelsPath: null });
  const known = runtime.getModels().find(item => item.id === llm.model);
  runtime.registerProvider(PROVIDER, {
    name: 'CoderFleet system model', baseUrl: llm.baseUrl || provider.baseUrl, apiKey: PROVIDER, api: provider.api,
    models: [{ type: 'chat', id: llm.model, name: llm.model, reasoning: false, input: options.images?.length ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: known?.contextWindow ?? CONTEXT_WINDOW, maxTokens: Math.min(known?.maxTokens ?? MAX_OUTPUT, MAX_OUTPUT) }],
  });
  // Set as a value, not as configuration: pi reads `$NAME` and `!command` in a configured key.
  await runtime.setRuntimeApiKey(PROVIDER, llm.apiKey);
  if (llm.proxy) {
    // Every request of this run (compaction's too) goes through SYSTEM_LLM_PROXY, and only these.
    const fetch = proxyFetch(llm.proxy);
    for (const name of ['streamSimple', 'completeSimple'] as const) {
      const original = runtime[name].bind(runtime);
      runtime[name] = (model, context, request) => original(model, context, { ...request, fetch });
    }
  }
  const model = runtime.getModel(PROVIDER, llm.model);
  if (!model) throw new EngineError('系统模型没有注册上：' + llm.model);

  let session: PiSession | undefined;
  let ended = false;
  const tools = options.tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters, executionMode: 'sequential',
    execute: async (_id: string, input: unknown) => {
      // A call after the one that ended the run is not carried out.
      if (ended) return { content: [{ type: 'text', text: '已经结束' }], details: undefined, terminate: true };
      const result = await options.call({ name: tool.name, input: record(input) });
      if (result.end) { ended = true; void session?.abort(); }
      return { content: [{ type: 'text', text: result.output }], details: undefined, terminate: result.end === true };
    },
  }));
  const nothing = { diagnostics: [] };
  ({ session } = await sdk.createAgentSession({
    cwd: options.directory, agentDir: options.directory, modelRuntime: runtime, model, thinkingLevel: 'off', noTools: 'builtin', customTools: tools,
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], ...nothing }), getPrompts: () => ({ prompts: [], ...nothing }), getThemes: () => ({ themes: [], ...nothing }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => options.system, getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    },
    sessionManager: sdk.SessionManager.inMemory(options.directory),
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 } }),
  }));
  let draft = '';
  session.subscribe(event => {
    if (event.type === 'message_start' && event.message?.role === 'assistant') { draft = ''; options.onText?.(''); }
    else if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') { draft += event.assistantMessageEvent.delta ?? ''; options.onText?.(draft); }
    else if (event.type === 'tool_execution_start') options.onTool?.({ name: text(event.toolName), input: record(event.args) });
  });
  let late = false;
  const timer = setTimeout(() => { late = true; void session?.abort(); }, options.limitMs);
  const stop = (): void => { void session?.abort(); };
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (options.signal?.aborted) throw new StoppedError('停下了');
    const images = (options.images ?? []).map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }));
    await session.prompt(options.prompt, images.length ? { images } : undefined);
    if (ended) return { text: '', ended: true };
    if (options.signal?.aborted) throw new StoppedError('停下了');
    if (late) throw new EngineError('看了 ' + Math.round(options.limitMs / 60_000) + ' 分钟还没有定下来');
    const last = session.messages.at(-1);
    if (!last || last.role !== 'assistant') throw new EngineError('模型没有回答');
    if (last.stopReason === 'error' || last.stopReason === 'aborted') throw new EngineError('请求系统模型失败：' + (last.errorMessage || last.stopReason));
    if (last.stopReason === 'length') throw new EngineError('模型输出未完成（达到长度上限）');
    const said = (Array.isArray(last.content) ? last.content : []).map(block => record(block)).filter(block => block.type === 'text').map(block => text(block.text)).join('').trim();
    return { text: said, ended: false };
  } catch (error) {
    throw error instanceof EngineError ? error : new EngineError(message(error));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    session.dispose();
  }
}
