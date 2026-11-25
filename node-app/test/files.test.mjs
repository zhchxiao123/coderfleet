import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment } from './helpers.mjs';

test('the App browses and previews a project\'s files, never outside it', async () => {
  const env = await environment({ accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n` });
  try {
    mkdirSync(join(env.project, 'src'));
    mkdirSync(join(env.project, 'node_modules'));
    writeFileSync(join(env.project, 'README.md'), '# Hello\n');
    writeFileSync(join(env.project, 'src', 'main.ts'), 'export const port = 8080;\n');
    writeFileSync(join(env.project, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    writeFileSync(join(env.project, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
    writeFileSync(join(env.root, 'secret.txt'), 'outside');
    symlinkSync(join(env.root, 'secret.txt'), join(env.project, 'leak.txt'));
    symlinkSync(join(env.project, 'src', 'main.ts'), join(env.project, 'main-link.ts'));

    const root = (await env.get('projects/web/files')).body;
    assert.deepEqual(root.map(entry => [entry.name, entry.isDir]), [['src', true], ['blob.bin', false], ['logo.png', false], ['main-link.ts', false], ['README.md', false]]);
    assert.deepEqual((await env.get('projects/web/files?path=src')).body.map(entry => entry.path), ['src/main.ts']);

    const text = (await env.get('projects/web/files/preview?path=' + encodeURIComponent('src/main.ts'))).body;
    assert.deepEqual([text.kind, text.content, text.truncated], ['text', 'export const port = 8080;\n', false]);
    const image = (await env.get('projects/web/files/preview?path=logo.png')).body;
    assert.deepEqual([image.kind, image.mime, image.data], ['image', 'image/png', Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')]);
    assert.equal((await env.get('projects/web/files/preview?path=blob.bin')).body.kind, 'binary');
    assert.equal(Buffer.from((await env.get('projects/web/files/raw?path=blob.bin')).body.data, 'base64').length, 4);

    // Nothing outside the project: .., absolute paths and symlinks that leave it.
    assert.equal((await env.get('projects/web/files/preview?path=' + encodeURIComponent('../secret.txt'))).status, 403);
    assert.equal((await env.get('projects/web/files?path=' + encodeURIComponent('..'))).status, 403);
    assert.equal((await env.get('projects/web/files/raw?path=leak.txt')).status, 403);
    assert.equal((await env.get('projects/web/files/preview?path=missing.txt')).status, 404);
    assert.equal((await env.get('projects/web/files?path=README.md')).status, 400);
  } finally {
    await env.close();
  }
});
