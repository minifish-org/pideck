# Pideck

Pideck is an experimental desktop coding agent for backend and frontend work. Build it with Electron, React, and TypeScript. Make the coding workflow reliable from inspecting a project to editing, reviewing, and verifying changes.

> Keep the core minimal. Let every component reach its full potential.

## Product principles

- **Minimal Core.** Own only the desktop experience and the glue it needs. Add capabilities when they directly improve coding. Keep integrations thin and avoid generic wrappers that duplicate or flatten upstream APIs.
- **Native Capabilities.** Preserve the semantics of the components we choose. Keep room for native capabilities such as conversation forks and model-specific controls even when their UI is deferred.
- **Refined Experience.** Make common actions obvious and reveal advanced controls on demand. Prioritize responsive streaming, readable diffs, reliable terminal input, and keyboard navigation.

## Runtime and process boundaries

- Use upstream `@earendil-works/pi-durable` for the agent loop, conversation state, task recovery, cancellation, and compaction. Use `@earendil-works/pi-ai` for model access, streaming, and supported thinking controls. Keep these upstream semantics intact. Use Durable's built-in `CodingTools` with `read`, `write`, `edit`, and `bash`. [Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- Electron main owns windows, validates IPC, and manages trusted host lifecycles. Run Durable, SQLite, filesystem operations, shell execution, and `node-pty` in the trusted host, outside the renderer. Keep blocking work off the main event loop.
- Preload exposes narrow, typed commands and subscriptions through `contextBridge`. The React renderer renders views and sends user intents. Give it no Node.js, direct filesystem or process access, or raw IPC. Validate sender, payload, and project or session ownership for each privileged operation.

## Projects and sessions

- A project is a user-selected local directory and the default working directory for tools and terminals. Persist project metadata and its mapping to stable Durable conversation IDs in SQLite under the app's data directory. Use Durable's SQLite storage for agent state and keep a single host owner per store. Reopen existing conversations and recover interrupted work through Durable. Keep app metadata separate from Durable's schema.
- Drive chat from Durable's conversation watch. Attach with an initial view, apply ordered updates, and resync after a gap or host reconnect. Dispose of subscriptions on session switch or window close. React state is a view of Durable state. Avoid polling, parallel transcript stores, and independent tool retries.

## Workspace

- Keep chat central and project and session navigation collapsible. Expand small changes inline and open larger reviews in an on-demand side panel. Use `@pierre/diffs` with Shiki for syntax highlighting, unified and split views, and inline change emphasis. Keep file navigation available in the review panel. [Pierre Diffs](https://diffs.com/)
- Put the user's interactive terminal in a collapsible bottom panel. Pair xterm.js with `node-pty` for ANSI output, keyboard input, and resize. Show the agent's `bash` output in chat tool cards.
- Treat browser preview as optional. If embedded, give it an isolated browser session with permissions denied by default and no privileged bridge. Keep preview and Playwright browser sessions independent by default.

## Frontend verification

Run Playwright CLI through Durable's existing `bash` tool from the active project. Start the project's dev server, open its URL with `playwright-cli`, exercise the changed flow, and verify the result with snapshots, screenshots, or console output as appropriate. Use an isolated browser session and close it when done. Pass screenshots through supported image input when visual analysis is needed. [Playwright CLI](https://github.com/microsoft/playwright-cli)

## Security and quality

- Enable Electron sandboxing and context isolation, disable Node integration, and enforce a restrictive content security policy. Treat model output, repo content, and preview pages as untrusted. Keep provider secrets in the trusted host and out of tool and terminal environments and logs. Require project trust before running code. A working directory alone does not confine shell commands. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- Pin compatible versions of Durable and pi-ai exactly and commit the lockfile. Treat Durable's API as experimental. Check the pinned release's docs and verify recovery against existing SQLite data before upgrading.
- Land small changes through the normal app flow. Run type checks and relevant tests. Cover host-boundary validation, restart and watch reconnection, and cancellation where affected. Smoke-test native PTY behavior in packaged Electron when changing the terminal.

## Non-goals

Stay focused on coding. General assistant features, a full IDE, Skills, custom Extensions, MCP, RAG, long-term memory, multi-agent orchestration, and vendor-specific agent or browser-control APIs are outside the default scope.
