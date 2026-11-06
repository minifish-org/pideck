async page => {
  await page.addInitScript(() => {
    const listeners = new Set();
    const watches = new Map();
    const activity = new Map();
    let activityWatch;
    let nextTaskId = 0;
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

    function addSession(title, view = { messages: [], status: "idle" }) {
      const session = { id: crypto.randomUUID(), projectId: project.id, title: title ?? "Untitled session",
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
              change(sessionId, { messages: [...view.messages, prompt], status: "running", model, thinking: payload.thinking });
              emit({ type: "host:disconnected", message: "The fixture workspace disconnected." });
              setTimeout(() => emit({ type: "host:restart" }), 100);
              throw new Error("The fixture lost the send acknowledgement.");
            }
            const queued = [...(view.queued ?? []), { id: (view.queued?.length ?? 0) + 3, requestId: payload.requestId, delivery: payload.delivery, preview: payload.text }];
            change(sessionId, { queued });
            if (queued.length === 2) {
              if (queued[0].delivery !== "steer" || queued[1].delivery !== "follow-up") throw new Error("Unexpected queue delivery.");
              setTimeout(() => {
                const reply = { id: "reply", entryId: 8, role: "assistant", blocks: [
                  { type: "text", text: "I updated the status and checked the result." },
                  { type: "tool", name: "edit", id: "edit", path: "example.ts", status: "done", patch },
                  { type: "tool", name: "bash", id: "bash", status: "done", output: "Checks passed.", arguments: { command: "npm test" } },
                ] };
                change(sessionId, { messages: [...state.views[sessionId].messages, reply], status: "idle", queued: [], hasEarlier: true });
              }, 700);
            }
            return;
          }
          case "chat:compact":
            if (payload.instructions !== "Keep the testing details.") throw new Error("Expected compaction instructions.");
            return "compacted";
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
          case "review:list": return [
            { path: "example.ts", status: " M", added: 1, removed: 1 },
            ...(sessionStorage.getItem("pideck-extra-review-file") ? [{ path: "second.ts", status: " M", added: 1, removed: 1 }] : []),
          ];
          case "review:patch": return { patch: payload.path === "second.ts" ? patch.replaceAll("example.ts", "second.ts") : patch };
          default: throw new Error("Unexpected fixture command " + command);
        }
      },
    };
  });
}
