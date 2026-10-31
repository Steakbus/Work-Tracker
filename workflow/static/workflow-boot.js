"use strict";
// Workflow loader — the only part that runs until the board is used. It shows the tab on the right
// edge (with the dot while the timer runs on a card) and loads workflow.js on the first open,
// W, A or ⌘K / Ctrl+K. So an unused board costs a button and a few listeners, no polling.
(() => {
  const icon = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16M15 4v16"/></svg>';
  document.body.insertAdjacentHTML("beforeend",
    `<button class="wf-tab" id="wf-tab" title="Workflow board (W)">${icon}<span>Workflow</span><i class="wf-dot" id="wf-dot" hidden></i></button>`);

  let loading = null;
  /** Load the board once; resolves to its API (setOpen, newCard, openPalette). */
  function app() {
    loading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/workflow/static/workflow.js";
      s.onload = () => resolve(window.Workflow);
      s.onerror = () => { loading = null; reject(new Error("Workflow couldn't load.")); };
      document.head.appendChild(s);
    });
    return loading;
  }
  const loaded = () => !!window.Workflow;  // from then on workflow.js handles everything itself

  let open = false;
  try { open = localStorage.getItem("workflow.open") === "1"; } catch { /* private mode */ }
  if (open) app();

  document.getElementById("wf-tab").addEventListener("click", () => { if (!loaded()) app().then((w) => w.setOpen(true)); });

  document.addEventListener("keydown", (e) => {
    if (loaded()) return;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    if (e.key.toLowerCase() === "k" && (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (!document.querySelector("dialog[open]")) app().then((w) => w.openPalette());
      return;
    }
    const el = document.activeElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || document.querySelector("dialog[open]")
      || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "w" || e.key === "W") app().then((w) => w.setOpen(true));
    if (e.key === "a" || e.key === "A") { e.preventDefault(); app().then((w) => w.newCard()); }
  });

  // The dot: a tiny request on load, after Start/Stop on the tracker page or elsewhere and when the tab comes back.
  async function updateDot() {
    try {
      const res = await fetch("/api/workflow/running");
      if (res.ok) document.getElementById("wf-dot").hidden = !(await res.json()).card_id;
    } catch { /* offline: keep the last state */ }
  }
  updateDot();
  for (const [id, type] of [["toggle", "click"], ["session-form", "submit"]]) {
    document.getElementById(id)?.addEventListener(type, () => setTimeout(updateDot, 400));
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) updateDot(); });
  document.addEventListener("tracker:changed", updateDot);  // e.g. Stop from the menu bar
})();
