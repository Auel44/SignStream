// Entry point for the offline retargeting harness.
//
// Re-exports the SHIPPED modules so the Node checks under tools/rt run the same
// code the browser does. Rebuild after touching rigs.ts or retarget.ts:
//
//   node tools/rt/build.mjs
//
// Use that script rather than the esbuild CLI: this file sits outside
// extension/, so esbuild's upward search for node_modules never reaches the
// extension's own, and `three` fails to resolve. build.mjs passes nodePaths.
//
// A stale bundle is worse than no harness: it passes while testing code that is
// no longer shipped. This one went three weeks stale against a rig set that had
// been replaced entirely, and still reported OK.
export * as THREE from "three";
export { Retargeter } from "../../extension/src/content/retarget";
export { RIGS, rigById, restFrame, boneKey } from "../../extension/src/content/rigs";
export { captureActiveFor } from "../../extension/src/shared/capture";
