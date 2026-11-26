import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment } from './helpers.mjs';
import { attachments } from '../dist/worker-kit.js';

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

test('an attachment is the request body, written to disk as it arrives, up to 500 MB', async () => {
  const env = await environment({ accounts: 'NAME=codex-a TYPE=codex\n', projects: project => `NAME=web ACCOUNT=codex-a PATH=${project}\n` });
  try {
    // Larger than the 20 MB the JSON form allows.
    const data = Buffer.alloc(24 * 1024 * 1024, 7);
    const saved = await env.upload('web', '录屏 1.MOV', data);
    assert.equal(saved.status, 200);
    assert.match(saved.body.path, /^\/workspace\/\.coderfleet-uploads\/[a-f0-9]{16}-录屏_1\.mov$/);
    assert.deepEqual([saved.body.name, saved.body.size], ['录屏 1.MOV', data.length]);
    const directory = join(env.project, '.coderfleet-uploads');
    assert.ok(readFileSync(join(directory, saved.body.path.split('/').pop())).equals(data));

    const large = await env.upload('web', 'big.bin', Buffer.alloc(0), 500 * 1024 * 1024 + 1);
    assert.deepEqual([large.status, large.body.error], [413, '附件不能超过 500 MB']);
    assert.equal((await env.upload('web', 'empty.bin', Buffer.alloc(0))).status, 400);
    assert.equal((await env.post('projects/web/uploads', { name: 'old.txt', data: Buffer.from('old client').toString('base64') })).status, 200);
    // An image or PDF too large to go inside a message is passed by its path, like any other file.
    writeFileSync(join(directory, 'scan.pdf'), Buffer.alloc(20 * 1024 * 1024 + 1));
    writeFileSync(join(directory, 'small.pdf'), '%PDF-1.4');
    assert.deepEqual(attachments(env.project, ['/workspace/.coderfleet-uploads/scan.pdf', '/workspace/.coderfleet-uploads/small.pdf']).map(file => file.kind), ['file', 'pdf']);
    // Nothing is left of the refused ones.
    assert.deepEqual(readdirSync(directory).map(name => name.replace(/^[a-f0-9]{16}-/, '')).sort(), ['old.txt', 'scan.pdf', 'small.pdf', '录屏_1.mov']);
  } finally { await env.close(); }
});
