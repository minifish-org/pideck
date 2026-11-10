import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxRuntime, toolResponse, waitForView } from "../test/support/faux-runtime";

const name = `pideck-${randomUUID().slice(0, 12)}`;
const output = "output/playwright";
const screenshot = `${output}/${name}.png`;
const workspaceScreens = ["welcome", "first-draft", "providers", "provider-sign-in", "providers-connected", "model-menu", "model-thinking", "running", "queue", "queue-narrow", "background", "tool-logs", "conversation",
  "image-attachment", "image-preview", "workspace", "right-sidebar", "wide", "narrow", "sidebar", "terminal", "branches", "project-tree",
  "light-providers", "light-model-menu", "light-workspace", "light-terminal",
  "providers-change", "light-providers-change", "providers-key", "light-providers-key", "light-provider-sign-in", "linked-file", "queue-edit", "light-queue-edit",
  "file-preview", "light-file-preview"]
  .map(stage => `${output}/pideck-ui-${stage}.png`);
workspaceScreens.push(...["tools-dark", "tools-light", "mixed-dark", "mixed-light", "finished-dark", "finished-light", "user-dark", "user-light"]
  .map(stage => `${output}/pideck-footer-${stage}.png`));
workspaceScreens.push(...["running", "cancelled", "failed", "completed"].flatMap(stage => ["dark", "light"]
  .map(theme => `${output}/pideck-run-controls-${stage}-${theme}.png`)));
workspaceScreens.push(...['tree', 'connection', 'draft', 'queue', 'terminal', 'recovery'].map(stage => `${output}/pideck-reliability-${stage}.png`));
workspaceScreens.push(...['preview', 'dark', 'light', 'narrow'].map(stage => `${output}/pideck-attachments-${stage}.png`));
workspaceScreens.push(...['search-dark', 'search-light', 'project-menu-dark', 'project-menu-light', 'session-menu-dark', 'session-menu-light', 'search-narrow'].map(stage => `${output}/pideck-navigation-${stage}.png`));
workspaceScreens.push(...['dark', 'light', 'narrow-dark', 'narrow-light', 'result'].map(stage => `${output}/pideck-message-edit-${stage}.png`));
const log = `${output}/${name}.log`;
const flowLog = `${output}/${name}-flow.log`;
const snapshotLog = `${output}/${name}-snapshot.log`;
const data = await mkdtemp(join(tmpdir(), "pideck-frontend-"));
const fixture = fauxRuntime(data);
const targetOS = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform;
const runtime = await fixture.open(undefined, undefined, {
  resourcesDirectory: resolve("release", "automation-assets", `${targetOS}-${process.arch}`),
  stateDirectory: join(data, "automation"),
  launcherPath: resolve("dist", "automation", "cli.cjs"),
});

try {
  await mkdir(output, { recursive: true });
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Could not allocate a local verification port."));
      });
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const cli = `playwright-cli -s=${name}`;
  const command = [
    "set -eu",
    `./node_modules/.bin/vite --host 127.0.0.1 --port ${port} --strictPort > ${log} 2>&1 &`,
    "server=$!",
    `echo "$server" > ${log}.pid`,
    `trap '${cli} close >/dev/null 2>&1 || true; kill "$server" 2>/dev/null || true' EXIT`,
    'for (( i=0; i<100; i++ )); do',
    `  curl -fsS ${url} >/dev/null 2>&1 && break`,
    '  kill -0 "$server" 2>/dev/null || { cat ' + log + '; exit 1; }',
    '  sleep 0.1',
    'done',
    `curl -fsS ${url} >/dev/null`,
    `${cli} open about:blank`,
    `${cli} run-code --filename scripts/verify-browser-bridge.js`,
    `${cli} goto ${url}`,
    `${cli} snapshot > ${snapshotLog} 2>&1`,
    `${cli} run-code --filename scripts/verify-browser-flow.js > ${flowLog} 2>&1 || { tail -n 60 ${flowLog}; ${cli} snapshot > ${snapshotLog} 2>&1; ${cli} console error; exit 1; }`,
    `tail -n 60 ${flowLog}`,
    `${cli} run-code --filename scripts/verify-browser-reliability.js >> ${flowLog} 2>&1 || { tail -n 60 ${flowLog}; exit 1; }`,
    `grep -m1 'Reliability flow passed:' ${flowLog}`,
    `${cli} run-code --filename scripts/verify-browser-attachments.js >> ${flowLog} 2>&1 || { tail -n 60 ${flowLog}; exit 1; }`,
    `grep -m1 'Attachment flow passed:' ${flowLog}`,
    `${cli} run-code --filename scripts/verify-browser-navigation.js >> ${flowLog} 2>&1 || { tail -n 60 ${flowLog}; exit 1; }`,
    `grep -m1 'Navigation flow passed:' ${flowLog}`,
    `${cli} run-code --filename scripts/verify-browser-message-edit.js >> ${flowLog} 2>&1 || { tail -n 60 ${flowLog}; exit 1; }`,
    `grep -m1 'Message edit flow passed:' ${flowLog}`,
    `${cli} snapshot > ${snapshotLog} 2>&1`,
    `${cli} screenshot --filename ${screenshot}`,
    `${cli} console error`,
  ].join("\n");
  const project = runtime.addProject(process.cwd());
  const session = await runtime.createSession(project.id, "Verify frontend");
  const selection = { projectId: project.id, sessionId: session.id };
  const finishedText = "Browser verification finished.";
  fixture.faux.setResponses([
    toolResponse("bash", { command, timeout: 180 }),
    ...workspaceScreens.map(path => toolResponse("read", { path: resolve(path) })),
    fauxAssistantMessage(finishedText),
  ]);
  const finished = waitForView(runtime, selection, view => view.status === "idle" && view.messages.some(
    message => message.blocks.some(block => block.type === "text" && block.text === finishedText),
  ), 195_000);
  await runtime.send(fixture.input(selection, "Start the dev server and verify the renderer with an isolated browser."));
  const result = await finished;
  const blocks = result.messages.flatMap(message => message.blocks);
  const shell = blocks.find(block => block.type === "tool" && block.name === "bash");
  const images = blocks.filter(block => block.type === "tool" && block.name === "read");
  assert.ok(shell?.type === "tool" && shell.status === "done" && shell.output?.includes("Renderer flow passed.") && shell.output?.includes("Reliability flow passed:") && shell.output?.includes("Attachment flow passed:") && shell.output?.includes("Navigation flow passed:") && shell.output?.includes("Message edit flow passed:"), shell?.type === "tool" ? shell.output : "Bash did not run.");
  assert.ok(images.length === workspaceScreens.length && images.every(image =>
    image.type === "tool" && image.status === "done" && image.images?.length === 1), "Durable did not return the screenshots as image input.");
  console.log(`Durable Bash and Playwright verified the renderer. Screenshots: ${workspaceScreens.join(", ")}`);
} finally {
  await runtime.close();
  await rm(data, { recursive: true, force: true });
}
