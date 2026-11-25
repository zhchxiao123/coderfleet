// docker-compose.yml generation, ported from coderfleet/compose.py. The file is
// written as JSON, which is valid YAML, so `docker compose` reads it unchanged.
// Service names, container names, networks, mounts and environment match the
// Python generator so either service manages the same containers.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountType } from './accounts.js';
import { ensureBindMountDir, expandHome, loadConfig, parseConf, truthy, WorkspaceError, type ConfRecord } from './conf.js';

type Json = Record<string, unknown>;

export function imageName(config: ConfRecord): string {
  return (config.IMAGE_NAME || 'coderfleet') + ':' + (config.IMAGE_TAG || 'latest');
}

function containerTimezone(config: ConfRecord): string {
  const value = (config.CONTAINER_TIMEZONE ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { throw new WorkspaceError('无效的容器时区 ' + value); }
  return value;
}

function gostConfig(relayPort: string, dnsPort: string, dnsUpstream: string, upstreamHost: string, upstreamPort: string,
  bypass: string[], bridgePort: string, bridgeTarget: string): Json {
  return {
    services: [
      { name: 'service-0', addr: ':' + relayPort, handler: { type: 'http', chain: 'chain-0' }, listener: { type: 'tcp' } },
      {
        name: 'service-dns', addr: ':' + dnsPort, handler: { type: 'dns', chain: 'chain-0' }, listener: { type: 'dns' },
        forwarder: { nodes: [{ name: 'dns-upstream', addr: dnsUpstream }] },
      },
      {
        name: 'service-bridge', addr: ':' + bridgePort, handler: { type: 'tcp' }, listener: { type: 'tcp' },
        forwarder: { nodes: [{ name: 'bridge', addr: bridgeTarget }] },
      },
    ],
    chains: [{
      name: 'chain-0',
      hops: [{ name: 'hop-0', bypass: 'bypass-0', nodes: [{ name: 'node-0', addr: upstreamHost + ':' + upstreamPort, connector: { type: 'http' } }] }],
    }],
    bypasses: [{ name: 'bypass-0', matchers: bypass }],
  };
}

interface DockerSocket { host: string; container: string }

function pathFromEndpoint(value: string): string {
  let path = value.trim();
  if (path.startsWith('unix://')) path = path.slice('unix://'.length);
  if (!path || path.includes('://')) return '';
  return expandHome(path);
}

function daemonPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.includes('/.colima/') && normalized.endsWith('/docker.sock')) return '/var/run/docker.sock';
  if (normalized.endsWith('/.docker/run/docker.sock')) return '/var/run/docker.sock';
  return path;
}

