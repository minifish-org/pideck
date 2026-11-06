import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

async function executable() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const entries = await readdir("release");
  if (process.platform === "darwin") {
    const directory = entries.find(name => name === "mac-" + process.arch) ?? "mac";
    return resolve("release", directory, "Pideck.app", "Contents", "MacOS", "Pideck");
  }
  if (process.platform === "win32") return resolve("release", "win-unpacked", "Pideck.exe");
  return resolve("release", "linux-unpacked", "pideck");
}

const path = await executable();
const temporary = await mkdtemp(join(tmpdir(), "pideck-packaged-"));
const data = join(temporary, "profile");
const project = join(temporary, "smoke-project");
let app;
const errors = [];

try {
  await mkdir(project);
  const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
  git("init");
  await writeFile(join(project, "example.ts"), "export const result = 'before';\n");
  git("add", "example.ts");
  git("-c", "user.email=test@example.invalid", "-c", "user.name=Pideck Smoke", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture");
  await writeFile(join(project, "example.ts"), "export const result = 'after';\n");

  const launch = async () => {
    const running = await _electron.launch({
      executablePath: path,
      args: [`--user-data-dir=${data}`],
      env: { ...process.env, PIDECK_SMOKE_PRIVATE: "secret-marker" },
    });
    const window = await running.firstWindow();
    window.on("pageerror", error => errors.push(error.message));
    window.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    await window.waitForFunction(() => Boolean(window.pideck));
    return { running, window };
  };
  const first = await launch();
  app = first.running;
  const page = first.window;

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, project);

  assert.equal(await page.evaluate(() => typeof globalThis.require), "undefined");
  assert.equal(await page.evaluate(() => typeof globalThis.process), "undefined");
  await assert.rejects(page.evaluate(() => window.pideck.invoke("project:add", { directory: "/" })), /Invalid workspace request/);

  const added = await page.evaluate(() => window.pideck.invoke("project:open"));
  assert.equal(added.name, "smoke-project");
  assert.equal(added.trusted, false);
  const projectId = added.id;
  const command = (name, payload) => page.evaluate(([name, payload]) => window.pideck.invoke(name, payload), [name, payload]);
  await assert.rejects(command("terminal:open", { projectId, cols: 80, rows: 20 }), /Trust this project/);
  await assert.rejects(command("review:list", { projectId }), /Trust this project/);
  assert.equal(await command("project:trust", { projectId }), null);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const trusted = await command("project:trust", { projectId });
  assert.equal(trusted.trusted, true);
  const conversation = await command("session:create", { projectId, title: "Smoke session" });
  await assert.rejects(command("chat:watch", { projectId, sessionId: crypto.randomUUID(), subscriptionId: crypto.randomUUID() }), /Session not found/);

  // Reload through the shipped app to show the project and session created above.
  await page.reload();
  await page.getByRole("button", { name: /smoke-project/ }).first().click();
  await page.getByRole("button", { name: "Smoke session" }).click();
  await page.getByRole("textbox", { name: "Message Pideck" }).waitFor();

  await page.getByRole("button", { name: /^(toggle )?(review|changes)$/i }).first().click();
  await page.getByRole("navigation", { name: "Changed files" }).getByRole("button", { name: /example.ts/ }).click();
  await page.getByRole("button", { name: "Split" }).click();
  await page.locator("diffs-container").filter({ hasText: "after" }).last().waitFor();

  await page.getByRole("button", { name: /^(toggle )?terminal$/i }).first().click();
  await page.getByText("Shell running").waitFor();
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.focus();
  const print = process.platform === "win32"
    ? 'if ($null -eq $env:PIDECK_SMOKE_PRIVATE) { Write-Host ("PTY_" + "OK") -ForegroundColor Green }'
    : 'test -z "$PIDECK_SMOKE_PRIVATE" && printf \'\\033[32mPTY_%s\\033[0m\\n\' OK';
  await page.keyboard.insertText(print);
  await page.keyboard.press("Enter");
  await page.locator(".xterm-rows").getByText("PTY_OK", { exact: true }).waitFor();
  if (process.platform !== "win32") {
    async function ptySize(filename) {
      await page.keyboard.insertText(`stty size > ${filename}`);
      await page.keyboard.press("Enter");
      const deadline = Date.now() + 4000;
      let dimensions = "";
      while (!dimensions && Date.now() < deadline) {
        dimensions = await readFile(join(project, filename), "utf8").catch(() => "");
        if (!dimensions) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.match(dimensions, /^[1-9]\d* [1-9]\d*\n$/);
      return dimensions;
    }
    const original = await ptySize(".pty-original");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 740));
    await page.waitForFunction(() => window.innerWidth <= 1000);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.notEqual(await ptySize(".pty-resized"), original);
  }

  await page.evaluate(() => {
    window.pideck.onEvent(event => {
      if (event.type === "host:restart") document.documentElement.dataset.hostRestarted = "true";
    });
  });
  await app.evaluate(({ app }) => {
    const host = app.getAppMetrics().find(metric => metric.name === "Pideck workspace");
    if (!host) throw new Error("Workspace process was not found.");
    process.kill(host.pid, "SIGKILL");
  });
  await page.waitForFunction(() => document.documentElement.dataset.hostRestarted === "true");
  await page.getByText("Shell running").waitFor();
  assert.equal((await command("session:list", { projectId }))[0].id, conversation.id);
  await app.close();
  app = undefined;

  const reopened = await launch();
  app = reopened.running;
  assert.equal((await reopened.window.evaluate(() => window.pideck.invoke("project:list")))[0].id, projectId);
  assert.equal((await reopened.window.evaluate(id => window.pideck.invoke("session:list", { projectId: id }), projectId))[0].id, conversation.id);
  assert.deepEqual(errors, []);
  console.log("Packaged Electron verified: sandboxed bridge, trust, Git review, PTY input and output, host restart, persisted session.");
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
