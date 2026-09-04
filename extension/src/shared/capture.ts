// Who the capture belongs to.
//
// Split out of the service worker so it can be exercised in Node: importing
// that module runs its listener registrations and needs a live `chrome`.

/** The parts of the worker's capture state this decision depends on. */
export interface CaptureOwner {
  /** Whether a tab is being captured at all. */
  active: boolean;
  /** Which tab that is, or null when nothing is being captured. */
  tabId: number | null;
}

/**
 * Is capture running *for the tab that asked*?
 *
 * `active` on its own is a property of the extension, not of a page. A content
 * script that hears "active" mounts the avatar, so answering the global value
 * put an interpreter on every page the user opened while a video played in
 * another tab — the overlay appearing on sites that have no media at all.
 *
 * The content script cannot filter this itself: a page has no way to learn its
 * own tab id. So the answer is narrowed in the service worker, which knows it
 * from `sender.tab.id`.
 *
 * `askingTabId` is undefined when the popup asks. The popup is the extension's
 * own UI and its Connect/Disconnect switch describes the whole extension, so it
 * genuinely wants the global answer. A content script never does.
 */
export function captureActiveFor(
  state: CaptureOwner,
  askingTabId: number | undefined,
): boolean {
  if (askingTabId === undefined) return state.active;
  return state.active && state.tabId === askingTabId;
}
