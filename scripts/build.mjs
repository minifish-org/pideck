import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: { "main/index": "src/main/index.ts", "host/worker": "src/host/worker.ts" },
    outdir: "dist",
    platform: "node",
    format: "esm",
    packages: "external",
    bundle: true,
    target: "node22",
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/main/preload.ts"],
    outfile: "dist/main/preload.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
    bundle: true,
    target: "node22",
  }),
  build({
    entryPoints: ["src/automation/cli.ts", "src/automation/node-prelude.ts"],
    outdir: "dist/automation",
    outExtension: { ".js": ".cjs" },
    platform: "node",
    format: "cjs",
    packages: "external",
    bundle: true,
    target: "node22",
  }),
]);