function contextHost(dockerPath: string): string {
  try {
    return execFileSync(dockerPath, ['context', 'inspect', '--format', '{{ (index .Endpoints "docker").Host }}'], { timeout: 5_000, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function resolveDockerSocket(config: ConfRecord, dockerPath: string): DockerSocket | undefined {
  const configured = (config.DOCKER_SOCKET ?? '').trim();
  if (!configured || ['off', 'false', '0', 'no'].includes(configured.toLowerCase())) return undefined;
  const container = (config.DOCKER_SOCKET_TARGET ?? '/var/run/docker.sock').trim() || '/var/run/docker.sock';
  if (configured.toLowerCase() === 'auto') {
    const envHost = process.env.DOCKER_HOST ?? '';
    const ctxHost = contextHost(dockerPath);
    for (const endpoint of [envHost, ctxHost]) {
      const path = pathFromEndpoint(endpoint);
      if (path && daemonPath(path) !== path) return { host: daemonPath(path), container };
    }
    const uid = process.getuid?.() ?? 0;
    const candidates = [pathFromEndpoint(envHost), pathFromEndpoint(ctxHost), '/var/run/docker.sock',
      join(homedir(), '.docker', 'run', 'docker.sock'), join(homedir(), '.colima', 'default', 'docker.sock'),
      '/run/user/' + uid + '/docker.sock', '/run/user/' + uid + '/podman/podman.sock'];
    for (const path of [...new Set(candidates.filter(Boolean))]) if (existsSync(path)) return { host: daemonPath(path), container };
    return undefined;
  }
  const host = pathFromEndpoint(configured);
  return host ? { host: daemonPath(host), container } : undefined;
}

function parseMounts(raw: string): { volume: string; host: string; container: string }[] {
  return raw.split(',').filter(token => token.trim()).map(token => {
    const spec = token.trim();
    const parts = spec.split(':');
    let host: string; let container: string; let readOnly = false;
    if (parts.length === 2) [host, container] = parts as [string, string];
    else if (parts.length === 3 && (parts[2] === 'ro' || parts[2] === 'rw')) { [host, container] = parts as [string, string]; readOnly = parts[2] === 'ro'; }
    else throw new WorkspaceError('挂载格式错误：' + spec + '，应为 HOST_PATH:CONTAINER_PATH[:ro]');
    host = expandHome(host.trim());
    container = container.trim();
    if (!host) throw new WorkspaceError('挂载格式错误：' + spec + '，宿主机路径不能为空');
    if (!container.startsWith('/')) throw new WorkspaceError('挂载格式错误：' + spec + '，容器路径必须是绝对路径');
    return { host, container, volume: host + ':' + container + (readOnly ? ':ro' : '') };
  });
}

/** A project's EXTRA_MOUNTS, checked: the format, that the host paths exist and that nothing lands on a path the container already uses. */
export function projectMounts(name: string, raw: string, authDir: string): { volume: string; host: string; container: string }[] {
  const mounts = parseMounts(raw);
  for (const mount of mounts) {
    if (mount.container === '/workspace' || mount.container === authDir) {
      throw new WorkspaceError('项目 ' + name + ' 的 EXTRA_MOUNTS 配置无效：容器路径 ' + mount.container + ' 已被项目工作区或账号认证目录占用');
    }
    if (!existsSync(mount.host)) throw new WorkspaceError('项目 ' + name + ' 的 EXTRA_MOUNTS 配置无效：宿主机路径 ' + mount.host + ' 不存在');
  }
  return mounts;
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function allocateIdePort(used: Set<number>): Promise<number> {
  const candidates: number[] = [];
  for (let port = 18080; port <= 29999; port += 1) if (!used.has(port)) candidates.push(port);
  for (let attempt = 0; attempt < 200 && candidates.length; attempt += 1) {
    const index = Math.floor(Math.random() * candidates.length);
    const port = candidates.splice(index, 1)[0] as number;
    if (await portAvailable(port)) return port;
  }
  throw new WorkspaceError('没有可用的 IDE 端口');
}

export interface ComposeResult { readonly data: Json; readonly gost?: Json; readonly projects: number }

export async function generateCompose(workspace: string, dockerPath = 'docker'): Promise<ComposeResult> {
  const config = loadConfig(workspace);
  const projects = parseConf(join(workspace, 'projects.conf')).filter(record => record.NAME && record.ACCOUNT && record.PATH);
  const accounts = new Map(parseConf(join(workspace, 'accounts.conf')).filter(record => record.NAME).map(record => [record.NAME as string, record]));
  const image = imageName(config);
  const subnet = config.INTERNAL_SUBNET || '172.21.0.0/16';
  const relayIp = config.RELAY_IP || '172.21.0.2';
  const relayPort = config.RELAY_LISTEN_PORT || '7890';
  const proxyHost = config.PROXY_HOST || 'host.docker.internal';
  const httpPort = config.PROXY_HTTP_PORT || '7890';
  const relayImage = config.RELAY_IMAGE || 'gogost/gost:3';
  const dnsPort = config.DNS_LISTEN_PORT || '53';
  const dnsUpstream = config.DNS_UPSTREAM || 'https://1.1.1.1/dns-query';
  const bridgePort = config.MCP_BRIDGE_RELAY_PORT || '8766';
  const serverPort = config.CODERFLEET_PORT || '8765';
  const ideProxyImage = config.IDE_PROXY_IMAGE || 'alpine/socat:latest';
  const platform = config.BUILD_PLATFORM || 'linux/amd64';
  const timezone = containerTimezone(config);
  const proxyMode = config.PROXY_MODE || 'host';
  const xrayIp = config.XRAY_IP || '172.21.0.3';
  const xrayPort = config.XRAY_LISTEN_PORT || '10809';
  const xrayImage = config.XRAY_IMAGE || 'ghcr.io/xtls/xray-core:latest';
  const xrayConfig = expandHome(config.XRAY_CONFIG || join(homedir(), '.coderfleet', 'xray', 'config.json'));
  const [upstreamHost, upstreamPort] = proxyMode === 'xray' ? [xrayIp, xrayPort] : [proxyHost, httpPort];
  const bypass = (config.PROXY_BYPASS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const proxyUrl = 'http://' + relayIp + ':' + relayPort;
  const noProxy = 'localhost,127.0.0.1,' + subnet;

  const services: Json = {};
  let needsRelay = false;
  let count = 0;
  const usedIdePorts = new Set<number>();
  for (const project of projects) {
    const name = project.NAME as string;
    const accountName = project.ACCOUNT as string;
    const path = expandHome(project.PATH as string);
    const ideEnabled = truthy(project.IDE ?? 'off');
    if (!truthy(project.ACTIVE ?? 'on') || truthy(project.EPHEMERAL ?? 'off')) continue;
    const account = accounts.get(accountName);
    if (!account || (account.RUNTIME ?? 'container') === 'local') continue;
    const type = account.TYPE || 'codex';
    const auth = account.AUTH || 'login';
    const envFile = account.ENV_FILE || '';
    const proxy = account.PROXY || 'relay';
    const secondary = (project.SECONDARY_ACCOUNTS ?? '').split(',').map(item => item.trim()).filter(Boolean);
    const types = [type];
    for (const secondaryName of secondary) {
      const secondaryAccount = accounts.get(secondaryName);
      if (!secondaryAccount) throw new WorkspaceError('项目 ' + name + ' 绑定的从账号 ' + secondaryName + ' 不存在');
      types.push(secondaryAccount.TYPE || 'codex');
    }
    const duplicates = [...new Set(types.filter((item, index) => types.indexOf(item) !== index))];
    if (duplicates.length) throw new WorkspaceError('项目 ' + name + ' 绑定的账号类型冲突：' + duplicates.join(' / ') + ' 类型的账号只能绑定一个');
    const spec = accountType(type);
    const serviceName = type + '-project-' + name;
    ensureBindMountDir(join(workspace, 'accounts', accountName));
    const environment: Record<string, string> = {
      TZ: timezone, CODEX_HOME: '/home/byclaw/.codex', CLAUDE_CONFIG_DIR: '/home/byclaw/.claude',
      CODERFLEET_ACCOUNT_NAME: accountName, CODERFLEET_ACCOUNT_TYPE: type, CODERFLEET_ACCOUNT_AUTH: auth, CODERFLEET_ACCOUNT_PROXY: proxy,
      ...spec.envVars,
    };
    if (proxy !== 'off') {
      Object.assign(environment, {
        HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl,
        NO_PROXY: noProxy, no_proxy: noProxy, CODERFLEET_RELAY_IP: relayIp, CODERFLEET_RELAY_PORT: relayPort,
        CODERFLEET_MCP_BRIDGE_PORT: bridgePort,
      });
    }
    const service: Json = {
      image: project.IMAGE || image, platform, pull_policy: 'never', container_name: type + '-' + name, restart: 'unless-stopped',
      networks: proxy !== 'off' ? { intnet: {} } : { extnet: {} }, environment,
      volumes: ['./accounts/' + accountName + ':' + spec.authDir, path + ':/workspace'], working_dir: '/workspace',
    };
    const volumes = service.volumes as string[];
    if (proxy !== 'off') service.dns = [relayIp];
    for (const secondaryName of secondary) {
      const secondaryAccount = accounts.get(secondaryName) as ConfRecord;
      ensureBindMountDir(join(workspace, 'accounts', secondaryName));
      volumes.push('./accounts/' + secondaryName + ':' + accountType(secondaryAccount.TYPE || 'codex').authDir);
      if ((secondaryAccount.AUTH || 'login') === 'env' && secondaryAccount.ENV_FILE && secondaryAccount.ENV_FILE !== '-') {
        ((service.env_file ??= []) as string[]).push(secondaryAccount.ENV_FILE);
      }
    }
    const socketConfig = { ...config };
    if ('DOCKER_SOCKET' in project) socketConfig.DOCKER_SOCKET = project.DOCKER_SOCKET ?? '';
    if ('DOCKER_SOCKET_TARGET' in project) socketConfig.DOCKER_SOCKET_TARGET = project.DOCKER_SOCKET_TARGET ?? '';
    const socket = resolveDockerSocket(socketConfig, dockerPath);
    if (socket) {
      volumes.push(socket.host + ':' + socket.container);
      environment.DOCKER_HOST = 'unix://' + socket.container;
      environment.CODERFLEET_HOST_WORKSPACE = path;
      environment.CODERFLEET_DOCKER_SOCKET = socket.container;
    }
    for (const mount of projectMounts(name, project.EXTRA_MOUNTS ?? '', spec.authDir)) volumes.push(mount.volume);
    let idePort = 0; let ideRemote = false;
    if (ideEnabled) {
      if (project.IDE_PORT) {
        idePort = Number(project.IDE_PORT);
        if (!Number.isInteger(idePort)) throw new WorkspaceError('项目 ' + name + ' 启用 IDE 时必须设置有效 IDE_PORT');
        if (idePort < 1024 || idePort > 65535) throw new WorkspaceError('项目 ' + name + ' 的 IDE_PORT 必须在 1024-65535 之间');
      } else idePort = await allocateIdePort(usedIdePorts);
      if (usedIdePorts.has(idePort)) throw new WorkspaceError('IDE_PORT ' + idePort + ' 被多个项目重复使用');
      usedIdePorts.add(idePort);
      ideRemote = truthy(project.IDE_REMOTE ?? 'off');
      Object.assign(environment, {
        CODERFLEET_IDE: 'on', CODERFLEET_IDE_PORT: '8080', CODERFLEET_IDE_AUTH: project.IDE_AUTH || 'none',
        CODERFLEET_IDE_BIND: ideRemote ? '0.0.0.0' : '127.0.0.1',
      });
      ensureBindMountDir(join(workspace, 'ide-data', name));
      volumes.push('./ide-data/' + name + ':/home/byclaw/.local/share/code-server');
    }
    if (auth === 'env' && envFile && envFile !== '-') service.env_file = [envFile, ...((service.env_file as string[] | undefined) ?? [])];
    const projectEnv = join(workspace, 'projects', name, 'env');
    if (existsSync(projectEnv)) {
      for (const raw of readFileSync(projectEnv, 'utf8').split('\n')) {
        const line = raw.trim();
        const index = line.indexOf('=');
        if (!line || line.startsWith('#') || index < 0) continue;
        environment[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
    }
    if (proxy !== 'off') {
      needsRelay = true;
      service.depends_on = { 'proxy-relay': { condition: 'service_healthy' } };
    }
    services[serviceName] = service;
    if (ideEnabled) {
      const networks: Json = { extnet: {} };
      if (proxy !== 'off') networks.intnet = {};
      services['ide-project-' + name] = {
        image: ideProxyImage, container_name: 'coderfleet-ide-' + name, restart: 'unless-stopped', networks,
        ports: [(ideRemote ? '0.0.0.0' : '127.0.0.1') + ':' + idePort + ':8080'], entrypoint: ['socat'],
        command: ['TCP-LISTEN:8080,fork,reuseaddr', 'TCP:' + serviceName + ':8080'],
        depends_on: { [serviceName]: { condition: 'service_started' } },
      };
    }
    count += 1;
  }

  let gost: Json | undefined;
  if (needsRelay) {
    if (proxyMode === 'xray') {
      if (!existsSync(xrayConfig)) throw new WorkspaceError('Xray 配置文件不存在：' + xrayConfig);
      services['xray-proxy'] = {
        image: xrayImage, container_name: 'coderfleet-xray-proxy', restart: 'unless-stopped',
        networks: { intnet: { ipv4_address: xrayIp }, extnet: {} },
        volumes: [xrayConfig + ':/etc/xray/config.json:ro'], command: ['run', '-c', '/etc/xray/config.json'],
      };
    }
    const relay: Json = {
      image: relayImage, container_name: 'coderfleet-proxy-relay', restart: 'unless-stopped',
      networks: { intnet: { ipv4_address: relayIp }, extnet: {} }, extra_hosts: ['host.docker.internal:host-gateway'],
      healthcheck: { test: ['CMD', 'sh', '-c', 'nc -z localhost ' + relayPort], interval: '8s', timeout: '4s', retries: 5, start_period: '5s' },
    };
    if (proxyMode === 'xray') relay.depends_on = { 'xray-proxy': { condition: 'service_started' } };
    gost = gostConfig(relayPort, dnsPort, dnsUpstream, upstreamHost, upstreamPort, bypass, bridgePort, 'host.docker.internal:' + serverPort);
    relay.command = '-C /etc/gost/config.yaml';
    relay.volumes = ['./proxy-relay-config.yaml:/etc/gost/config.yaml:ro'];
    services['proxy-relay'] = relay;
  }
  const networks: Json = { extnet: { driver: 'bridge' } };
  if (needsRelay) networks.intnet = { driver: 'bridge', internal: true, ipam: { config: [{ subnet }] } };
  return { data: { networks, services }, gost, projects: count };
}

function writeAtomic(path: string, content: string): void {
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

/** Writes docker-compose.yml (and the relay configuration) for the current workspace. */
export async function writeCompose(workspace: string, dockerPath = 'docker'): Promise<ComposeResult> {
  const result = await generateCompose(workspace, dockerPath);
  const header = '# !! 此文件由 CoderFleet 自动生成，请勿手动编辑 !!\n';
  if (result.gost) writeAtomic(join(workspace, 'proxy-relay-config.yaml'), header + JSON.stringify(result.gost, null, 2) + '\n');
  writeAtomic(join(workspace, 'docker-compose.yml'), header + JSON.stringify(result.data, null, 2) + '\n');
  return result;
}
