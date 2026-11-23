// Starts the backend service. The desktop App runs this for a local backend;
// on a remote Docker host it runs under a process manager.
import { resolve } from 'node:path';
import { serve } from './server.js';
import { message } from './state.js';

const [mode, rawPath] = process.argv.slice(2);

try {
  if (mode !== 'serve' || !rawPath) throw new Error('Usage: node dist/cli.js serve <config.json>');
  const server = await serve(resolve(rawPath));
  console.log('CoderFleet Node service listening on ' + JSON.stringify(server.address()));
  const close = () => server.close();
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
