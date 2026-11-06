import { fauxRuntime } from "./faux-runtime.js";

const [dataDir, projectId, sessionId, requestId] = process.argv.slice(2);
const fixture = fauxRuntime(dataDir);
const runtime = await fixture.open();
fixture.faux.setResponses([() => {
  // Keep the provider request outstanding until the parent kills this process.
  process.send?.("in-flight");
  return new Promise(() => { setInterval(() => {}, 1000); });
}]);
await runtime.send({ ...fixture.input({ projectId, sessionId }, "Recover this request."), requestId });
