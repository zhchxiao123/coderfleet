// Browsing a project's files from the App (the Python Web UI's 文件 panel):
// one directory level at a time, a text or image preview, and the raw file
// for saving. Every path stays inside the project directory, symlinks included.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';

export class FileAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface FileEntry { name: string; path: string; isDir: boolean; size: number | null; modified: number | null }

/** Like the Python service (_FILES_SKIP), plus CoderFleet's own worker directory. */
const SKIP = new Set(['.coderfleet-tasks', '.git', '__pycache__', 'node_modules', '.DS_Store', '.mypy_cache', '.ruff_cache']);
const IMAGES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};
const TEXT_LIMIT = 512 * 1024;
const RAW_LIMIT = 50 * 1024 * 1024;

/** The real path of `rel` under `root`; rejects anything that leaves it. */
function resolveInside(root: string, rel: string): { base: string; target: string } {
  let base: string;
  try { base = realpathSync(root); } catch { throw new FileAccessError(404, '项目目录不存在'); }
  if (rel.includes('\0')) throw new FileAccessError(400, '路径不合法');
  let target: string;
  try { target = realpathSync(join(base, rel)); } catch { throw new FileAccessError(404, '文件不存在'); }
  if (target !== base && !target.startsWith(base + sep)) throw new FileAccessError(403, '路径不合法');
  return { base, target };
}

export function listFiles(root: string, rel = ''): FileEntry[] {
  const { base, target } = resolveInside(root, rel);
  if (!statSync(target).isDirectory()) throw new FileAccessError(400, '不是目录');
  const entries: FileEntry[] = [];
  let names: string[] = [];
  try { names = readdirSync(target); } catch { return entries; }
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const full = join(target, name);
    try {
      // A symlink is listed by what it points to, and only when that stays inside.
      const link = lstatSync(full).isSymbolicLink();
      const real = link ? realpathSync(full) : full;
      if (link && real !== base && !real.startsWith(base + sep)) continue;
      const stat = statSync(real);
      entries.push({ name, path: relative(base, full).split(sep).join('/'), isDir: stat.isDirectory(), size: stat.isDirectory() ? null : stat.size, modified: stat.mtimeMs });
    } catch { /* vanished or unreadable */ }
  }
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export type Preview =
  | { kind: 'text'; name: string; size: number; content: string; truncated: boolean }
  | { kind: 'image'; name: string; size: number; mime: string; data: string }
  | { kind: 'binary'; name: string; size: number };

/** Text (first 512 KB) or an image; anything with a NUL byte near the start is binary. */
export function previewFile(root: string, rel: string): Preview {
  const { target } = resolveInside(root, rel);
  const stat = statSync(target);
  if (!stat.isFile()) throw new FileAccessError(400, '不是文件');
  const name = basename(target);
  const mime = IMAGES[extname(name).toLowerCase()];
  if (mime && stat.size <= 20 * 1024 * 1024) return { kind: 'image', name, size: stat.size, mime, data: readFileSync(target).toString('base64') };
  const head = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT));
  const fd = openSync(target, 'r');
  try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  if (head.subarray(0, 1024).includes(0)) return { kind: 'binary', name, size: stat.size };
  return { kind: 'text', name, size: stat.size, content: head.toString('utf8'), truncated: stat.size > TEXT_LIMIT };
}

/** The whole file (up to 50 MB), for saving a copy on this computer. */
export function rawFile(root: string, rel: string): { name: string; size: number; data: string } {
  const { target } = resolveInside(root, rel);
  const stat = statSync(target);
  if (!stat.isFile()) throw new FileAccessError(400, '不是文件');
  if (stat.size > RAW_LIMIT) throw new FileAccessError(413, '文件超过 50 MB，请在项目目录里直接打开');
  return { name: basename(target), size: stat.size, data: readFileSync(target).toString('base64') };
}
