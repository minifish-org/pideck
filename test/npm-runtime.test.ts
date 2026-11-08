import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { npmVersion, prepareNpmRuntime } = await import(new URL('../scripts/npm-runtime.mjs', import.meta.url).href) as {
  npmVersion: string;
  prepareNpmRuntime(nodeDirectory: string, cacheDirectory: string): Promise<unknown>;
};

test('a tampered cached npm archive is rejected before extraction or runtime replacement', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pideck-npm-integrity-'));
  const cache = join(temporary, 'cache');
  const node = join(temporary, 'node');
  try {
    await Promise.all([mkdir(cache), mkdir(node)]);
    await writeFile(join(cache, `npm-${npmVersion}.tgz`), 'not the official npm archive');
    await assert.rejects(prepareNpmRuntime(node, cache), /does not match the pinned upstream integrity/);
    assert.deepEqual(await readdir(node), []);
    assert.deepEqual(await readdir(cache), [`npm-${npmVersion}.tgz`]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
