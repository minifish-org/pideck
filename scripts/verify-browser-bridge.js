async page => {
  await page.addInitScript(() => {
    const listeners = new Set();
    const watches = new Map();
    const activity = new Map();
    const queuedTexts = new Map();
    const reviewWatches = new Map();
    const terminalInputs = new Map();
    let activityWatch;
    let nextTaskId = 0;
    let nextQueueId = 2;
    let nextFixtureEntryId = 100;
    const messageTime = Date.parse("2026-11-07T05:04:00Z");
    const project = { id: "74de4c42-3a46-4430-873c-9bcb42fdb287", name: "Sample project", directory: "/workspace/sample", createdAt: 1 };
    const secondProject = { id: "5746b747-730d-45df-94c5-717355475784", name: "Other project", directory: "/workspace/other", createdAt: 2 };
    const secondSession = { id: "0c1bd9dc-58bd-4918-92ee-bc30609f0dbd", projectId: secondProject.id, title: "Other task", createdAt: 2, updatedAt: 2 };
    const model = { provider: "openai", id: "fixture", name: "Fixture model", configured: false, thinking: ["off", "low", "high"], supportsImages: true, contextWindow: 128000 };
    const fixedModel = { ...model, id: "fixture-fixed", name: "Fixture fixed model with a long display name to exercise truncation", thinking: ["off"] };
    const unavailableModel = { ...model, provider: "anthropic", id: "unavailable-fixture", name: "Unconnected fixture model" };
    const patch = "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const status = 'old';\n+export const status = 'verified';\n";
    const wrappedGuide = [
      "# Pideck Final Review", "",
      "This small project exercises reading, editing, verification and file review.", "",
      "Change the result in example.ts from before to after, then verify it.", "",
      ...["Project layout", "Reading the source", "Making a small change", "Reviewing changes", "Running verification",
        "Working in the terminal", "Checking unchanged context"].flatMap((title, index) => [
          `## ${title}`, "",
          "- Keep the exported result on line 1 easy to inspect.",
          "- Preserve the stable context at the end of example.ts.",
          "- Check the file contents before running a command.",
          "- Use the Changes panel to inspect the edit.",
          "- Read this guide without modifying it.", "",
          `Review checkpoint ${index + 1}: the guide is an unchanged project file.`, "",
        ]),
      "## Completing the task", "", "- Keep the exported result on line 1 easy to inspect.", "End of project guide.",
    ].join("\n") + "\n";
    const largePatch = [
      "diff --git a/second.ts b/second.ts", "--- a/second.ts", "+++ b/second.ts", "@@ -1,180 +1,180 @@",
      ...Array.from({ length: 180 }, (_, index) => `-const old${index} = ${index};`),
      ...Array.from({ length: 180 }, (_, index) => `+const next${index} = ${index};`), "",
    ].join("\n");
    const state = JSON.parse(sessionStorage.getItem("pideck-browser-fixture") || "null")
      ?? { opened: false, configured: false, sessions: [], views: {}, parents: {} };
    state.untitled ??= {};
    state.queueHolds ??= {};
    state.appearance ??= "dark";
    const systemAppearance = matchMedia("(prefers-color-scheme: dark)");
    let savedConnectionsPending = Boolean(state.savedConnectionsPending);
    let unlockCancelled = false;
    let auth;
    let offline = false;
    const attemptedRemovals = new Set();
    const resetting = new Set();
    let captureSessionList = false;
    let releaseSessionList;
    if (state.projectId) project.id = state.projectId;
    model.configured = state.configured;
    for (const view of Object.values(state.views)) {
      for (const item of view.queued ?? []) {
        nextQueueId = Math.max(nextQueueId, item.id);
        queuedTexts.set(item.id, item.preview);
      }
      for (const message of view.messages) nextFixtureEntryId = Math.max(nextFixtureEntryId, message.entryId ?? 0);
    }

    const emit = (event) => {
      for (const listener of listeners) listener(event);
    };
    const persist = () => sessionStorage.setItem("pideck-browser-fixture", JSON.stringify(state));
    const appearance = () => ({ preference: state.appearance,
      resolved: state.appearance === "system" ? systemAppearance.matches ? "dark" : "light" : state.appearance });
    const publishAppearance = () => emit({ type: "appearance:changed", appearance: appearance() });
    window.addEventListener("pideck-fixture-appearance", event => {
      if (!["system", "light", "dark"].includes(event.detail)) throw new Error("Invalid fixture appearance.");
      state.appearance = event.detail;
      persist();
      publishAppearance();
    });
    systemAppearance.addEventListener("change", () => { if (state.appearance === "system") publishAppearance(); });
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
        activity.set(sessionId, { ...activity.get(sessionId), state: "finished", settled: true, resultEntryId: values.messages?.at(-1)?.entryId });
        publishActivity();
      }
    }

    function drainIdleQueue(sessionId) {
      const view = state.views[sessionId];
      if (view.status !== "idle") return;
      const queued = view.queued ?? [];
      const hold = state.queueHolds[sessionId];
      const stop = hold ? queued.findIndex(item => item.id === hold.id) : queued.length;
      if (hold && stop < 0) throw new Error("An edit hold lost its queued input.");
      if (!stop) return;
      const ready = queued.slice(0, stop);
      const placed = ready.map(item => ({
        id: `queued-${item.id}`, entryId: ++nextFixtureEntryId, requestId: item.requestId,
        role: "user", timestamp: messageTime + nextFixtureEntryId * 100,
        blocks: [{ type: "text", text: queuedTexts.get(item.id) ?? item.preview }],
      }));
      for (const item of ready) queuedTexts.delete(item.id);
      change(sessionId, { messages: [...view.messages, ...placed, {
        id: `queued-answer-${nextFixtureEntryId}`, entryId: ++nextFixtureEntryId, role: "assistant",
        timestamp: messageTime + nextFixtureEntryId * 100, blocks: [{ type: "text", text: "Queued work finished." }],
      }], queued: queued.slice(stop), canSteerQueued: false });
    }

    function finishSecondaryRun(sessionId) {
      change(sessionId, { messages: [...state.views[sessionId].messages, {
        id: `secondary-answer-${nextFixtureEntryId}`, entryId: ++nextFixtureEntryId, role: "assistant",
        timestamp: messageTime + nextFixtureEntryId * 100, blocks: [{ type: "text", text: "Secondary work completed." }],
      }], status: "idle", canSteerQueued: false });
      drainIdleQueue(sessionId);
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
        for (const item of state.views[id]?.queued ?? []) queuedTexts.delete(item.id);
        delete state.views[id];
        delete state.queueHolds[id];
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
        if (command === "clipboard:write") {
          document.body.dataset.copiedText = payload.text;
          return;
        }
        if (offline && (command === "project:list" || command === "session:list")) throw new Error("Fixture workspace unavailable.");
        switch (command) {
          case "appearance:get": return appearance();
          case "project:list": return [...(state.opened ? [project] : []), ...(state.secondOpened ? [secondProject] : [])];
          case "project:open":
            if (state.opened) {
              state.secondOpened = true;
              persist();
              return { ...secondProject };
            }
            if (!state.opened) project.id = state.projectId = crypto.randomUUID();
            state.opened = true;
            persist();
            return { ...project };
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
            if (payload.projectId === secondProject.id && state.secondOpened) {
              state.secondOpened = false;
              persist();
              return { sessionIds: [secondSession.id] };
            }
            if (payload.projectId !== project.id || !state.opened) throw new Error("Fixture project not found.");
            if (!attemptedRemovals.has(project.id)) {
              attemptedRemovals.add(project.id);
              return null;
            }
            state.opened = false;
            delete state.projectId;
            deleteSessions(state.sessions.map(({ id }) => id));
            return loseRemovalReply();
          }
          case "session:list": {
            if (payload.projectId === secondProject.id) return state.secondOpened ? [{ ...secondSession }] : [];
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
          case "model:list": {
            if (savedConnectionsPending && payload?.useSaved) {
              if (!unlockCancelled) {
                unlockCancelled = true;
                throw new Error("The fixture unlock was cancelled.");
              }
              savedConnectionsPending = state.savedConnectionsPending = false;
              persist();
            }
            document.body.dataset.savedModelCatalog = savedConnectionsPending ? "pending" : "available";
            const configured = state.configured && !savedConnectionsPending;
            return { models: [{ ...model, configured }, { ...fixedModel, configured }, unavailableModel], savedConnectionsPending };
          }
          case "model:providers": return [{
            id: model.provider, name: "Fixture provider", configured: state.configured,
            credential: state.configured ? state.credential ?? "oauth" : undefined,
            dynamic: true, methods: [{ type: "api_key", name: "Fixture provider API key" }, { type: "oauth", name: "Fixture provider (ChatGPT subscription)" }],
          }, {
            id: "other", name: "Another provider", configured: Boolean(state.otherConfigured),
            credential: state.otherConfigured ? "api_key" : undefined, dynamic: false,
            methods: [{ type: "api_key", name: "Another provider API key" }],
          }];
          case "model:login":
            return new Promise((resolve, reject) => {
              const { flowId, method, provider } = payload;
              const promptId = crypto.randomUUID();
              auth = { flowId, promptId, method, provider, resolve, reject, open: false, copy: false };
              if (method === "oauth") {
                emit({ type: "auth:notice", flowId, notice: {
                  type: "auth_url", instructions: "Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
                  link: { id: "auth-url", label: "Browser sign-in", domain: "auth.fixture.invalid" },
                } });
                emit({ type: "auth:notice", flowId, notice: {
                  type: "device_code", code: "PIDE-CK99", copyId: "device", link: { id: "sign-in", label: "Provider sign-in", domain: "fixture.invalid" },
                } });
              }
              emit({ type: "auth:prompt", flowId, promptId, prompt: method === "oauth"
                ? { type: "manual_code", message: "Complete login in your browser, or paste the final redirect URL here:" }
                : { type: "secret", message: "API key" } });
            });
          case "model:auth-open":
            if (auth?.flowId !== payload.flowId || !["sign-in", "auth-url"].includes(payload.linkId)) throw new Error("Unexpected sign-in link.");
            if (payload.linkId === "sign-in") auth.open = true;
            return;
          case "model:auth-copy":
            if (auth?.flowId !== payload.flowId || payload.copyId !== "device") throw new Error("Unexpected verification code.");
            auth.copy = true;
            return;
          case "model:auth-answer":
            if (auth?.flowId !== payload.flowId || auth.promptId !== payload.promptId
              || (auth.method === "oauth" ? payload.value !== "test-authorization" || !auth.open || !auth.copy
                : payload.value !== "test-api-key")) throw new Error("Unexpected authorization response.");
            emit({ type: "auth:prompt-closed", flowId: auth.flowId, promptId: auth.promptId });
            if (auth.provider === model.provider) {
              model.configured = state.configured = true;
              state.credential = auth.method;
              state.savedConnectionsPending = true;
            } else state.otherConfigured = true;
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
          case "model:logout":
            if (payload.provider === model.provider) throw new Error("The primary fixture connection must remain configured for the coding flow.");
            state.otherConfigured = false;
            persist();
            return;
          case "model:refresh": return;
          case "chat:watch": {
            const watch = { payload, sequence: 0 };
            watches.set(payload.subscriptionId, watch);
            if (resetting.delete(payload.sessionId)) document.body.dataset.survivingWatch = "attached";
            queueMicrotask(() => update(watch, { view: payload.sessionId === secondSession.id
              ? { messages: [], status: "idle" } : state.views[payload.sessionId] }));
            return;
          }
          case "chat:unwatch": watches.delete(payload.subscriptionId); return;
          case "chat:earlier": {
            const view = state.views[payload.sessionId];
            const old = { id: "old-turn", entryId: 1, role: "user", timestamp: messageTime - 60_000, blocks: [{ type: "text", text: "An earlier coding request." }] };
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
            const prompt = { id: "prompt", entryId: 2, requestId: payload.requestId, role: "user", timestamp: messageTime, blocks: [
              { type: "text", text: payload.text }, ...(payload.images ?? []).map(image => ({ type: "image", ...image })),
            ] };
            const first = payload.text === "Update and verify the status.";
            if (first) state.mainSessionId = session.id;
            const selectedModel = payload.model.id === fixedModel.id ? fixedModel : model;
            if (first && payload.thinking !== "high") throw new Error("Expected the selected thinking level.");
            const messages = first ? [prompt, { id: "reply", role: "assistant", timestamp: messageTime + 500, blocks: [
              { type: "tool", name: "bash", id: "bash", status: "running", output: "Running the status check…", arguments: { command: "npm test" } },
            ] }] : [prompt];
            change(session.id, { messages, status: "running", canSteerQueued: first, model: selectedModel, thinking: payload.thinking });
            if (first) {
              window.addEventListener("pideck-fixture-write-result", () => {
                const [user, reply] = state.views[session.id].messages;
                const output = Array.from({ length: 8 }, (_, index) => `Verified step ${index + 1}.`).join("\n");
                change(session.id, { messages: [user, { ...reply, blocks: [
                  { ...reply.blocks[0], status: "done", output },
                  { type: "text", text: "Writing the result." },
                ] }] });
              }, { once: true });
              watches.clear();
              emit({ type: "host:disconnected", message: "The fixture workspace disconnected." });
              setTimeout(() => emit({ type: "host:restart" }), 100);
              throw new Error("The fixture lost the first message acknowledgement.");
            }
            window.addEventListener("pideck-fixture-finish-second-run", () => finishSecondaryRun(session.id), { once: true });
            await new Promise(resolve => window.addEventListener("pideck-fixture-finish-start", resolve, { once: true }));
            return { ...session };
          }
          case "chat:send": {
            const selectedModel = payload.model.id === fixedModel.id ? fixedModel : model;
            if (!state.configured || !payload.requestId || payload.thinking !== (selectedModel.id === fixedModel.id ? "off" : "high")) {
              throw new Error("Expected a configured model and selected thinking.");
            }
            const { sessionId } = payload;
            const view = state.views[sessionId];
            if (payload.delivery === "send") {
              if (state.untitled[sessionId]) {
                state.sessions.find(({ id }) => id === sessionId).title = payload.text.split("\n")[0].trim();
                delete state.untitled[sessionId];
              }
              const prompt = { id: `prompt-${payload.requestId}`, entryId: ++nextFixtureEntryId, requestId: payload.requestId, role: "user", timestamp: messageTime, blocks: [
                { type: "text", text: payload.text }, ...(payload.images ?? []).map(image => ({ type: "image", ...image })),
              ] };
              // The host accepted the input but its IPC reply was lost. The next
              // watch supplies the Durable request ID and clears the matching draft.
              watches.clear();
              change(sessionId, { messages: [...view.messages, prompt], status: "running", canSteerQueued: true, model: selectedModel, thinking: payload.thinking });
              if (sessionId !== state.mainSessionId) window.addEventListener("pideck-fixture-finish-second-run", () => finishSecondaryRun(sessionId), { once: true });
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
          case "chat:queue-edit-start": {
            const view = state.views[payload.sessionId];
            const item = view?.queued?.find(item => item.id === payload.id);
            if (!item || payload.projectId !== project.id) throw new Error("The message is no longer queued.");
            const hold = state.queueHolds[payload.sessionId];
            if (hold && hold.id !== payload.id) throw new Error("Finish the current queue edit first.");
            const token = hold?.token ?? payload.token;
            state.queueHolds[payload.sessionId] = { id: payload.id, token };
            change(payload.sessionId, { queued: view.queued.map(item => ({ ...item, editing: item.id === payload.id || undefined })) });
            return { token, text: queuedTexts.get(item.id) ?? item.preview, hasImages: false };
          }
          case "chat:queue-edit-finish": {
            const view = state.views[payload.sessionId];
            const hold = state.queueHolds[payload.sessionId];
            if (payload.projectId !== project.id || !hold || hold.id !== payload.id || hold.token !== payload.token) {
              throw new Error("The queue edit is no longer active.");
            }
            if (payload.text !== undefined) {
              if (!payload.text.trim()) throw new Error("Enter a message.");
              queuedTexts.set(payload.id, payload.text);
            }
            delete state.queueHolds[payload.sessionId];
            change(payload.sessionId, { queued: view.queued.map(item => item.id === payload.id
              ? { ...item, preview: payload.text ?? item.preview, editing: undefined } : item) });
            drainIdleQueue(payload.sessionId);
            return;
          }
          case "chat:queue-update": {
            const { sessionId, action } = payload;
            const view = state.views[sessionId];
            const queued = [...(view?.queued ?? [])];
            const index = queued.findIndex(({ id }) => id === payload.id);
            if (index < 0 || payload.projectId !== project.id) throw new Error("The message is no longer queued.");
            if (state.queueHolds[sessionId]) throw new Error("Finish the current queue edit first.");
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
              window.addEventListener("pideck-fixture-finish-queue", () => {
                const reply = { id: "reply", entryId: 8, role: "assistant", timestamp: messageTime + 95_000, durationMs: 95_000, blocks: [
                  { type: "text", text: "I updated the status and checked the result.\n\n[Review source](example.ts#L1) · [Project source](/workspace/sample/example.ts#L1) · [Project guide](README.md) · [Unchanged line](example.ts#L30) · [Node docs](https://nodejs.org/api/assert.html) · [Unsafe link](javascript:alert%281%29) · [Outside file](/workspace/elsewhere/private.txt)" },
                  { type: "tool", name: "edit", id: "edit", path: "example.ts", status: "done", patch },
                  { type: "tool", name: "edit", id: "large-edit", path: "second.ts", status: "done", patch: largePatch },
                  { type: "tool", name: "bash", id: "bash", status: "done", output: "Checks passed.", arguments: { command: "npm test" } },
                  { type: "tool", name: "bash", id: "failed-bash", status: "error", output: "Lint reported an error.", arguments: { command: "npm run lint" } },
                ] };
                for (const { id } of queued) queuedTexts.delete(id);
                change(sessionId, { messages: [state.views[sessionId].messages[0], reply], status: "idle", canSteerQueued: false, queued: [], hasEarlier: true });
              }, { once: true });
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
          case "terminal:open": {
            const terminalId = crypto.randomUUID();
            terminalInputs.set(terminalId, "");
            document.body.dataset.terminalId = terminalId;
            return { terminalId, data: "Fixture shell\r\n", sequence: 0, exited: false };
          }
          case "terminal:input": {
            const { projectId, terminalId, data } = payload;
            const input = (terminalInputs.get(terminalId) ?? "") + data;
            terminalInputs.set(terminalId, input.includes("\r") ? "" : input);
            const exit = /^exit(?: (\d+))?\r$/.exec(input);
            if (exit) emit({ type: "terminal:exit", projectId, terminalId, sequence: 1, exitCode: Number(exit[1] ?? 0) });
            return;
          }
          case "terminal:close": {
            terminalInputs.delete(payload.terminalId);
            document.body.dataset.closedTerminalId = payload.terminalId;
            return;
          }
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
            if (payload.path === "README.md") return { patch: null, reason: "This file has no current Git changes." };
            const filePatch = payload.path === "second.ts" ? patch.replaceAll("example.ts", "second.ts") : patch;
            return { patch: sessionStorage.getItem("pideck-review-edit") ? filePatch.replace("verified", "updated") : filePatch };
          }
          case "review:resolve-link":
            if (payload.projectId !== project.id || !["example.ts#L1", "/workspace/sample/example.ts#L1", "README.md", "example.ts#L30"].includes(payload.href)) {
              throw new Error("Unexpected project message link.");
            }
            if (payload.href === "README.md") return { path: "README.md" };
            if (payload.href === "example.ts#L30") return { path: "example.ts", line: 30 };
            return { path: "example.ts", line: 1 };
          case "review:file":
            if (payload.projectId !== project.id || !["README.md", "example.ts"].includes(payload.path)) throw new Error("Unexpected file preview.");
            return { path: payload.path, contents: payload.path === "README.md"
              ? sessionStorage.getItem("pideck-review-wrapped-guide") ? wrappedGuide
                : ["# Project guide", "", "Read-only project documentation.",
                    ...Array.from({ length: 77 }, (_, index) => `Project guide line ${index + 4}.`)].join("\n") + "\n"
              : ["export const status = 'verified';", ...Array.from({length: 79}, (_, index) => `export const line${index + 2} = ${index + 2};`)].join("\n") + "\n" };
          case "review:file-cancel": return;
          case "link:open-external":
            if (payload.url !== "https://nodejs.org/api/assert.html") throw new Error("Unexpected external message link.");
            document.body.dataset.openedExternalLink = payload.url;
            return;
          default: throw new Error("Unexpected fixture command " + command);
        }
      },
    };
    window.addEventListener("pideck-fixture-review-change", () => {
      for (const watch of reviewWatches.values()) emit({ type: "review:changed", ...watch });
    });
  });
}
