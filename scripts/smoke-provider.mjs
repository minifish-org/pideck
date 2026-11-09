import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

// A local Azure Responses endpoint speaks the real pi-ai wire protocol. No
// application code, IPC, Durable tasks, or model adapter is replaced in the test.
export async function openSmokeProvider() {
  const requests = [];
  const failures = [];
  const gates = new Map();
  function gate(name) {
    let current = gates.get(name);
    if (!current) {
      const release = Promise.withResolvers();
      current = { entered: 0, waiters: new Set(), released: release.promise, release: release.resolve };
      gates.set(name, current);
    }
    return current;
  }
  let recoveryRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      if (!request.url.startsWith("/openai/v1/responses")
        || request.headers["api-key"] !== "pideck-smoke-key" || payload.stream !== true) {
        throw new Error("The Azure provider did not send an authenticated streaming Responses request.");
      }
      requests.push(payload);
      const tools = payload.input.filter(item => item.type === "function_call_output");
      const prompt = JSON.stringify(payload.input.findLast(item => item.role === "user")?.content);
      const gateName = /Queue hold (?:SAVE|CANCEL|RESTART|STOP|RELOAD|CLOSE|QUIT)/.exec(prompt ?? "")?.[0];
      const held = gateName ? gate(gateName) : undefined;
      const queueExercise = payload.input.some(item => item.role === "user" && JSON.stringify(item.content).includes("Queue hold "));
      const recovering = prompt?.includes("Recover the active request");
      const controlRun = prompt?.includes("Native tool cancellation") ? "tool"
        : prompt?.includes("Native continue check") ? "continue" : undefined;
      const controlOutputCount = payload.input.slice(payload.input.findLastIndex(item => item.role === "user") + 1)
        .filter(item => item.type === "function_call_output").length;
      const id = randomUUID().replaceAll("-", "");
      const responseId = "resp_" + id;
      const emit = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      emit({ type: "response.created", response: { id: responseId } });
      let item;
      if (controlRun && controlOutputCount < 2 || !controlRun && !recovering && !queueExercise && tools.length < 2) {
        const name = controlRun ? controlOutputCount === 0 ? "bash" : "write" : tools.length === 0 ? "edit" : "bash";
        const args = JSON.stringify(controlRun ? controlOutputCount === 0
          ? { command: `printf 'NATIVE_${controlRun === "tool" ? "TOOL" : "RUN"}_READY\\n'; sleep 30; printf 'CANCEL_WAS_MISSED\\n'` }
          : { path: controlRun === "tool" ? "tool-cancel-result.txt" : "continue-result.txt",
            content: controlRun === "tool" ? "Tool cancelled; remaining work completed.\n" : "Continued work completed.\n" }
          : name === "edit"
          ? { path: "example.ts", edits: [{ oldText: "'before'", newText: "'after'" }] }
          : { command: 'test -z "$AZURE_OPENAI_API_KEY" && cat example.ts' });
        item = { type: "function_call", id: "fc_" + id, call_id: "call_" + id, name, arguments: "", status: "in_progress" };
        emit({ type: "response.output_item.added", output_index: 0, item });
        emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: args });
        item = { ...item, arguments: args, status: "completed" };
      } else {
        const firstRecoveryAttempt = recovering && ++recoveryRequests === 1;
        const text = controlRun === "tool" ? "The long command was cancelled; the rest of the work completed."
          : controlRun === "continue" ? "Continued the cancelled run and verified the result."
          : held ? `${gateName}: current run finished.`
          : recovering ? "Recovered after host restart." : "Package stream verified with the real coding tools.";
        const partial = controlRun ? text.slice(0, 20) : held ? `${gateName}: current run`
          : firstRecoveryAttempt ? "Recovery request is in progress." : recovering ? "Recovered" : "Package stream";
        item = { type: "message", id: "msg_" + id, role: "assistant", status: "in_progress", content: [] };
        emit({ type: "response.output_item.added", output_index: 0, item });
        emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: partial });
        if (held) {
          held.entered++;
          for (const waiter of held.waiters) waiter();
          await held.released;
          if (response.destroyed) return;
        }
        if (firstRecoveryAttempt) return; // The client is terminated while this response is open.
        await delay(controlRun ? 1_500 : 650);
        emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text.slice(partial.length) });
        item = { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      }
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({ type: "response.completed", response: { id: responseId, output: [item], status: "completed",
        usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 } } } });
      response.end();
    } catch (error) {
      failures.push(error.message);
      if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid smoke test request" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/openai/v1`,
    requests,
    failures,
    waitForGate(name, attempts = 1) {
      const held = gate(name);
      if (held.entered >= attempts) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const check = () => {
          if (held.entered < attempts) return;
          clearTimeout(timeout);
          held.waiters.delete(check);
          resolve();
        };
        const timeout = setTimeout(() => {
          held.waiters.delete(check);
          reject(new Error(`The local provider did not enter ${name} attempt ${attempts}.`));
        }, 15_000);
        held.waiters.add(check);
      });
    },
    releaseGate: name => gate(name).release(),
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
