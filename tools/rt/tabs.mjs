// Regression check: the avatar must not appear on tabs that are not captured.
//
//   node tools/rt/tabs.mjs
//
// The bug this pins
// -----------------
// `GET_CAPTURE_STATE` used to answer with the extension-wide `active` flag. A
// content script mounts the avatar when it hears "active", and every page runs
// one (`<all_urls>`), so opening any site while a video played in another tab
// put a signing interpreter on it — a bank page, a text editor, anything.
//
// The content script cannot filter this itself: a page has no way to learn its
// own tab id. So the narrowing has to happen in the service worker, and this
// checks it stays there.
import { captureActiveFor } from "./bundle.mjs";

const CAPTURED_TAB = 7;
const OTHER_TAB = 42;
const capturing = { active: true, tabId: CAPTURED_TAB };
const idle = { active: false, tabId: null };

const cases = [
  ["captured tab sees the avatar", capturing, CAPTURED_TAB, true],
  ["a tab beside it does NOT", capturing, OTHER_TAB, false],
  ["popup still gets the global answer", capturing, undefined, true],
  ["nothing captured, captured tab", idle, CAPTURED_TAB, false],
  ["nothing captured, other tab", idle, OTHER_TAB, false],
  ["nothing captured, popup", idle, undefined, false],
  // active:true with tabId:null is the window between starting capture and
  // learning which tab it is. No tab may claim it.
  ["active but no tab yet", { active: true, tabId: null }, OTHER_TAB, false],
];

let failed = 0;
for (const [name, state, tab, want] of cases) {
  const got = captureActiveFor(state, tab);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(36)} -> ${got}`);
}
console.log(failed ? `\n${failed} case(s) failed` : `\nall ${cases.length} cases ok`);
process.exit(failed ? 1 : 0);
