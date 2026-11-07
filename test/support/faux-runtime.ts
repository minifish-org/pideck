import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ChatView, Selection, SendChat } from "../../src/shared/api.js";
import { Runtime } from "../../src/host/runtime.js";

export function fauxRuntime(dataDir: string) {
  const faux = fauxProvider({ models: [{ id: "pideck-test-model", input: ["text", "image"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return {
    faux,
    open: (lifetimeId?: string, closedWindows?: readonly number[]) => Runtime.open(dataDir, {}, models, undefined, undefined, lifetimeId, closedWindows),
    input: (selection: Selection, text: string): SendChat => ({
      ...selection, model: { provider: model.provider, id: model.id }, thinking: "off", text,
    }),
  };
}

export function toolResponse(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

export function waitForView(
  runtime: Runtime,
  selection: Selection,
  predicate: (view: ChatView) => boolean,
  timeoutMs = 10_000,
): Promise<ChatView> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    let settled = false;
    const finish = (error: unknown, view?: ChatView) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      if (view) resolve(view);
      else reject(error);
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for a conversation update.")), timeoutMs);
    void runtime.watch(selection, view => {
      if (predicate(view)) finish(undefined, view);
    }, message => finish(new Error(message))).then(watch => {
      stop = watch.dispose;
      if (settled) watch.dispose();
    }, finish);
  });
}
