import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import "./popup.css";

/**
 * Tell the stylesheet which surface we are on, before React paints.
 *
 * The same markup serves two very different containers: the toolbar popup,
 * which Chrome sizes to the document and caps at 800x600, and a full browser
 * tab, used for first-run onboarding because an extension cannot open its own
 * popup. Without this the popup's fixed 400px width also applies in the tab,
 * leaving the panel as a narrow strip pinned to the left edge.
 *
 * `chrome.tabs.getCurrent()` resolves to a tab only when we *are* one — it is
 * undefined inside a popup — which is the cleanest way to tell them apart.
 */
async function markSurface(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    document.body.dataset.surface = tab ? "tab" : "popup";
  } catch {
    document.body.dataset.surface = "popup";
  }
}

// Mount after the surface is known so there is no flash of the wrong layout.
void markSurface().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
