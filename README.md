# Pideck

Pideck is an experimental desktop coding workspace. Each project opens in a local folder with its own Pi Durable conversations, Git review panel, and interactive terminal.

## Run locally

Use Node.js 22.19 or later.

```sh
npm ci
npm run dev
```

Open a project folder, confirm that you trust it, and create a session. Open **Settings** to save an OpenAI or Anthropic API key. Select a model and, where supported, its thinking level. Use **Changes** to inspect working tree diffs and **Terminal** to run an interactive shell in the selected project.

Projects and conversation history live in the app’s data directory. Provider keys are encrypted with the operating system’s credential store. On Linux, saving keys requires an available system secret store. Trusted projects let Pideck run commands with your user account’s permissions. Only trust folders whose contents you trust.

| Action | Shortcut |
| --- | --- |
| Open folder | ⌘/Ctrl+O |
| New session | ⌘/Ctrl+N |
| Open settings | ⌘/Ctrl+, |
| Toggle navigation | ⌘/Ctrl+Shift+B |
| Toggle review | ⌘/Ctrl+Shift+D |
| Toggle terminal | ⌘/Ctrl+` |
| Focus prompt | ⌘/Ctrl+L |

## Verify and package

```sh
npm run typecheck
npm test
npm run verify:frontend
npm run package
npm run smoke:packaged
```

Install a test browser with `npx playwright-cli install-browser chromium` if needed.

The frontend check starts Vite from Durable’s `bash` tool, drives an isolated Playwright CLI session, and reads the resulting screenshot through Durable’s image input. It uses a deterministic test model and browser fixture. The packaged smoke test opens the real desktop app with temporary data and exercises its project, review, terminal, and host recovery paths. The unpacked desktop bundle is written to `release/`.

The conversation view follows Durable’s recent-entry window. Durable retains the full transcript in SQLite, including entries outside the visible window.
