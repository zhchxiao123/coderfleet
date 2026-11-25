// Which commands may run. The order is fixed: built-in deny → the file's deny →
// confirm → allow → anything else is denied. The built-in part cannot be relaxed
// by the rules file, and an unreadable rules file allows nothing.
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeAtomic } from './home.ts';

export type Action = 'allow' | 'confirm' | 'deny';
export interface Rule {
  /** A bare program name, looked up in `path`. */
  readonly program: string;
  /** The rule applies only when one of these words is among the arguments; absent = any arguments. */
  readonly args_any?: readonly string[];
  readonly action: Action;
}
export interface Policy {
  /** The only directories programs are looked up in; also the PATH of what runs. */
  readonly path: readonly string[];
  readonly rules: readonly Rule[];
  /** Screen tools passed through to the model (not used until screen support exists). */
  readonly gui_tools: readonly string[];
}
export interface Verdict { readonly verdict: Action; readonly rule: string }

export function defaultPolicy(platform: NodeJS.Platform): Policy {
  const esptool: Rule[] = [
    { program: 'esptool', args_any: ['flash-id', 'read-mac', 'chip-id', 'image-info', 'get-security-info'], action: 'allow' },
    { program: 'esptool', args_any: ['write-flash', 'erase-flash', 'erase-region'], action: 'confirm' },
  ];
  if (platform === 'darwin') return {
    path: ['/usr/bin', '/bin', '/opt/homebrew/bin'],
    rules: [{ program: 'xcodebuild', action: 'allow' }, { program: 'xcrun', action: 'allow' }, ...esptool],
    gui_tools: ['get_window_state', 'get_desktop_state', 'zoom'],
  };
  return { path: ['/usr/bin', '/bin', '/usr/local/bin'], rules: esptool, gui_tools: [] };
}

const BARE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);

export function checkRule(value: unknown): Rule {
  const rule = value as Record<string, unknown> | null;
  if (!rule || typeof rule !== 'object') throw new Error('A rule must be an object');
  if (typeof rule.program !== 'string' || !BARE.test(rule.program)) throw new Error('A rule\'s program must be a bare program name, got ' + JSON.stringify(rule.program));
  if (rule.action !== 'allow' && rule.action !== 'confirm' && rule.action !== 'deny') throw new Error('A rule\'s action must be allow, confirm or deny');
  if (rule.args_any === undefined) return { program: rule.program, action: rule.action };
  if (!strings(rule.args_any) || !rule.args_any.length) throw new Error('args_any must be a non-empty list of words');
  return { program: rule.program, args_any: [...rule.args_any], action: rule.action };
}

export function checkPolicy(value: unknown): Policy {
  const policy = value as Record<string, unknown> | null;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('The rules file must hold an object');
  if (!strings(policy.path) || !policy.path.every(isAbsolute)) throw new Error('path must be a list of absolute directories');
  if (!Array.isArray(policy.rules)) throw new Error('rules must be a list');
  if (!strings(policy.gui_tools ?? [])) throw new Error('gui_tools must be a list of tool names');
  return { path: [...policy.path], rules: policy.rules.map(checkRule), gui_tools: [...(policy.gui_tools as string[] | undefined ?? [])] };
}

const policyFile = (home: string): string => join(home, 'policy.json');

/** The rules as they are on disk now; throws when the file is missing or wrong. */
export function loadPolicy(home: string): Policy {
  return checkPolicy(JSON.parse(readFileSync(policyFile(home), 'utf8')));
}

const sameRule = (left: Rule, right: { program: string; args_any?: readonly string[] }): boolean =>
  left.program === right.program && JSON.stringify(left.args_any ?? null) === JSON.stringify(right.args_any ?? null);

