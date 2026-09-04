// Ambient declarations for values vite substitutes at build time.
//
// This file deliberately has no import or export: that is what keeps it a
// global script rather than a module, so the declarations below are visible
// everywhere. Declaring them inside types.ts did not work for exactly that
// reason — types.ts is a module, so the declaration was scoped to it.

/**
 * When this bundle was built, as `YYYY-MM-DD HH:MM:SS`.
 *
 * Logged by the content script on injection. Reloading the extension does not
 * replace the content script in a tab that is already open, so a shipped fix
 * can fail to be what the page is running; this makes that visible instead of
 * something to deduce from a stack trace.
 */
declare const __BUILD_STAMP__: string;
