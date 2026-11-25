// Task tokens: a grant plus HMAC-SHA256(master secret, grant). The helper checks
// them by itself, so it works without anything to ask.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';

export type Access = 'command' | 'gui';
export interface Grant {
  /** Who is calling; processes, confirmations and revocation are grouped by it. */
  readonly task: string;
  /** Shown in confirmations and the audit log (CoderFleet: the project name). */
  readonly label: string;
  readonly access: Access;
  /** The directory commands may use as their working directory. */
  readonly root: string;
  /** Expiry, seconds since the epoch. */
  readonly exp: number;
}

const PREFIX = 'cfh1';
const mac = (secret: Buffer, body: string): Buffer => createHmac('sha256', secret).update(body).digest();

export function signToken(secret: Buffer, grant: Grant): string {
  const body = PREFIX + '.' + Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
  return body + '.' + mac(secret, body).toString('base64url');
}

/** The grant of a token whose signature is right and that has not expired; otherwise undefined. */
export function readToken(secret: Buffer, token: string, now = Date.now()): Grant | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return undefined;
  const given = Buffer.from(parts[2] as string, 'base64url');
  const expected = mac(secret, parts[0] + '.' + parts[1]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { return undefined; }
  const { task, label, access, root, exp } = raw;
  if (typeof task !== 'string' || !task || task.length > 200) return undefined;
  if (typeof label !== 'string' || (access !== 'command' && access !== 'gui')) return undefined;
  if (typeof root !== 'string' || !isAbsolute(root)) return undefined;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= now) return undefined;
  return { task, label, access, root, exp };
}