/** One synchronous read → change → atomic write; the only way the rules are edited. */
function editRules(home: string, change: (rules: Rule[]) => Rule[]): Policy {
  const current = loadPolicy(home);
  const next: Policy = { ...current, rules: change([...current.rules]) };
  writeAtomic(policyFile(home), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** Adds a rule, or changes the action of the rule with the same program and words. */
export function setRule(home: string, value: unknown): Policy {
  const rule = checkRule(value);
  return editRules(home, rules => {
    const index = rules.findIndex(item => sameRule(item, rule));
    if (index < 0) rules.push(rule); else rules[index] = rule;
    return rules;
  });
}

export function removeRule(home: string, value: unknown): Policy {
  const target = value as { program?: unknown; args_any?: unknown } | null;
  if (!target || typeof target.program !== 'string') throw new Error('Say which rule to remove: its program and, if it has them, its words');
  if (target.args_any !== undefined && !strings(target.args_any)) throw new Error('args_any must be a list of words');
  const key = { program: target.program, ...(target.args_any ? { args_any: target.args_any as string[] } : {}) };
  return editRules(home, rules => {
    const index = rules.findIndex(item => sameRule(item, key));
    if (index < 0) throw new Error('There is no such rule');
    rules.splice(index, 1);
    return rules;
  });
}

/** `write_flash` and `write-flash` are the same word to the tools this guards. */
const word = (value: string): string => value.replace(/_/g, '-');

function inside(directory: string, path: string): boolean {
  return path === directory || path.startsWith(directory + sep);
}

/** The path as the file system sees it; for a path that does not exist yet, its existing part resolved. */
export function settle(path: string): string {
  const full = resolve(path);
  let current = full;
  for (;;) {
    try {
      const real = realpathSync(current);
      return current === full ? real : join(real, relative(current, full));
    } catch {
      const parent = dirname(current);
      if (parent === current) return full;
      current = parent;
    }
  }
}

export const BUILT_IN = [
  'sudo and su never run',
  'espefuse may not burn or change read/write protection',
  'no command may carry --do-not-confirm',
  'no write or erase may carry --force',
  'nothing may run from, run in, or be pointed at the helper\'s own directory',
] as const;

/** The part no rules file can change. `cwd` is the directory the command would run in. */
export function builtInDeny(home: string, argv: readonly string[], cwd: string): string | undefined {
  const program = argv[0] as string;
  const args = argv.slice(1).map(word);
  if (program === 'sudo' || program === 'su') return 'builtin:' + program;
  if (/^espefuse(\.py)?$/.test(program) && args.some(arg => /^(burn|write-protect|read-protect)/.test(arg))) return 'builtin:efuse';
  if (args.includes('--do-not-confirm')) return 'builtin:do-not-confirm';
  if (args.includes('--force') && args.some(arg => /^(write|erase)-/.test(arg))) return 'builtin:force-write';
  const own = settle(home);
  if (inside(own, settle(cwd))) return 'builtin:helper-directory';
  for (const arg of argv.slice(1)) {
    // `--flag=/some/path` hides a path behind the equals sign.
    for (const candidate of new Set([arg, arg.slice(arg.indexOf('=') + 1)])) {
      if (candidate && inside(own, settle(resolve(cwd, candidate)))) return 'builtin:helper-directory';
    }
  }
  return undefined;
}

function matches(rule: Rule, program: string, args: readonly string[]): boolean {
  return rule.program === program && (!rule.args_any || rule.args_any.some(item => args.includes(word(item))));
}

const ruleName = (rule: Rule): string => rule.args_any ? rule.program + ' [' + rule.args_any.join(' ') + ']' : rule.program;

/** The verdict for one command. `policy` undefined = the rules file could not be read. */
export function judge(policy: Policy | undefined, home: string, argv: readonly string[], cwd: string): Verdict {
  const program = argv[0] as string;
  if (!BARE.test(program)) return { verdict: 'deny', rule: 'program-not-a-bare-name' };
  const denied = builtInDeny(home, argv, cwd);
  if (denied) return { verdict: 'deny', rule: denied };
  if (!policy) return { verdict: 'deny', rule: 'policy-invalid' };
  const args = argv.slice(1).map(word);
  for (const action of ['deny', 'confirm', 'allow'] as const) {
    const rule = policy.rules.find(item => item.action === action && matches(item, program, args));
    if (rule) return { verdict: action, rule: ruleName(rule) };
  }
  return { verdict: 'deny', rule: 'not-listed' };
}

/** The program's file among the policy's directories, or undefined when it is not installed there. */
export function findProgram(policy: Policy, program: string): string | undefined {
  for (const directory of policy.path) {
    const candidate = join(directory, program);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not in this directory */ }
  }
  return undefined;
}

/** True when the resolved program file lives in the helper's own directory. */
export function programInHome(home: string, file: string): boolean {
  return inside(settle(home), settle(file));
}

/** The program names a task may ask for, for `machine_info`. */
export function listedPrograms(policy: Policy): { allow: string[]; confirm: string[] } {
  const names = (action: Action): string[] => [...new Set(policy.rules.filter(rule => rule.action === action).map(ruleName))];
  return { allow: names('allow'), confirm: names('confirm') };
}
