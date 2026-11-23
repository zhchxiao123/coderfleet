// Backend command line. The desktop App runs `serve` for this computer; on a
// remote Docker host the installer runs `init`, then `serve` as a service.
//   serve [config]   start the service (default config: ~/.coderfleet-backend/config.json)
//   init [config]    create the configuration with a random token if missing; print it as JSON
//   status [config]  exit 0 when the configured service answers its health check
//   version          print the backend version
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serve } from './server.js';
import { atomicJSON, message, readConfig } from './state.js';
import { VERSION } from './version.js';

const home = process.env.CODERFLEET_BACKEND_HOME || join(homedir(), '.coderfleet-backend');
const [mode, rawPath] = process.argv.slice(2);
const configPath = resolve(rawPath || join(home, 'config.json'));

try {
  if (mode === 'serve') {
    const server = await serve(configPath);
    console.log('CoderFleet backend ' + VERSION + ' listening on ' + JSON.stringify(server.address()));
    const close = () => server.close();
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  } else if (mode === 'init') {
    if (!existsSync(configPath)) {
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      atomicJSON(configPath, {
        port: Number(process.env.CODERFLEET_BACKEND_PORT) || 8877,
        token: randomBytes(32).toString('base64url'),
        workspace: process.env.CODERFLEET_WORKSPACE || join(homedir(), '.coderfleet'),
        stateDirectory: join(dirname(configPath), 'state'),
      });
    }
    const config = readConfig(configPath);
    console.log(JSON.stringify({ port: config.port, token: config.token, version: VERSION, configPath, workspace: config.workspace }));
  } else if (mode === 'status') {
    const config = readConfig(configPath);
    const response = await fetch('http://127.0.0.1:' + config.port + '/v1/health', {
      headers: { Authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(3_000),
    });
    const health = await response.json() as { build?: string };
    if (!response.ok) throw new Error('Health check failed with HTTP ' + response.status);
    console.log(JSON.stringify({ running: true, version: health.build ?? '' }));
  } else if (mode === 'version') {
    console.log(VERSION);
  } else throw new Error('Usage: coderfleet-backend serve|init|status [config.json] | version');
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
