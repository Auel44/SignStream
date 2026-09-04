// Rebuild bundle.mjs from the SHIPPED extension sources.
//
//   node tools/rt/build.mjs
//
// Run this after touching rigs.ts or retarget.ts. A stale bundle is worse than
// no harness at all: it keeps passing while testing code that is no longer
// shipped. This one sat three weeks stale against a rig set that had been
// replaced outright — every rig in it had been deleted — and still reported OK.
import { build } from "../../extension/node_modules/esbuild/lib/main.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, "../../extension");

await build({
  entryPoints: [path.join(here, "entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(here, "bundle.mjs"),
  // entry.ts lives outside extension/, so esbuild's upward search never reaches
  // the extension's node_modules. Point it there explicitly.
  nodePaths: [path.join(extension, "node_modules")],
  logLevel: "warning",
});
console.log("bundle.mjs rebuilt from extension/src");
