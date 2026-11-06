async page => {
  await page.addInitScript(() => {
    const listeners = new Set();
    const watches = new Map();
    const activity = new Map();
    const queuedTexts = new Map();
    const reviewWatches = new Map();
    let activityWatch;
    let nextTaskId = 0;
    let nextQueueId = 2;
    const project = { id: "74de4c42-3a46-4430-873c-9bcb42fdb287", name: "Sample project", directory: "/workspace/sample", trusted: false, createdAt: 1 };
    const model = { provider: "openai", id: "fixture", name: "Fixture model", configured: false, thinking: ["off", "low", "high"], supportsImages: true };
    const patch = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const status = 'old';\n+export const status = 'verified';\n";
    const state = JSON.parse(sessionStorage.getItem("pideck-browser-fixture") || "null")
      ?? { opened: false, trusted: false, configured: false, sessions: [], views: {}, parents: {} };
    state.untitled ??= {};
    let auth;
    let offline = false;
    const attemptedRemovals = new Set();
    const resetting = new Set();
    let captureSessionList = false;
    let releaseSessionList;
    if (state.projectId) project.id = state.projectId;
    project.trusted = state.trusted;
    model.configured = state.configured;

    const emit = (event) => {
      for (const listener of listeners) listener(event);
    };
    const persist = () => sessionStorage.setItem("pideck-browser-fixture", JSON.stringify(state));
    const update = (watch, payload) => emit({ type: "chat:update", ...watch.payload, sequence: ++watch.sequence, ...payload });
    const publishActivity = () => {
      if (activityWatch) emit({ type: "session:activity", subscriptionId: activityWatch, items: [...activity.values()] });
    };

    function change(sessionId, values) {
      const previous = state.views[sessionId];
      const ops = Object.entries(values).map(([key, value]) => ["s", [key], value]);
      state.views[sessionId] = { ...previous, ...values };
      persist();
      for (const watch of watches.values()) {
        if (watch.payload.sessionId === sessionId) update(watch, { ops });
      }
      if (values.status === "running" && previous.status !== "running") {
        activity.set(sessionId, { projectId: project.id, sessionId, taskId: ++nextTaskId, state: "running", settled: false });
        publishActivity();
      } else if (values.status === "idle" && activity.has(sessionId)) {
        activity.set(sessionId, { ...activity.get(sessionId), state: "finished", settled: true });
        publishActivity();
      }
    }

    function addSession(title, view = { messages: [], status: "idle" }, id = crypto.randomUUID()) {
      const session = { id, projectId: project.id, title: title ?? "Untitled session",
        createdAt: Date.now(), updatedAt: Date.now() };
      if (title === undefined) state.untitled[session.id] = true;
      state.sessions.unshift(session);
      state.views[session.id] = view;
      persist();
      return session;
    }

    function deleteSessions(sessionIds) {
      state.sessions = state.sessions.filter(({ id }) => !sessionIds.includes(id));
      for (const id of sessionIds) {
        delete state.views[id];
        delete state.parents[id];
        delete state.untitled[id];
        activity.delete(id);
      }
      publishActivity();
      const survivors = new Set();
      for (const [key, { payload }] of watches) {
        watches.delete(key);
        if (!sessionIds.includes(payload.sessionId)) survivors.add(payload.sessionId);
      }
      for (const sessionId of survivors) {
        resetting.add(sessionId);
        emit({ type: "chat:reset", projectId: project.id, sessionId });
      }
      persist();
      return { sessionIds };
    }

    function loseRemovalReply() {
      offline = true;
      emit({ type: "host:disconnected", message: "The fixture workspace disconnected." });
      setTimeout(() => {
        offline = false;
        emit({ type: "host:restart" });
      }, 100);
      throw new Error("The fixture lost the removal acknowledgement.");
    }

    window.pideck = {
      platform: "darwin",
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async invoke(command, payload) {
        if (offline && (command === "project:list" || command === "session:list")) throw new Error("Fixture workspace unavailable.");
        switch (command) {
          case "project:list": return state.opened ? [project] : [];
          case "project:open":
            if (!state.opened) project.id = state.projectId = crypto.randomUUID();
            state.opened = true;
            persist();
            return { ...project };
          case "project:trust": project.trusted = state.trusted = true; persist(); return { ...project };
          case "session:watch-activity": {
            activityWatch = payload.subscriptionId;
            queueMicrotask(publishActivity);
            return;
          }
          case "session:unwatch-activity":
            if (activityWatch === payload.subscriptionId) activityWatch = undefined;
            return;
          case "session:read-activity":
            if (activity.get(payload.sessionId)?.taskId === payload.taskId) {
              activity.delete(payload.sessionId);
              publishActivity();
            }
            return;
          case "project:remove": {
            if (payload.projectId !== project.id || !state.opened) throw new Error("Fixture project not found.");
            if (!attemptedRemovals.has(project.id)) {
              attemptedRemovals.add(project.id);
              return null;
            }
            state.opened = state.trusted = project.trusted = false;
            delete state.projectId;
            deleteSessions(state.sessions.map(({ id }) => id));
            return loseRemovalReply();
          }
          case "session:list": {
            const snapshot = state.sessions.map(session => ({ ...session }));
            if (!captureSessionList) return snapshot;
            captureSessionList = false;
            document.body.dataset.staleSessionList = "started";
            return new Promise((resolve) => {
              releaseSessionList = () => {
                resolve(snapshot);
                document.body.dataset.staleSessionList = "released";
              };
            });
          }
          case "session:create": return addSession(payload.title);
          case "session:rename": {
            const session = state.sessions.find(({ id, projectId }) => id === payload.sessionId && projectId === payload.projectId);
            if (!session) throw new Error("Fixture session not found.");
            session.title = payload.title;
            delete state.untitled[session.id];
            persist();
            return { ...session };
          }
          case "session:remove": {
            if (!state.sessions.some(({ id }) => id === payload.sessionId)) throw new Error("Fixture session not found.");
            const branches = state.sessions.filter(({ id }) => state.parents[id] === payload.sessionId);
            if (branches.length) return { blockingBranches: branches.map(({ id, title }) => ({ id, title })) };
            if (!attemptedRemovals.has(payload.sessionId)) {
              attemptedRemovals.add(payload.sessionId);
              captureSessionList = true;
              emit({ type: "host:restart" });
              return null;
            }
            const loseReply = state.sessions.some(({ id, title }) => id === payload.sessionId && title === "Verify status");
            const result = deleteSessions([payload.sessionId]);
            const release = releaseSessionList;
            releaseSessionList = undefined;
            setTimeout(() => release?.(), 50);
            return loseReply ? loseRemovalReply() : result;
          }
          case "model:list": return [{ ...model }];
          case "model:providers": return [{
            id: model.provider, name: "Fixture provider", configured: state.configured, credential: state.configured ? "oauth" : undefined,
            dynamic: true, methods: [{ type: "api_key", name: "API key" }, { type: "oauth", name: "Sign in with browser" }],
          }, {
            id: "other", name: "Another provider", configured: false, dynamic: false,
            methods: [{ type: "api_key", name: "API key" }],
          }];
          case "model:login":
            return new Promise((resolve, reject) => {
              const { flowId, method } = payload;
              const promptId = crypto.randomUUID();
              auth = { flowId, promptId, resolve, reject, open: false, copy: false };
              if (method === "oauth") {
                emit({ type: "auth:notice", flowId, notice: {
                  type: "device_code", code: "PIDE-CK99", copyId: "device", link: { id: "sign-in", label: "Provider sign-in", domain: "fixture.invalid" },
                } });
              }
              emit({ type: "auth:prompt", flowId, promptId, prompt: method === "oauth"
                ? { type: "manual_code", message: "Authorization code" }
                : { type: "secret", message: "API key" } });
            });
          case "model:auth-open":
            if (auth?.flowId !== payload.flowId || payload.linkId !== "sign-in") throw new Error("Unexpected sign-in link.");
            auth.open = true;
            return;
          case "model:auth-copy":
            if (auth?.flowId !== payload.flowId || payload.copyId !== "device") throw new Error("Unexpected verification code.");
            auth.copy = true;
            return;
          case "model:auth-answer":
            if (auth?.flowId !== payload.flowId || auth.promptId !== payload.promptId
              || payload.value !== "test-authorization" || !auth.open || !auth.copy) throw new Error("Unexpected authorization response.");
            emit({ type: "auth:prompt-closed", flowId: auth.flowId, promptId: auth.promptId });
            model.configured = state.configured = true;
            persist();
            auth.resolve();
            auth = undefined;
            return;
          case "model:auth-cancel":
            if (auth?.flowId === payload.flowId) {
              auth.reject(new Error("Sign-in cancelled."));
              auth = undefined;
            }
            return;
          case "model:refresh": return;
          case "chat:watch": {
            const watch = { payload, sequence: 0 };
            watches.set(payload.subscriptionId, watch);
            if (resetting.delete(payload.sessionId)) document.body.dataset.survivingWatch = "attached";
            queueMicrotask(() => update(watch, { view: state.views[payload.sessionId] }));
            return;
          }
          case "chat:unwatch": watches.delete(payload.subscriptionId); return;
          case "chat:earlier": {
            const view = state.views[payload.sessionId];
            const old = { id: "old-turn", entryId: 1, role: "user", blocks: [{ type: "text", text: "An earlier coding request." }] };
            change(payload.sessionId, { messages: [old, ...view.messages], hasEarlier: false });
            return;
          }
          case "chat:start": {
            if (!state.configured || !payload.requestId || payload.projectId !== project.id) {
              throw new Error("Expected a configured model, project, and first message request ID.");
            }
            const existing = state.sessions.find(({ id }) => id === payload.requestId);
            if (existing) return { ...existing };
            const session = addSession(payload.text.split("\n")[0].trim(), undefined, payload.requestId);
            const prompt = { id: "prompt", entryId: 2, requestId: payload.requestId, role: "user", blocks: [{ type: "text", text: payload.text }] };
            const first = payload.text === "Update and verify the status.";
            if (first && payload.thinking !== "high") throw new Error("Expected the selected thinking level.");
            const messages = first ? [prompt, { id: "reply", role: "assistant", blocks: [
              { type: "tool", name: "bash", id: "bash", status: "running", output: "Running the status check…", arguments: { command: "npm test" } },
            ] }] : [prompt];
            change(session.id, { messages, status: first ? "running" : "idle", canSteerQueued: first, model, thinking: payload.thinking });
            if (first) {
              watches.clear();
              emit({ type: "host:disconnected", message: "The fixture workspace disconnected." });
              setTimeout(() => emit({ type: "host:restart" }), 100);
              throw new Error("The fixture lost the first message acknowledgement.");
            }
            await new Promise(resolve => window.addEventListener("pideck-fixture-finish-start", resolve, { once: true }));
            return { ...session };
          }
          case "chat:send": {
            if (!state.configured || !payload.requestId || payload.thinking !== "high") throw new Error("Expected a configured model and selected thinking.");
            const { sessionId } = payload;
            const view = state.views[sessionId];
            if (payload.delivery === "send") {
              if (state.untitled[sessionId]) {
                state.sessions.find(({ id }) => id === sessionId).title = payload.text.split("\n")[0].trim();
                delete state.untitled[sessionId];
              }
              const prompt = { id: "prompt", entryId: 2, requestId: payload.requestId, role: "user", blocks: [{ type: "text", text: payload.text }] };
              // The host accepted the input but its IPC reply was lost. The next
              // watch supplies the Durable request ID and clears the matching draft.
              watches.clear();
              change(sessionId, { messages: [...view.messages, prompt], status: "running", canSteerQueued: true, model, thinking: payload.thinking });
              emit({ type: "host:disconnected", message: "The fixture workspace disconnected." });
              setTimeout(() => emit({ type: "host:restart" }), 100);
              throw new Error("The fixture lost the send acknowledgement.");
            }
            if (payload.delivery !== "follow-up") throw new Error("The composer must queue follow-up messages.");
            const id = ++nextQueueId;
            queuedTexts.set(id, payload.text);
            const queued = [...(view.queued ?? []), { id, requestId: payload.requestId, delivery: "follow-up", preview: payload.text }];
            change(sessionId, { queued, canSteerQueued: true });
            return;
          }
          case "chat:queue-read": {
            const item = state.views[payload.sessionId]?.queued?.find(({ id }) => id === payload.id);
            if (!item || payload.projectId !== project.id) throw new Error("The message is no longer queued.");
            return { text: queuedTexts.get(item.id), hasImages: false };
          }
          case "chat:queue-update": {
            const { sessionId, action } = payload;
            const view = state.views[sessionId];
            const queued = [...(view?.queued ?? [])];
            const index = queued.findIndex(({ id }) => id === payload.id);
            if (index < 0 || payload.projectId !== project.id) throw new Error("The message is no longer queued.");
            const [item] = queued.splice(index, 1);
            switch (action) {
              case "remove":
                queuedTexts.delete(item.id);
                break;
              case "edit":
                queuedTexts.set(item.id, payload.text);
                queued.splice(index, 0, { ...item, preview: payload.text });
                break;
              case "move": {
                const target = queued.findIndex(({ id }) => id === payload.targetId);
                if (target < 0 || queued[target].delivery !== item.delivery) throw new Error("Invalid queue target.");
                queued.splice(target + (payload.position === "after" ? 1 : 0), 0, item);
                break;
              }
              case "steer": {
                const firstFollowUp = queued.findIndex(({ delivery }) => delivery === "follow-up");
                queued.splice(firstFollowUp < 0 ? queued.length : firstFollowUp, 0, { ...item, delivery: "steer" });
                break;
              }
              default: throw new Error("Unexpected queue action " + action);
            }
            change(sessionId, { queued });
            if (action === "steer") {
              const result = queued.map(({ delivery, id }) => [delivery, queuedTexts.get(id)]);
              if (JSON.stringify(result) !== JSON.stringify([
                ["steer", "Prefer a focused check."],
                ["follow-up", "List follow-up work."],
                ["follow-up", "Report the final verification."],
              ])) throw new Error("Queue operations did not leave the expected order and content.");
              setTimeout(() => {
                const reply = { id: "reply", entryId: 8, role: "assistant", blocks: [
                  { type: "text", text: "I updated the status and checked the result." },
                  { type: "tool", name: "edit", id: "edit", path: "example.ts", status: "done", patch },
                  { type: "tool", name: "bash", id: "bash", status: "done", output: "Checks passed.", arguments: { command: "npm test" } },
                  { type: "tool", name: "bash", id: "failed-bash", status: "error", output: "Lint reported an error.", arguments: { command: "npm run lint" } },
                ] };
                for (const { id } of queued) queuedTexts.delete(id);
                change(sessionId, { messages: [state.views[sessionId].messages[0], reply], status: "idle", canSteerQueued: false, queued: [], hasEarlier: true });
              }, 700);
            }
            return;
          }
          case "chat:fork": {
            const view = state.views[payload.sessionId];
            const index = view.messages.findIndex((message) => message.entryId === payload.entryId);
            if (index === -1) throw new Error("Fork checkpoint not found.");
            const title = state.sessions.find(({ id }) => id === payload.sessionId).title;
            const fork = addSession(payload.title ?? title + " (fork)", { ...view, messages: view.messages.slice(0, index + 1) });
            state.parents[fork.id] = payload.sessionId;
            persist();
            return fork;
          }
          case "terminal:open": return { terminalId: crypto.randomUUID(), data: "Fixture shell\r\n", sequence: 0, exited: false };
          case "terminal:close":
          case "terminal:resize": return;
          case "terminal:sync": return [];
          case "review:watch": reviewWatches.set(payload.subscriptionId, payload); return;
          case "review:unwatch": reviewWatches.delete(payload.subscriptionId); return;
          case "review:list": {
            if (sessionStorage.getItem("pideck-review-list-failure")) throw new Error("Could not load changed files.");
            return [
              { path: "example.ts", status: " M", added: 1, removed: 1 },
              ...(sessionStorage.getItem("pideck-extra-review-file") ? [{ path: "second.ts", status: " M", added: 1, removed: 1 }] : []),
            ];
          }
          case "review:patch": {
            if (sessionStorage.getItem("pideck-review-patch-failure")) throw new Error("Could not load this diff.");
            const filePatch = payload.path === "second.ts" ? patch.replaceAll("example.ts", "second.ts") : patch;
            return { patch: sessionStorage.getItem("pideck-review-edit") ? filePatch.replace("verified", "updated") : filePatch };
          }
          default: throw new Error("Unexpected fixture command " + command);
        }
      },
    };
    window.addEventListener("pideck-fixture-review-change", () => {
      for (const watch of reviewWatches.values()) emit({ type: "review:changed", ...watch });
    });
  });
}
