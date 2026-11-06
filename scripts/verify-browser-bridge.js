async page => {
  await page.addInitScript(() => {
    const listeners = new Set();
    const watches = new Map();
    const project = { id: crypto.randomUUID(), name: "Sample project", directory: "/workspace/sample", trusted: false, createdAt: 1 };
    const session = { id: crypto.randomUUID(), projectId: project.id, title: "New session", createdAt: 1, updatedAt: 1 };
    const model = { provider: "openai", id: "fixture", name: "Fixture model", configured: true, thinking: ["off", "low"], supportsImages: true };
    const patch = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const status = 'old';\n+export const status = 'verified';\n";
    let opened = false;
    let created = false;
    let view = { messages: [], status: "idle" };

    function update(watch) {
      const event = { type: "chat:update", ...watch.payload, sequence: ++watch.sequence, view };
      for (const listener of listeners) listener(event);
    }
    window.pideck = {
      platform: "darwin",
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async invoke(command, payload) {
        switch (command) {
          case "project:list": return opened ? [project] : [];
          case "project:open": opened = true; return project;
          case "project:trust": project.trusted = true; return { ...project };
          case "session:list": return created ? [session] : [];
          case "session:create": created = true; return session;
          case "model:list": return [model];
          case "chat:watch": {
            const watch = { payload, sequence: 0 };
            watches.set(payload.subscriptionId, watch);
            queueMicrotask(() => update(watch));
            return;
          }
          case "chat:unwatch": watches.delete(payload.subscriptionId); return;
          case "chat:send":
            view = {
              status: "idle", model, thinking: payload.thinking,
              messages: [
                { id: "prompt", role: "user", blocks: [{ type: "text", text: payload.text }] },
                { id: "reply", role: "assistant", blocks: [
                  { type: "text", text: "I updated the status and checked the result." },
                  { type: "tool", name: "edit", id: "edit", path: "example.ts", status: "done", patch },
                  { type: "tool", name: "bash", id: "bash", status: "done", output: "Checks passed.", arguments: { command: "npm test" } },
                ] },
              ],
            };
            setTimeout(() => { for (const watch of watches.values()) update(watch); }, 50);
            return;
          case "review:list": return [{ path: "example.ts", status: " M" }];
          case "review:patch": return { patch };
          default: throw new Error("Unexpected fixture command " + command);
        }
      },
    };
  });
}
