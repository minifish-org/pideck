import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

// A local Azure Responses endpoint speaks the real pi-ai wire protocol. No
// application code, IPC, Durable tasks, or model adapter is replaced in the test.
export async function openSmokeProvider() {
  const requests = [];
  const failures = [];
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
      const recovering = prompt?.includes("Recover the active request");
      const id = randomUUID().replaceAll("-", "");
      const responseId = "resp_" + id;
      const emit = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      emit({ type: "response.created", response: { id: responseId } });
      let item;
      if (!recovering && tools.length < 2) {
        const name = tools.length === 0 ? "edit" : "bash";
        const args = JSON.stringify(name === "edit"
          ? { path: "example.ts", edits: [{ oldText: "'before'", newText: "'after'" }] }
          : { command: 'test -z "$AZURE_OPENAI_API_KEY" && cat example.ts' });
        item = { type: "function_call", id: "fc_" + id, call_id: "call_" + id, name, arguments: "", status: "in_progress" };
        emit({ type: "response.output_item.added", output_index: 0, item });
        emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: args });
        item = { ...item, arguments: args, status: "completed" };
      } else {
        const firstRecoveryAttempt = recovering && ++recoveryRequests === 1;
        const text = recovering ? "Recovered after host restart." : "Package stream verified with the real coding tools.";
        const partial = firstRecoveryAttempt ? "Recovery request is in progress." : recovering ? "Recovered" : "Package stream";
        item = { type: "message", id: "msg_" + id, role: "assistant", status: "in_progress", content: [] };
        emit({ type: "response.output_item.added", output_index: 0, item });
        emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: partial });
        if (firstRecoveryAttempt) return; // The client is terminated while this response is open.
        await delay(650);
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
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
