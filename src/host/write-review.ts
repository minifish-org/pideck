import { relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { wrapTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { createTwoFilesPatch } from "diff";

const reviewBytes = 128 * 1024;

type FileSnapshot = { content: string; exists: boolean };

async function snapshot(env: ExecutionEnv, path: string, context: Context): Promise<FileSnapshot | undefined> {
  const opened = await env.openBinaryReader(path, { noFollow: true }, context);
  if (!opened.ok) {
    return opened.error.code === "not_found" ? { content: "", exists: false } : undefined;
  }
  try {
    const read = await opened.value.read(0, reviewBytes + 1, context);
    if (!read.ok || read.value.length > reviewBytes) return undefined;
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.value);
    if (content.includes("\0")) return undefined;
    return { content, exists: true };
  } finally {
    await opened.value.close(context);
  }
}

// Capture the before-image at the actual write boundary, inside Durable's
// mutation queue. The built-in tool still resolves paths, writes, and settles.
export const reviewWrites = wrapTool(createWriteTool(), tool => ({
  ...tool,
  async execute(args, api, context) {
    const env = api.env;
    if (!env || Buffer.byteLength(args.content) > reviewBytes || args.content.includes("\0")) {
      return tool.execute(args, api, context);
    }

    let change: { path: string; before: FileSnapshot; after: string } | undefined;
    const writeFile: ExecutionEnv["writeFile"] = async (path, content, scope) => {
      const before = await snapshot(env, path, scope).catch(() => undefined);
      const result = await env.writeFile(path, content, scope);
      if (result.ok && before && typeof content === "string") {
        const after = content.toWellFormed();
        if (before.content !== after) change = { path, before, after };
      }
      return result;
    };
    const reviewEnv = new Proxy(env, {
      get(target, key) {
        if (key === "writeFile") return writeFile;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await tool.execute(args, { ...api, env: reviewEnv }, context);
    if (!change || result.isError) return result;
    const path = relative(env.cwd, change.path).split(sep).join("/");
    if (!path || /[\r\n\t]/.test(path)) return result;
    const patch = createTwoFilesPatch(
      change.before.exists ? "a/" + path : "/dev/null", "b/" + path,
      change.before.content, change.after, undefined, undefined, { timeout: 75 },
    );
    return patch ? { ...result, details: { patch } } : result;
  },
}));
