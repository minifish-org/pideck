import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { ChatView, QueueEditRef, Selection, Session } from '../src/shared/api';
import { fauxRuntime, toolResponse, waitForView } from './support/faux-runtime';

type LegacyFixture = {
  source: { version: string };
  expected: {
    selection: Selection; branch: Session; edit: QueueEditRef; interrupted: Selection; requestId: string; view: ChatView;
  };
  stores: Record<string, { tables: { name: string; sql: string; rows: Record<string, SQLInputValue>[] }[] }>;
};

// JSON-valued SQLite columns need a second encoding pass when a Windows path
// replaces the portable placeholder. Never generate this fixture with the new
// library: its persisted documents and tasks were written by Pi 1.5.0.
function relocate(value: unknown, directory: string): unknown {
  if (Array.isArray(value)) return value.map(item => relocate(item, directory));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, directory)]));
  if (typeof value !== 'string' || !value.includes('__PIDECK_PROJECT__')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return JSON.stringify(relocate(parsed, directory));
  } catch { /* A plain path or tool-output string, not a JSON column. */ }
  return value.replaceAll('__PIDECK_PROJECT__', directory);
}

const textIn = (view: ChatView, text: string) => view.messages.some(message =>
  message.blocks.some(block => block.type === 'text' && block.text === text));

test('Pi 1.5.0 SQLite stores preserve history, forks and held edits, recover an interrupted request, and remain cancellable', { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pideck-dependency-upgrade-')));
  const directory = join(root, 'project');
  const data = join(root, 'app');
  await Promise.all([mkdir(directory), mkdir(data)]);
  const legacy = relocate(JSON.parse(await readFile(new URL('./fixtures/pi-1.5.0.json', import.meta.url), 'utf8')), directory) as LegacyFixture;
  assert.equal(legacy.source.version, '1.5.0');
  const { selection, branch, edit, interrupted, requestId, view: previous } = legacy.expected;
  const engine = fauxRuntime(data);
  let recoveries = 0;
  engine.faux.setResponses([() => { recoveries++; return fauxAssistantMessage('Recovered after upgrading Pi.'); }]);
  let runtime: Awaited<ReturnType<typeof engine.open>> | undefined;
  try {
    for (const [name, store] of Object.entries(legacy.stores)) {
      using db = new DatabaseSync(join(data, name));
      db.exec('BEGIN; PRAGMA defer_foreign_keys = ON');
      for (const table of store.tables) db.exec(table.sql);
      for (const table of store.tables) for (const row of table.rows) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO "${table.name}" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...Object.values(row));
      }
      if (name === 'workspace.sqlite') {
        const info = await stat(directory, { bigint: true });
        db.prepare('UPDATE projects SET device = ?, inode = ?').run(info.dev.toString(), info.ino.toString());
      }
      db.exec('COMMIT');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    }
    await writeFile(join(directory, 'legacy.txt'), 'Written by Pi 1.5.0.\n');
    runtime = await engine.open('after-dependency-upgrade');
    const restored = await waitForView(runtime, selection, () => true);
    assert.deepEqual(restored.messages, previous.messages);
    assert.deepEqual(restored.model, previous.model);
    assert.deepEqual(restored.queued, previous.queued);
    const sessions = await runtime.listSessions(selection.projectId);
    assert.equal(sessions.length, 3);
    assert.equal(sessions.find(session => session.id === branch.id)?.parentSessionId, selection.sessionId);
    assert.equal(sessions.find(session => session.id === branch.id)?.forkEntryId, branch.forkEntryId);
    assert.ok(textIn(await waitForView(runtime, { ...selection, sessionId: branch.id }, () => true), 'Legacy result is preserved.'));

    const recovered = await waitForView(runtime, interrupted, view => view.status === 'idle' && textIn(view, 'Recovered after upgrading Pi.'));
    assert.equal(recoveries, 1, 'One native recovery attempt, not a second host-side retry.');
    assert.equal(recovered.messages.filter(message => message.requestId === requestId).length, 1);
    assert.deepEqual(await runtime.startQueueEdit(edit, 22), { token: edit.token, text: 'Original queued text.', images: [] });
    engine.faux.setResponses([fauxAssistantMessage('Edited input completed after upgrading.')]);
    await runtime.finishQueueEdit({ ...edit, text: 'Saved after upgrading.' }, 22);
    const edited = await waitForView(runtime, selection, view => view.status === 'idle' && textIn(view, 'Edited input completed after upgrading.'));
    assert.equal(edited.queued, undefined);
    assert.ok(textIn(edited, 'Saved after upgrading.'));
    assert.ok(!textIn(edited, 'Original queued text.'));

    // Detach and reattach a native conversation watch, then run and cancel a
    // real built-in Bash task against the upgraded persisted conversation.
    const watcher = await runtime.watch(selection, () => {});
    watcher.dispose();
    engine.faux.setResponses([toolResponse('bash', { command: 'echo upgrade-cancellable; sleep 20; touch should-not-exist' })]);
    const running = waitForView(runtime, selection, view => view.messages.some(message => message.blocks.some(block =>
      block.type === 'tool' && block.status === 'running' && block.output?.includes('upgrade-cancellable'))));
    await runtime.send(engine.input(selection, 'Verify cancellation after upgrading.'));
    await running;
    await runtime.cancel(selection);
    await waitForView(runtime, selection, view => view.status === 'idle' && view.canContinue === true);
    await assert.rejects(readFile(join(directory, 'should-not-exist')), { code: 'ENOENT' });
    await runtime.close();
    runtime = await engine.open('after-upgrade-reopen');
    const reopened = await waitForView(runtime, selection, view => view.canContinue === true);
    assert.ok(textIn(reopened, 'Edited input completed after upgrading.'));
    assert.equal(reopened.canContinue, true);
    assert.equal(recoveries, 1);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
