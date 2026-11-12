import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Terminals } from '../../src/host/terminal';
import type { TerminalEvent } from '../../src/shared/api';

export async function exerciseTerminalRecycling(TerminalsClass: typeof Terminals, directory: string, shell = '/bin/zsh') {
  const profile = "export PIDECK_PROFILE_SURVIVED=yes\nPS1='$ '\n";
  await Promise.all(['.zshrc', '.bash_profile', '.bashrc'].map(file => writeFile(join(directory, file), profile)));
  let clock = 0;
  const output = new Map<string, string>();
  const events: TerminalEvent[] = [];
  const terminals = new TerminalsClass((_owner, event) => {
    if (event.type !== 'terminal:data' && event.type !== 'terminal:exit' && event.type !== 'terminal:reclaimed') return;
    events.push(event);
    if (event.type === 'terminal:data') output.set(event.terminalId, (output.get(event.terminalId) ?? '') + event.data);
  }, { idleAfterMs: 1000, now: () => clock });
  function open(projectId: string) {
    const previous = { SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR, HOME: process.env.HOME };
    process.env.SHELL = shell;
    process.env.ZDOTDIR = directory;
    if (shell.endsWith("/bash")) process.env.HOME = directory;
    try { return terminals.open(1, projectId, directory, 100, 24); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  async function prompt(id: string) {
    try { await until(() => (output.get(id) ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').endsWith('$ ')); }
    catch (error) { throw new Error(`${String(error)} Output: ${JSON.stringify(output.get(id))}`); }
    await delay(40);
  }
  function hide(project: string, id: string) {
    terminals.visibility(1, project, id, false);
    clock += 2000;
  }
  try {
    const first = await open('idle');
    await prompt(first.terminalId);
    assert.equal(await terminals.hasWorkToInterrupt(), false, 'an open shell at an idle prompt does not interrupt work');
    terminals.input(1, 'idle', first.terminalId, "printf '\\nPROFILE_%s:%s\\n' \"$PIDECK_PROFILE_SURVIVED\" \"$ZDOTDIR\"\r");
    await until(() => (output.get(first.terminalId) ?? '').includes(`PROFILE_yes:${directory}`));
    await prompt(first.terminalId);
    hide('idle', first.terminalId);
    assert.equal(await terminals.hasWorkToInterrupt(), false, 'a hidden idle shell does not interrupt work');
    assert.equal(await terminals.reclaimIdle(), 1, 'a hidden idle shell expires');
    assert.equal(events.at(-1)?.type, 'terminal:reclaimed', 'recycling is not represented as a failed shell');
    const replacement = await open('idle');
    assert.notEqual(replacement.terminalId, first.terminalId);
    assert.equal(replacement.data, '', 'a new shell starts without a recovery notice');
    await prompt(replacement.terminalId);
    const id = replacement.terminalId;
    terminals.input(1, 'idle', id, 'sleep 30\r');
    await delay(80);
    hide('idle', id);
    assert.equal(await terminals.hasWorkToInterrupt(), true, 'a foreground job requires restart confirmation');
    assert.equal(await terminals.reclaimIdle(), 0, 'silent foreground work survives');
    terminals.input(1, 'idle', id, '\x03');
    await until(() => (output.get(id) ?? '').includes('^C'));
    await prompt(id);
    terminals.input(1, 'idle', id, 'read -r answer\r');
    await delay(80);
    clock += 2000;
    assert.equal(await terminals.reclaimIdle(), 0, 'a shell builtin waiting for input is not an idle prompt');
    terminals.input(1, 'idle', id, '\x03');
    await delay(80);
    await prompt(id);
    terminals.input(1, 'idle', id, 'echo unfinished');
    await delay(50);
    clock += 2000;
    assert.equal(await terminals.hasWorkToInterrupt(), true, 'unfinished terminal input requires restart confirmation');
    assert.equal(await terminals.reclaimIdle(), 0, 'an unfinished input line is not discarded');
    terminals.input(1, 'idle', id, '\x03');
    await delay(80);
    await prompt(id);
    terminals.input(1, 'idle', id, 'sleep 30 &\r');
    await delay(100);
    await prompt(id);
    clock += 2000;
    assert.equal(await terminals.hasWorkToInterrupt(), true, 'a background job requires restart confirmation even at the prompt');
    assert.equal(await terminals.reclaimIdle(), 0, 'background jobs keep a prompt-idle shell alive');
    terminals.input(1, 'idle', id, 'kill $!\r');
    await delay(100);
    await prompt(id);
    clock += 2000;
    assert.equal(await terminals.hasWorkToInterrupt(), false, 'the restart warning clears after background work ends');
    assert.equal(await terminals.reclaimIdle(), 1, 'the shell becomes reclaimable only after its jobs finish');

    const shells: { project: string; terminalId: string }[] = [];
    for (const project of ['one', 'two', 'three', 'four']) {
      const opened = await open(project);
      shells.push({ project, ...opened });
      await prompt(opened.terminalId);
    }
    terminals.visibility(1, 'one', shells[0].terminalId, false);
    const fifth = await open('five');
    assert.equal(terminals.liveCount(), 4, 'capacity pressure reclaims one safe shell rather than exceeding the limit');
    assert.ok(events.some(event => event.type === 'terminal:reclaimed' && event.terminalId === shells[0].terminalId));
    assert.ok(!events.some(event => event.type === 'terminal:reclaimed' && shells.slice(1).some(shell => shell.terminalId === event.terminalId)), 'visible shells are never reclaimed');
    await prompt(fifth.terminalId);
    return ['idle expiry', 'silent foreground task', 'shell builtin read', 'unfinished input', 'background task', 'silent reopening', 'safe capacity reclamation', 'user startup profiles preserved'];
  } finally { await terminals.closeAll(); }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for native terminal prompt.');
    await delay(20);
  }
}
