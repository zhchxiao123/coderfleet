import { resolve } from 'node:path';
import { login } from './docker.js';
import { serve } from './server.js';
import { message, readConfig } from './state.js';
import { executeTurn } from './worker.js';

const [mode, rawPath, id] = process.argv.slice(2);

try {
  if (!rawPath) throw new Error('Usage: node dist/cli.js serve <config.json> | login <config.json> <project>');
  const configPath = resolve(rawPath);
  if (mode === 'serve') {
    const server = await serve(configPath);
    const address = server.address();
    console.log('CoderFleet Node service listening on ' + JSON.stringify(address));
    const close = () => server.close();
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  } else if (mode === 'login') {
    const project = readConfig(configPath).projects.find(item => item.id === id);
    if (!project) throw new Error('Unknown project');
    process.exitCode = await login(project);
  } else if (mode === 'worker' && id) {
    await executeTurn(configPath, id);
  } else throw new Error('Unknown command');
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
