// Serial ports without a native module: `stty` sets the line up, `cat` reads it,
// and the read ends by stopping `cat`, so nothing blocks inside this process.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.ts';
import type { Running } from './exec.ts';

export const MAX_SERIAL_SECONDS = 60;
export const BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600] as const;

/** macOS: /dev/cu.*; Linux: /dev/ttyUSB*, /dev/ttyACM*. */
export function listSerialPorts(platform: NodeJS.Platform, directory = '/dev'): string[] {
  const wanted = platform === 'darwin' ? /^cu\./ : /^tty(USB|ACM)\d+$/;
  try { return readdirSync(directory).filter(name => wanted.test(name)).sort().map(name => join(directory, name)); }
  catch { return []; }
}

/**
 * Reads `seconds` of output from a port. Returns the reader so the caller can stop it
 * with the task; the outcome's stdout is what the port sent.
 */
export function readSerial(input: { port: string; baud: number; seconds: number; platform: NodeJS.Platform; env: Record<string, string> }): Running {
  const flag = input.platform === 'darwin' ? '-f' : '-F';
  const environment = { ...input.env, PATH: '/bin:/usr/bin' };
  let reader: Running | undefined;
  let stopped = false;
  const setup = run({ file: '/bin/stty', args: [flag, input.port, String(input.baud), 'raw', '-echo'], cwd: '/', env: environment, timeoutMs: 5000 });
  const done = setup.done.then(async prepared => {
    if (prepared.exit_code !== 0) throw new Error('Could not set up ' + input.port + ': ' + (prepared.stderr.trim() || 'stty exited with ' + prepared.exit_code));
    if (stopped) return { ...prepared, stopped: true };
    reader = run({ file: '/bin/cat', args: [input.port], cwd: '/', env: environment, timeoutMs: input.seconds * 1000 });
    const outcome = await reader.done;
    // Reaching the time limit is how a read normally ends; anything else `cat` says is a failure.
    if (!outcome.timed_out && !outcome.stopped && outcome.exit_code !== 0) throw new Error('Reading ' + input.port + ' failed: ' + (outcome.stderr.trim() || 'cat exited with ' + outcome.exit_code));
    return outcome;
  });
  return { done, stop(force) { stopped = true; setup.stop(force); reader?.stop(force); } };
}
