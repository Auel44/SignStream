import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "vite-plugin-web-extension";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: () =>
        JSON.parse(readFileSync(resolve(__dirname, "manifest.json"), "utf-8")),
      // Neither of these is referenced from the manifest, so the plugin has to
      // be told about them:
      //   * the offscreen document is created at runtime
      //   * the PCM worklet is loaded by URL via audioWorklet.addModule, and
      //     must stay a standalone file — Chrome does not allow `import` in a
      //     worklet module, so it must not be merged into another chunk.
      additionalInputs: ["src/offscreen/offscreen.html", "src/offscreen/pcm-worklet.ts"],
    }),
  ],
  // A stamp identifying which build is actually running.
  //
  // Reloading the extension does NOT replace the content script in a tab that
  // is already open — content scripts are injected at page load — so a fix can
  // be built, shipped and still not be what the page is executing. Diagnosing
  // that from a stack trace alone wasted real time: a trace pointed at code the
  // shipped build could no longer reach, because the tab was running the
  // previous one. The stamp settles it in one line.
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().replace("T", " ").slice(0, 19)),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // Chrome refuses modulepreload hints inside an extension page —
    // "cross-world extension resource mismatch" — because the preloaded chunk
    // is fetched in a different world from the module that wants it. The hint
    // is then ignored and the console fills with warnings. Nothing needs it:
    // the offscreen document loads one module and pays no round-trip penalty.
    modulePreload: false,
  },
});
