import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminals } from '../src/host/terminal';
import { idleTerminalSnapshot } from '../src/host/terminal-processes';
import { terminalIntegration } from '../src/host/terminal-integration';
import { exerciseTerminalRecycling } from './support/terminal-idle';

test('idle process checks reject active groups, background jobs, unknown snapshots, and other PTYs', () => {
  const shell = '100 1 100 100 ttys004 S+';
  assert.equal(idleTerminalSnapshot(shell, 100), true);
  assert.equal(idleTerminalSnapshot(`${shell}\n101 100 101 100 ttys004 S`, 100), false);
  assert.equal(idleTerminalSnapshot(`${shell}\n101 100 101 100 ttys004 T`, 100), false);
  assert.equal(idleTerminalSnapshot(`${shell}\n101 1 101 101 ttys005 S`, 100), true);
  assert.equal(idleTerminalSnapshot(shell.replace('100 100 ttys', '100 101 ttys'), 100), false);
  assert.equal(idleTerminalSnapshot(shell.replace('S+', 'R+'), 100), false);
  assert.equal(idleTerminalSnapshot('unexpected ps response', 100), false);
  assert.equal(idleTerminalSnapshot(`${shell}\n101 100 101 -1 ?? S`, 100), false, 'detached background children are still jobs');
  assert.equal(idleTerminalSnapshot(`${shell}\n101 100 101 100 ttys004`, 100), false, 'partial snapshots are not proof of idle');
});

test('terminal markers are token scoped, stripped from output, and handle arbitrary chunk boundaries', async () => {
  const integration = await terminalIntegration('/bin/bash', {});
  try {
    const token = integration.env.PROMPT_COMMAND!.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/)![0];
    const marker = `\x1b]133;Pideck;${token};prompt\x07`;
    const parts = [...marker].map(character => integration.parse(character));
    assert.equal(parts.map(part => part.text).join(''), '');
    assert.equal(parts.at(-1)?.prompt, true);
    const busy = integration.parse(`before\x1b]133;Pideck;${token};active\x07after`);
    assert.deepEqual(busy, { text: 'beforeafter', prompt: false });
    const foreign = '\x1b]133;Pideck;foreign;prompt\x07';
    assert.equal(integration.parse(foreign).text, foreign);
    assert.equal(integration.parse('ordinary output').prompt, undefined);
  } finally { await integration.dispose(); }
});

test('native PTY recycling is silent and preserves foreground/background work, builtins, input, and profiles', {
  skip: process.platform === 'win32', timeout: 20_000,
}, async t => {
  try { await access('/bin/zsh'); } catch { t.skip('Native zsh is unavailable; unknown shells are conservatively retained.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'pideck-idle-'));
  try { assert.equal((await exerciseTerminalRecycling(Terminals, directory)).length, 8); }
  finally { await rm(directory, { recursive: true, force: true }); }
});


test('native bash recycling preserves DEBUG/prompt sequencing and never kills a builtin read', {
  skip: process.platform === 'win32', timeout: 20_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pideck-bash-idle-'));
  try { assert.equal((await exerciseTerminalRecycling(Terminals, directory, '/bin/bash')).length, 8); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
