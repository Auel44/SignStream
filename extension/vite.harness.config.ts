// Standalone dev server for the VRM harness.
//
// Deliberately separate from vite.config.ts: that build is owned by
// vite-plugin-web-extension, which rewrites the manifest and treats every entry
// as an extension surface. The harness is an ordinary web page, so it gets its
// own config and cannot disturb the extension build.
//
//   npm run vrm-check
//
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "dev-harness"),
  // Serves extension/public, so the harness reads the very same test.vrm the
  // extension will ship rather than a copy that could drift.
  publicDir: resolve(__dirname, "public"),
  server: { open: true },
});
