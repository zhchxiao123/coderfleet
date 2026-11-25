#!/usr/bin/env node
// coderfleet-helper: lets tasks holding a token run listed commands on this machine.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAudit } from './audit.ts';
import { ensureHome, helperHome, readRun, readSecret } from './home.ts';
import { BUILT_IN, loadPolicy, removeRule, setPath, setRule, setUnlisted } from './policy.ts';
import { DEFAULT_PORT, startHelper, TOKEN_SECONDS } from './server.ts';
import { signToken } from './token.ts';
import { PROTOCOL, VERSION } from './version.ts';

const USAGE = `coderfleet-helper ${VERSION}

  serve [--port ${DEFAULT_PORT}] [--host 127.0.0.1]   run the service in the foreground (start is the same)
  status                                   is it running, and what is it doing
  stop                                     stop the running service and everything it started
  token --root <dir> [--access command|gui] [--task <name>] [--label <text>]
                                           print a 24-hour task token for that directory
  policy show
  policy set <program> <allow|confirm|deny> [word …]
  policy remove <program> [word …]         rules; words narrow a rule to commands carrying one of them
  policy unlisted <allow|confirm|deny>     what happens to a command no rule matches
  policy path <directory> …                where programs are looked up
  audit [-n 50]                            the newest lines of the operation log
  version

Files are in ${helperHome()} (set CODERFLEET_HELPER_HOME to use another directory).`;

function flags(args: string[], names: readonly string[]): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const name = arg.replace(/^--?/, '');
    if (arg.startsWith('-') && names.includes(name)) {
      const value = args[++index];
      if (value === undefined) throw new Error(arg + ' needs a value');
      values[name] = value;
    } else if (arg.startsWith('--')) throw new Error('Unknown option ' + arg);
    else rest.push(arg);
  }
  return { values, rest };
}

async function control(home: string, method: string, path: string): Promise<Record<string, unknown>> {
  const record = readRun(home);
  if (!record) throw new Error('The helper is not running');
  const address = record.host.includes(':') ? '[' + record.host + ']' : record.host;
  const response = await fetch('http://' + address + ':' + record.port + '/control/' + path, {
    method, headers: { authorization: 'Bearer ' + readSecret(home).toString('hex') }, signal: AbortSignal.timeout(5000),
  }).catch(() => { throw new Error('The helper is not running'); });
  const answer = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(answer.error ?? response.status));
  return answer;
}

async function main(args: string[]): Promise<void> {
  const home = helperHome();
  const command = args[0];
  if (command === 'version') { console.log(VERSION + ' (protocol ' + PROTOCOL + ')'); return; }
  if (command === 'serve' || command === 'start') {
    const { values } = flags(args.slice(1), ['port', 'host']);
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number');
    let closing = false;
    const quit = (): void => {
      if (closing) return;
      closing = true;
      void helper.close().finally(() => process.exit(0));
    };
    const helper = await startHelper({ home, port, ...(values.host ? { host: values.host } : {}), onStop: quit });
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    console.log('coderfleet-helper ' + VERSION + ' is listening on http://' + helper.host + ':' + helper.port + '/mcp');
    return;
  }
  if (command === 'status') {
    try { console.log(JSON.stringify(await control(home, 'GET', 'status'), null, 2)); }
    catch (error) { console.log((error as Error).message); process.exitCode = 3; }
    return;
  }
  if (command === 'stop') { await control(home, 'POST', 'stop'); console.log('Stopped'); return; }
  if (command === 'token') {
    const { values } = flags(args.slice(1), ['root', 'access', 'task', 'label']);
    if (!values.root) throw new Error('Say which directory the token is for: --root <dir>');
    const access = values.access ?? 'command';
    if (access !== 'command' && access !== 'gui') throw new Error('--access must be command or gui');
    ensureHome(home);
    const task = values.task ?? 'manual-' + randomBytes(4).toString('hex');
    console.log(signToken(readSecret(home), {
      task, label: values.label ?? 'manual', access, root: realpathSync(resolve(values.root)), exp: Math.floor(Date.now() / 1000) + TOKEN_SECONDS,
    }));
    return;
  }
  if (command === 'policy') {
    ensureHome(home);
    const [action, program, ...rest] = args.slice(1);
    if (action === 'set') {
      const [verdict, ...words] = rest;
      setRule(home, { program, action: verdict, ...(words.length ? { args_any: words } : {}) });
    } else if (action === 'remove') removeRule(home, { program, ...(rest.length ? { args_any: rest } : {}) });
    else if (action === 'unlisted') setUnlisted(home, program);
    else if (action === 'path') setPath(home, args.slice(2));
    else if (action !== 'show') throw new Error('policy show | set <program> <allow|confirm|deny> [word …] | remove <program> [word …] | unlisted <allow|confirm|deny> | path <directory> …');
    console.log(JSON.stringify(loadPolicy(home), null, 2));
    if (action === 'show') console.log('\nAlways refused, whatever the rules say:\n' + BUILT_IN.map(line => '  - ' + line).join('\n'));
    return;
  }
  if (command === 'audit') {
    const { values } = flags(args.slice(1), ['n']);
    const count = Number(values.n ?? 50);
    if (!Number.isInteger(count) || count < 1) throw new Error('-n must be a positive number');
    ensureHome(home);
    for (const record of readAudit(home, count)) console.log(JSON.stringify(record));
    return;
  }
  console.log(USAGE);
  if (command && command !== 'help' && command !== '--help' && command !== '-h') process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
