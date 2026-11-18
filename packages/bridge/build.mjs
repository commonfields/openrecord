import { build } from "esbuild"
import { fileURLToPath } from "node:url"

await build({
  entryPoints: [fileURLToPath(new URL("src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../../apps/web/public/openrecord-bridge.mjs", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Loaded on demand; Cursor reports as not installed where the SDK is absent.
  external: ["@cursor/sdk"],
  banner: { js: "#!/usr/bin/env node" }
})
