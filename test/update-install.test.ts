import assert from "node:assert/strict";
import { test } from "node:test";
import { UpdateInstallation } from "../src/main/update-install";

function fixture() {
  const events: string[] = [];
  const actions = {
    seal() { events.push("sealed"); },
    unseal() { events.push("unsealed"); },
    async confirm() { events.push("confirmed"); return true; },
    async flush() { events.push("flushed"); },
    async closeHost() { events.push("closed"); return { status: "graceful" } as const; },
    async recover() { events.push("recovered"); },
    install() { events.push("installed"); return true; },
    failed(_error: unknown) { events.push("failed"); },
  };
  return { events, actions };
}

test("update installation seals new requests and waits for durable shutdown before native installation", async () => {
  const { events, actions } = fixture();
  const closed = Promise.withResolvers<{ status: "graceful" }>();
  actions.closeHost = async () => { events.push("closing"); return closed.promise; };
  const updater = new UpdateInstallation(actions);
  const first = updater.request();
  assert.equal(updater.request(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["sealed", "confirmed", "flushed", "closing"]);
  closed.resolve({ status: "graceful" });
  await first;
  assert.deepEqual(events, ["sealed", "confirmed", "flushed", "closing", "installed"]);
  await updater.request();
  assert.equal(events.filter(event => event === "installed").length, 1);
});

test("declining an update restart keeps current work running and permits a later explicit attempt", async () => {
  const { events, actions } = fixture();
  let allowed = false;
  actions.confirm = async () => { events.push("confirmed"); return allowed; };
  const updater = new UpdateInstallation(actions);
  await updater.request();
  assert.deepEqual(events, ["sealed", "confirmed", "unsealed"]);
  allowed = true;
  await updater.request();
  assert.equal(events.at(-1), "installed");
});

test("flush or non-graceful host shutdown prevents installation and restores the current app", async () => {
  for (const failure of ["flush", "forced", "failed"] as const) {
    const { events, actions } = fixture();
    if (failure === "flush") actions.flush = async () => { throw new Error("Disk unavailable"); };
    const updater = new UpdateInstallation({ ...actions, closeHost: async () => {
      events.push("closed");
      return failure === "forced" ? { status: "forced", reason: "timeout", exited: true }
        : { status: "failed", reason: "cleanup-failed", message: "Disk unavailable" };
    } });
    await updater.request();
    assert.ok(!events.includes("installed"));
    assert.equal(events.includes("recovered"), failure !== "flush");
    assert.equal(events.at(-1), "unsealed");
  }
});

test("native failure restores a gracefully closed host without altering the installed application", async () => {
  const { events, actions } = fixture();
  const updater = new UpdateInstallation(actions);
  await updater.request();
  await updater.aborted();
  assert.deepEqual(events.slice(-2), ["recovered", "unsealed"]);
});

test("a native abort while confirmation is pending never closes the workspace or invokes installation", async () => {
  const { events, actions } = fixture();
  const answer = Promise.withResolvers<boolean>();
  actions.confirm = () => answer.promise;
  const updater = new UpdateInstallation(actions);
  const pending = updater.request();
  const aborted = updater.aborted();
  answer.resolve(true);
  await Promise.all([pending, aborted]);
  assert.deepEqual(events, ["sealed", "unsealed"]);
});
