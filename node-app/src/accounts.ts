// Account type registry: the subset of coderfleet/account_type_registry.py that
// container generation, login and the desktop UI need. Values are copied from
// the Python registry; `chat` marks types this service can run conversations for.
export interface AccountType {
  readonly id: string;
  readonly label: string;
  readonly authDir: string;
  readonly envVars: Readonly<Record<string, string>>;
  readonly login: readonly string[];
  readonly envAuth: boolean;
  readonly envHint: string;
  readonly chat: boolean;
}

export const ACCOUNT_TYPES: Readonly<Record<string, AccountType>> = {
  // Every type can hold conversations; see WORKERS in tasks.ts for how each one runs.
  claude: {
    id: 'claude', label: 'Claude Code', authDir: '/home/byclaw/.claude', envVars: {}, login: ['claude', 'login'], envAuth: true,
    envHint: '在环境变量里配置 ANTHROPIC_API_KEY 等，例如 ANTHROPIC_API_KEY=sk-ant-...', chat: true,
  },
  codex: {
    id: 'codex', label: 'Codex CLI', authDir: '/home/byclaw/.codex', envVars: {}, login: ['codex', 'login', '--device-auth'], envAuth: false,
    envHint: '', chat: true,
  },
  antigravity: {
    id: 'antigravity', label: 'Antigravity CLI', authDir: '/home/byclaw/.gemini', envVars: {}, login: ['agy', 'acp', '--login'], envAuth: true,
    envHint: '在环境变量里配置 GEMINI_API_KEY，或使用 Google 账号登录。', chat: true,
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', authDir: '/home/byclaw/.opencode',
    envVars: {
      XDG_DATA_HOME: '/home/byclaw/.opencode/data', XDG_CONFIG_HOME: '/home/byclaw/.opencode/config',
      XDG_STATE_HOME: '/home/byclaw/.opencode/state', XDG_CACHE_HOME: '/home/byclaw/.opencode/cache',
    },
    login: ['opencode', 'auth', 'login'], envAuth: true, envHint: '在环境变量里配置 API Key。', chat: true,
  },
  hermes: {
    id: 'hermes', label: 'Hermes Agent', authDir: '/home/byclaw/.hermes', envVars: { HERMES_HOME: '/home/byclaw/.hermes' },
    login: ['hermes', 'setup'], envAuth: true, envHint: '在环境变量里配置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY。', chat: true,
  },
  grok: {
    id: 'grok', label: 'Grok Build', authDir: '/home/byclaw/.grok', envVars: { GROK_HOME: '/home/byclaw/.grok', GROK_NO_AUTO_UPDATE: '1' },
    login: ['grok', '--no-auto-update'], envAuth: true, envHint: '在环境变量里配置 XAI_API_KEY。', chat: true,
  },
  kimi: {
    id: 'kimi', label: 'Kimi Code', authDir: '/home/byclaw/.kimi-code',
    envVars: { KIMI_CODE_HOME: '/home/byclaw/.kimi-code', KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_DISABLE_TELEMETRY: '1' },
    login: ['kimi', 'login'], envAuth: true, envHint: '在环境变量里配置 KIMI_MODEL_NAME、KIMI_MODEL_API_KEY。', chat: true,
  },
  pi: {
    id: 'pi', label: 'Pi Agent', authDir: '/home/byclaw/.pi/agent', envVars: { PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
    login: ['pi'], envAuth: true, envHint: '在环境变量里配置 provider API Key；订阅登录在 pi 会话里执行 /login。', chat: true,
  },
};

/** Unknown types fall back to Codex, as in compose.py. */
export function accountType(id: string): AccountType {
  return ACCOUNT_TYPES[id] ?? ACCOUNT_TYPES.codex as AccountType;
}
