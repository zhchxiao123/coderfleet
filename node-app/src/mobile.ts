// What the desktop App's "手机访问" page shows: the addresses a phone can use
// to reach this backend (LAN and mesh interfaces when the backend listens
// beyond loopback, a detected Tailscale name, and addresses the user added for
// a tunnel or reverse proxy), and the pairing payload for the QR code.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { atomicJSON, record, text } from './state.js';

export type AddressKind = 'lan' | 'mesh' | 'public';
export interface Address { readonly url: string; readonly kind: AddressKind; readonly label: string }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** True when the backend listens beyond this computer. */
export function listensBeyondLoopback(host: string): boolean { return !LOOPBACK.has(host); }

/** Private, link-local, CGNAT (Tailscale) or ULA: plain HTTP is acceptable only to these. */
export function privateHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name.endsWith('.local') || name.endsWith('.ts.net') || LOOPBACK.has(name)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(name) || name.startsWith('fe80:');
}

/** A phone-facing base URL: https anywhere, http only to private addresses; no path, query or credentials. */
export function phoneUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('地址格式不对，例如 https://cf.example.com'); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('只填协议、域名和端口，不带路径');
  if (url.protocol === 'http:' && !privateHost(url.hostname)) throw new Error('公网地址必须用 https://（令牌不能明文经过公网）');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('只支持 http:// 或 https://');
  return url.origin;
}

function meshInterface(name: string, address: string): string | undefined {
  if (/^(tailscale|utun)/.test(name) && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 'Tailscale';
  if (/^zt/.test(name)) return 'ZeroTier';
  if (/^(wg|tun)/.test(name)) return 'WireGuard / VPN';
  return undefined;
}

/** Bridges and virtual switches of Docker, OrbStack and VM hosts: this computer has an address there, a phone does not. */
const VIRTUAL_INTERFACE = /^(bridge|br-|docker|veth|virbr|vmnet|vnic|vboxnet|vEthernet|lxc|cni|podman|awdl|llw|anpi)/i;

/** The address is its own network's base address (as OrbStack's bridges report): nothing answers there. */
function networkAddress(address: string, netmask: string): boolean {
  const number = (value: string) => value.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
  const host = 2 ** 32 - 1 - number(netmask);
  return host > 0 && number(address) % (host + 1) === 0;
}

/**
 * Addresses of this computer a phone can reach, for a backend listening beyond
 * loopback: real LAN interfaces and mesh ones. Virtual bridges, self-assigned
 * (169.254) addresses and network base addresses are left out, so the phone
 * does not wait on addresses that never answer.
 */
export function interfaceAddresses(port: number, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): Address[] {
  const result: Address[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list ?? []) {
      if (item.internal || item.family !== 'IPv4') continue;
      const mesh = meshInterface(name, item.address);
      if (!mesh && (!privateHost(item.address) || VIRTUAL_INTERFACE.test(name) || item.address.startsWith('169.254.') || networkAddress(item.address, item.netmask))) continue;
      result.push({ url: 'http://' + item.address + ':' + port, kind: mesh ? 'mesh' : 'lan', label: mesh ?? '局域网 · ' + name });
    }
  }
  return result.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'lan' ? -1 : 1));
}

/** This computer's Tailscale DNS name, if Tailscale runs; `tailscale serve` then gives it HTTPS. */
export function tailscaleName(): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('tailscale', ['status', '--json'], { timeout: 2_000 }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      try { resolve(text(record(record(JSON.parse(stdout)).Self).DNSName).replace(/\.$/, '') || undefined); }
      catch { resolve(undefined); }
    });
  });
}

/** Addresses the user added (tunnels, reverse proxies, `tailscale serve`), kept in the backend's state directory. */
export class ExtraAddresses {
  private readonly path: string;

  public constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.path = join(stateDirectory, 'mobile.json');
  }

  public list(): Address[] {
    try {
      const raw = record(JSON.parse(readFileSync(this.path, 'utf8')));
      return (Array.isArray(raw.addresses) ? raw.addresses : []).map(record)
        .filter(item => typeof item.url === 'string')
        .map(item => {
          const url = text(item.url);
          const host = new URL(url).hostname;
          return { url, kind: privateHost(host) ? 'mesh' : 'public', label: text(item.label) || (host.endsWith('.ts.net') ? 'Tailscale' : '') } as Address;
        });
    } catch { return []; }
  }

  public save(urls: readonly { url: string; label?: string }[]): Address[] {
    const clean = [...new Map(urls.map(item => [phoneUrl(item.url), text(item.label).trim().slice(0, 40)])).entries()].slice(0, 10);
    atomicJSON(this.path, { addresses: clean.map(([url, label]) => ({ url, label })) });
    return this.list();
  }
}

/** The QR payload: coderfleet://pair?v=1&name=…&token=…&url=…&url=… (addresses in the order to try). */
export function pairingLink(name: string, token: string, addresses: readonly Address[]): string {
  const params = new URLSearchParams({ v: '1', name, token });
  for (const address of addresses) params.append('url', address.url);
  return 'coderfleet://pair?' + params.toString();
}
