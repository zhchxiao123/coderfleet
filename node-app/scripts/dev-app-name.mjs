// `npm run desktop` starts the stock Electron.app, and macOS takes the Dock and
// menu-bar name from that bundle's Info.plist, which the running App cannot change.
// Rename the development copy in node_modules so it shows CoderFleet; packaged Apps
// get the name from electron-packager instead.
import { execFileSync } from 'node:child_process';
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'CoderFleet';
if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const bundle = join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  const plist = join(bundle, 'Contents', 'Info.plist');
  if (existsSync(plist)) {
    const current = key => { try { return execFileSync('plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim(); } catch { return ''; } };
    if (current('CFBundleName') !== NAME || current('CFBundleDisplayName') !== NAME) {
      for (const key of ['CFBundleName', 'CFBundleDisplayName']) execFileSync('plutil', ['-replace', key, '-string', NAME, plist]);
      // Touch the bundle so Launch Services rereads the name instead of its cached "Electron".
      const now = new Date();
      utimesSync(bundle, now, now);
    }
  }
}
