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
const log = `${output}/${name}.log`;
const data = await mkdtemp(join(tmpdir(), "pideck-frontend-"));
const fixture = fauxRuntime(data);
const runtime = await fixture.open();

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
  const cli = `./node_modules/.bin/playwright-cli -s=${name}`;
  const command = [
    "set -eu",
    `./node_modules/.bin/vite --host 127.0.0.1 --port ${port} --strictPort > ${log} 2>&1 &`,
    "server=$!",
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
    `${cli} snapshot`,
    `${cli} run-code --filename scripts/verify-browser-flow.js || { ${cli} snapshot; ${cli} console error; exit 1; }`,
    `${cli} snapshot`,
    `${cli} screenshot --filename ${screenshot}`,
    `${cli} console error`,
  ].join("\n");
  const project = runtime.addProject(process.cwd());
  runtime.trustProject(project.id);
  const session = await runtime.createSession(project.id, "Verify frontend");
  const selection = { projectId: project.id, sessionId: session.id };
  const finishedText = "Browser verification finished.";
  fixture.faux.setResponses([
    toolResponse("bash", { command, timeout: 120 }),
    toolResponse("read", { path: resolve(screenshot) }),
    fauxAssistantMessage(finishedText),
  ]);
  const finished = waitForView(runtime, selection, view => view.status === "idle" && view.messages.some(
    message => message.blocks.some(block => block.type === "text" && block.text === finishedText),
  ), 135_000);
  await runtime.send(fixture.input(selection, "Start the dev server and verify the renderer with an isolated browser."));
  const result = await finished;
  const blocks = result.messages.flatMap(message => message.blocks);
  const shell = blocks.find(block => block.type === "tool" && block.name === "bash");
  const image = blocks.find(block => block.type === "tool" && block.name === "read");
  assert.ok(shell?.type === "tool" && shell.status === "done" && shell.output?.includes("Renderer flow passed."), shell?.type === "tool" ? shell.output : "Bash did not run.");
  assert.ok(image?.type === "tool" && image.status === "done" && image.images?.length === 1, "Durable did not return the screenshot as image input.");
  console.log(`Durable Bash and Playwright verified the renderer. Screenshot: ${screenshot}`);
} finally {
  await runtime.close();
  await rm(data, { recursive: true, force: true });
}
