import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureTerminalSession, terminalSessionGroups } from "../src/host/terminal-processes";

test("Linux terminal cleanup only selects its verified session's live job groups and rechecks identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-proc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function process(pid: number, session: number, group = pid, startTime = "123", state = "S") {
    await mkdir(join(directory, String(pid)), { recursive: true });
    const fields = Array<string>(20).fill("0");
    fields[0] = state;
    fields[1] = "1";
    fields[2] = String(group);
    fields[3] = String(session);
    fields[19] = startTime;
    await writeFile(join(directory, String(pid), "stat"), `${pid} (command (with) spaces) ${fields.join(" ")}\n`);
  }
  await Promise.all([
    process(100, 100), process(101, 100, 100), process(102, 100), process(103, 100, 102),
    process(104, 999), process(105, 100, 105, "321", "Z"), process(106, 999, 106, "222"),
  ]);
  assert.equal(await captureTerminalSession(1, directory), undefined);
  assert.equal(await captureTerminalSession(101, directory), undefined, "a member is not authority over its session");
  const session = await captureTerminalSession(100, directory);
  assert.deepEqual(session, { id: 100, startTime: "123" });
  assert.deepEqual(await terminalSessionGroups(session!, directory), [102, 100]);

  await process(107, 100);
  assert.deepEqual(await terminalSessionGroups(session!, directory), [102, 107, 100], "force pass discovers newly created job groups");
  await unlink(join(directory, "100", "stat"));
  assert.deepEqual(await terminalSessionGroups(session!, directory), [102, 107, 100], "jobs remain owned after their shell exits");

  await process(100, 100, 100, "999");
  assert.deepEqual(await terminalSessionGroups(session!, directory), [], "reused session-leader PID cannot authorize signals");
  await process(100, 999, 100, "123");
  assert.deepEqual(await terminalSessionGroups(session!, directory), [], "an unrelated session cannot authorize signals");
});
