import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The backend version from package.json, shipped next to dist/ in every bundle. */
export const VERSION: string = (() => {
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch { return '0.0.0'; }
})();
