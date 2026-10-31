"use strict";
// Workflow — kanban panel for Work Tracker. Loaded by workflow-boot.js the first time the board is used
// (the loader owns the tab on the right edge). Everything is wrapped so nothing collides with the
// tracker's globals in app.js; the loader talks to it through window.Workflow.
(() => {
  // ---------------------------------------------------------- helpers

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtDur = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    return `${Math.floor(sec / 3600)}h ${pad2(Math.floor((sec % 3600) / 60))}m`;
  };
  const fmtClock = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
  };
  const hours = (sec) => fmtDur(sec).replace(" 00m", "");
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const shortDate = (s) => parseYmd(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const hue = (label) => [...label.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const store = {
    get(k) { try { return localStorage.getItem("workflow." + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("workflow." + k, v); } catch { /* private mode */ } },
  };

  const svg = (body, extra = "") =>
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
  const I = {
    board: svg('<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16M15 4v16"/>'),
    play: svg('<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 'stroke-width="2.5"'),
    wide: svg('<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>'),
    narrow: svg('<path d="M3 12h7M21 12h-7M7 8l4 4-4 4M17 8l-4 4 4 4"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'stroke-width="2.5"'),
    list: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>'),
    cal: svg('<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    text: svg('<path d="M5 7h14M5 12h14M5 17h9"/>'),
    grip: svg('<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>', 'stroke="none"'),
    bug: svg('<rect x="8" y="7.5" width="8" height="11" rx="4"/><path d="M12 7.5v11M8 11H4.5M19.5 11H16M8 15.5l-3 2M16 15.5l3 2M9.5 7.5L8 5M14.5 7.5L16 5"/>'),
    issue: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r="1.1" fill="currentColor" stroke="none"/>'),
    task: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="3.5"/>'),
    flag: svg('<path d="M6 21V4M6 4.5h11l-2.5 4 2.5 4H6"/>'),
    filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'),
    edit: svg('<path d="M14.5 5.5l4 4M4.5 19.5l1-4.5L15.5 5l3.5 3.5-10 10z"/>'),
    archive: svg('<rect x="3.5" y="4.5" width="17" height="4.5" rx="1"/><path d="M5 9v9.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>'),
    search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
    trash: svg('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>'),
    chart: svg('<path d="M5 20V13M12 20V5M19 20v-9"/>'),
    update: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>'),
  };
  const PRIO = { "": "None", low: "Low", medium: "Medium", high: "High" };
  const TYPES = { task: "Task", bug: "Bug", issue: "Issue" };  // names match TYPES in workflow.py
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const CMD_KEY = MAC ? "⌘K" : "Ctrl K";
  // Column accents (names match COLORS in workflow.py).
  const COLORS = { gray: "#8b949e", red: "#e5534b", orange: "#e0823d", yellow: "#d4a72c", green: "#3fa35b",
    teal: "#1f9e95", blue: "#4184e4", purple: "#9a6dd7", pink: "#d95e9b" };

  // ---------------------------------------------------------- state

  let board = null;        // last /api/workflow/board response
  let fetchedAt = 0;       // Date.now() of that response (wall clock: keeps counting through sleep)
  let drawer = null;       // side drawer showing: null | "archive" | "phases"
  let archived = [];       // last /api/workflow/archive response
  let dragId = null;       // card being dragged
  let colDragId = null;    // column being dragged (grabbed anywhere outside its cards)
  let editing = null;      // card open in the dialog (a copy)
  let tickTimer = null;    // 1 s live clock, only while open, visible and a timer runs
  const filters = { q: "", label: "", prio: "", type: "", phase: "" };  // phase: "" | "none" | phase id
  const FILTER_KEYS = ["label", "prio", "type", "phase"];

  const isOpen = () => document.body.classList.contains("wf-open");
  const liveExtra = () => (board && board.running ? (Date.now() - fetchedAt) / 1000 : 0);
  const columnById = (id) => board.columns.find((c) => c.id === id);
  const cardById = (id) => board.cards.find((c) => c.id === id);
  const cardsIn = (colId) => board.cards.filter((c) => c.column_id === colId).sort((a, b) => a.position - b.position);
  const phaseById = (id) => board.phases.find((p) => p.id === id);
  const tracked = (card) => card.tracked_seconds + (card.running ? liveExtra() : 0);

  // ---------------------------------------------------------- DOM skeleton

  document.body.insertAdjacentHTML("beforeend", `
    <aside class="wf-panel" id="wf-panel" aria-label="Workflow">
      <div class="wf-resize" id="wf-resize" title="Drag to resize · double-click to reset"></div>
      <div class="wf-head">
        <h2>${I.board} Workflow</h2>
        <div class="wf-filters">
          <div class="wf-searchbox">
            <input type="search" class="wf-search" id="wf-q" placeholder="Search cards…">
            <button type="button" class="wf-kbd" id="wf-cmdk-btn" title="Command palette">${CMD_KEY}</button>
          </div>
          <button class="btn ghost" id="wf-filter-btn" title="Filter by label, priority, type or phase">${I.filter}<span>Filter</span></button>
        </div>
        <div class="wf-actions">
          <button class="btn start" id="wf-new" title="New card (A)">+ New card</button>
          <button class="btn ghost" id="wf-phases-btn" title="Phases until release">${I.flag}<span>Phases</span></button>
          <button class="btn ghost" id="wf-archive-btn" title="Archived cards">${I.archive}<span>Archive</span></button>
          <button class="btn link" id="wf-wide" title="Full width"></button>
          <button class="btn link" id="wf-close" title="Close (Esc)" aria-label="Close">${I.x}</button>
        </div>
      </div>
      <div class="wf-running" id="wf-running" hidden></div>
      <div class="wf-body">
        <div class="wf-board" id="wf-board"></div>
        <div class="wf-drawer" id="wf-archive" hidden>
          <div class="wf-drawer-head"><h3>Archived cards</h3>
            <button class="btn link" data-close-drawer title="Close (Esc)" aria-label="Close archive">${I.x}</button></div>
          <input type="search" id="wf-archive-q" placeholder="Search archived cards…">
          <ul id="wf-archive-list"></ul>
        </div>
        <div class="wf-drawer" id="wf-phases" hidden>
          <div class="wf-drawer-head"><h3>Phases until release</h3>
            <button class="btn link" data-close-drawer title="Close (Esc)" aria-label="Close phases">${I.x}</button></div>
          <p class="small muted wf-drawer-hint">Milestones in order. Click one to show only its cards; drag to reorder.</p>
          <ul id="wf-phase-list" class="wf-phase-list"></ul>
          <input id="wf-phase-new" maxlength="100" placeholder="+ Add a phase, e.g. Beta (Enter)">
        </div>
      </div>
    </aside>
    <div class="wf-toast" id="wf-toast" role="status" hidden><span></span><button class="btn link">Undo</button></div>
    <div class="time-menu wf-menu" id="wf-menu" hidden></div>
    <div class="wf-error" id="wf-error" role="alert" hidden></div>
    <datalist id="wf-label-list"></datalist>
    <dialog class="wf-dialog" id="wf-dialog">
      <form id="wf-form">
        <div class="head">
          <input id="wf-f-title" required maxlength="300" aria-label="Title" placeholder="Card title">
          <button type="button" class="btn link" id="wf-f-x" aria-label="Close">${I.x}</button>
        </div>
        <div class="wf-time" id="wf-f-time">
          <div><div class="label">Tracked</div><span class="big" id="wf-f-tracked"></span> <span class="muted small" id="wf-f-est-note"></span></div>
          <span class="spacer" style="flex:1"></span>
          <button type="button" class="btn ghost" id="wf-f-link" hidden>Link running timer</button>
          <button type="button" class="btn start" id="wf-f-timer"></button>
        </div>
        <label>Description <textarea id="wf-f-desc" maxlength="20000" placeholder="Notes, links, acceptance criteria…"></textarea></label>
        <div class="grid">
          <label>Type <select id="wf-f-type">${Object.entries(TYPES).map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
          <label>Column <select id="wf-f-col"></select></label>
          <label id="wf-f-phase-box">Phase <select id="wf-f-phase"></select></label>
          <label>Priority <select id="wf-f-prio">${Object.entries(PRIO).map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
          <label>Due date <input type="date" id="wf-f-due"></label>
          <label>Estimate (hours) <input type="number" id="wf-f-est" min="0" max="1000" step="0.25" placeholder="—"></label>
        </div>
        <label>Labels <input id="wf-f-labels" list="wf-label-list" placeholder="Comma separated, e.g. client-a, bug"></label>
        <div>
          <h4>Checklist <span class="muted small" id="wf-f-check-count"></span></h4>
          <div class="wf-progress" id="wf-f-check-bar"><div></div></div>
          <ul class="wf-checklist" id="wf-f-checklist"></ul>
          <input id="wf-f-check-new" placeholder="Add an item and press Enter" style="width:100%;margin-top:4px">
        </div>
        <details id="wf-f-sessions-box"><summary class="small muted" id="wf-f-sessions-sum">Sessions</summary>
          <ul class="wf-sessions" id="wf-f-sessions"></ul></details>
        <div class="error small" id="wf-f-error"></div>
        <div class="actions">
          <button type="button" class="btn ghost danger" id="wf-f-delete">Delete</button>
          <button type="button" class="btn ghost" id="wf-f-archive">Archive</button>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" id="wf-f-cancel">Cancel</button>
          <button class="btn start" id="wf-f-save">Save</button>
        </div>
      </form>
    </dialog>
    <dialog class="wf-dialog wf-confirm" id="wf-confirm">
      <form method="dialog">
        <h3 id="wf-confirm-title"></h3>
        <p class="muted" id="wf-confirm-text"></p>
        <div class="actions">
          <span class="spacer"></span>
          <button class="btn ghost" value="cancel">Cancel</button>
          <button class="btn stop" value="ok" id="wf-confirm-ok"></button>
        </div>
      </form>
    </dialog>
    <dialog class="wf-cmdk" id="wf-cmdk" aria-label="Command palette">
      <div class="wf-cmdk-input">${I.search}<span class="wf-cmdk-crumb" id="wf-cmdk-crumb" hidden></span>
        <input id="wf-cmdk-q" autocomplete="off" spellcheck="false" placeholder="Type a command or search cards…"></div>
      <ul class="wf-cmdk-list" id="wf-cmdk-list" role="listbox"></ul>
      <div class="wf-cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span>
        <span><kbd>⌫</kbd> back</span><span><kbd>esc</kbd> close</span></div>
    </dialog>`);

  const panel = $("wf-panel"), menu = $("wf-menu"), dialog = $("wf-dialog");

  let errTimer;
  function showError(msg) {
    $("wf-error").textContent = msg;
    $("wf-error").hidden = false;
    clearTimeout(errTimer);
    errTimer = setTimeout(() => ($("wf-error").hidden = true), 4500);
  }
  const attempt = (fn) => async (...args) => { try { await fn(...args); } catch (e) { showError(e.message); } };

  /** Our own confirm(): resolves true for the red button; Cancel, Esc or a click outside resolve false. */
  function ask(title, text, okLabel = "Delete") {
    const box = $("wf-confirm");
    $("wf-confirm-title").textContent = title;
    $("wf-confirm-text").textContent = text;
    $("wf-confirm-text").hidden = !text;
    $("wf-confirm-ok").textContent = okLabel;
    menu.hidden = true;
    box.returnValue = "";
    box.showModal();
    $("wf-confirm-ok").focus();  // Enter confirms
    return new Promise((resolve) => box.addEventListener("close", () => resolve(box.returnValue === "ok"), { once: true }));
  }
  /** Close a modal <dialog> on a click outside its box. Only when the press started outside too:
   *  selecting text in a field and letting go outside mustn't close (and lose) a card. */
  function closeOnBackdrop(box, close) {
    let downOutside = false;
    box.addEventListener("mousedown", (e) => (downOutside = e.target === box));
    box.addEventListener("click", (e) => { if (e.target === box && downOutside) close(); });
  }
  closeOnBackdrop($("wf-confirm"), () => $("wf-confirm").close("cancel"));

  /** Let the tracker page catch up after the timer changed here. */
  function trackerRefresh() {
    if (typeof window.refreshAll === "function") window.refreshAll().catch(() => {});
  }

  // ---------------------------------------------------------- open / close

  let freeTimer;
  function setOpen(open) {
    document.body.classList.toggle("wf-open", open);
    store.set("open", open ? "1" : "");
    clearTimeout(freeTimer);
    schedule();
    if (open) return load().catch((e) => showError("Workflow: " + e.message));
    menu.hidden = true;
    // Closed: let the cards' DOM and the archive list go once the panel has slid out (rebuilt on open).
    freeTimer = setTimeout(() => {
      if (isOpen()) return;
      $("wf-board").textContent = "";
      $("wf-archive-list").textContent = "";
      archived = [];
    }, 400);
  }
  function setWide(wide) {
    document.body.classList.toggle("wf-wide", wide);
    $("wf-wide").innerHTML = wide ? I.narrow : I.wide;
    $("wf-wide").title = wide ? "Narrow" : "Full width";
    store.set("wide", wide ? "1" : "");
  }
  $("wf-tab").onclick = () => setOpen(true);
  $("wf-close").onclick = () => setOpen(false);
  $("wf-wide").onclick = () => setWide(!document.body.classList.contains("wf-wide"));

  // Panel width: drag the left edge; the tracker keeps at least MIN_PAGE px next to it.
  const MIN_PANEL = 340, MIN_PAGE = 420;
  const defaultWidth = () => Math.round(window.innerWidth * 0.42);
  let panelWidth = Number(store.get("width")) || 0;
  function applyWidth() {
    const w = Math.round(Math.max(MIN_PANEL, Math.min(panelWidth || defaultWidth(), window.innerWidth - MIN_PAGE)));
    document.documentElement.style.setProperty("--wf-w", w + "px");
  }
  $("wf-resize").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    $("wf-resize").setPointerCapture(e.pointerId);
    document.body.classList.add("wf-resizing");
  });
  $("wf-resize").addEventListener("pointermove", (e) => {
    if (!document.body.classList.contains("wf-resizing")) return;
    panelWidth = window.innerWidth - e.clientX;
    applyWidth();
  });
  $("wf-resize").addEventListener("pointerup", () => {
    document.body.classList.remove("wf-resizing");
    store.set("width", String(Math.round(panelWidth)));
  });
  $("wf-resize").addEventListener("dblclick", () => { panelWidth = 0; store.set("width", ""); applyWidth(); });
  window.addEventListener("resize", applyWidth);
  applyWidth();

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "Escape" && !menu.hidden) { menu.hidden = true; return; }
    if (e.key === "Escape" && drawer && (!typing || document.activeElement.closest(".wf-drawer"))) { setDrawer(null); return; }
    if (e.key === "Escape" && isOpen() && !typing) setOpen(false);
    if ((e.key === "w" || e.key === "W") && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) setOpen(!isOpen());
    if ((e.key === "a" || e.key === "A") && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();  // or the "a" lands in the title field that gets focus
      newCard();
    }
  });

  // ---------------------------------------------------------- load + render

  /** What the board shows, without the values that change every second anyway (the tick keeps those live). */
  const signature = (d) => JSON.stringify([d.today, d.columns, d.phases, d.archived_count, d.running_card_id,
    d.running && [d.running.id, d.running.note], d.cards.map((c) => (c.running ? { ...c, tracked_seconds: 0 } : c))]);
  let lastSignature = "";

  /** Fetch the board and draw it; `quiet` (the 10 s refresh) skips the redraw when nothing changed. */
  async function load(quiet = false) {
    const data = await api("GET", "/api/workflow/board");
    const sig = signature(data);
    board = data;
    fetchedAt = Date.now();
    if (quiet && sig === lastSignature) tick();
    else render();
    lastSignature = sig;
    schedule();
  }

  function render() {
    if (!board) return;
    $("wf-dot").hidden = !board.running_card_id;
    if (!isOpen()) return;
    renderFilters();
    renderRunning();
    $("wf-archive-btn").querySelector("span").textContent = `Archive (${board.archived_count})`;
    $("wf-archive-btn").classList.toggle("on", drawer === "archive");
    $("wf-archive").hidden = drawer !== "archive";
    $("wf-phases-btn").classList.toggle("on", drawer === "phases");
    $("wf-phases").hidden = drawer !== "phases";
    if (drawer === "phases") renderPhases();
    renderBoard();
  }

  const allLabels = () => [...new Set(board.cards.flatMap((c) => c.labels))].sort((a, b) => a.localeCompare(b));

  /** The Filter button shows what's active; the popover (openFilterMenu) changes it. */
  function renderFilters() {
    if (filters.phase && filters.phase !== "none" && !phaseById(Number(filters.phase))) filters.phase = "";
    const active = FILTER_KEYS.filter((k) => filters[k]);
    const names = active.map((k) => k === "label" ? filters.label : k === "prio" ? PRIO[filters.prio]
      : k === "type" ? TYPES[filters.type] : filters.phase === "none" ? "No phase" : phaseById(Number(filters.phase)).name);
    $("wf-filter-btn").querySelector("span").textContent = active.length ? names.join(" · ") : "Filter";
    $("wf-filter-btn").classList.toggle("on", active.length > 0);
    $("wf-label-list").innerHTML = allLabels().map((l) => `<option value="${esc(l)}">`).join("");
  }

  function setFilter(key, value) {
    filters[key] = value;
    renderFilters();
    renderBoard();
    if (drawer === "phases") renderPhases();
  }
  /** Fields for a new card so it matches the active filters (and doesn't vanish from the board). */
  const filterDefaults = () => ({
    ...(filters.type && { type: filters.type }),
    ...(filters.prio && { priority: filters.prio }),
    ...(filters.label && { labels: [filters.label] }),
    ...(Number(filters.phase) && { phase_id: Number(filters.phase) }),
  });
  const clearFilters = () => { FILTER_KEYS.forEach((k) => (filters[k] = "")); setFilter("q", filters.q); };

  function openFilterMenu() {
    const row = (key, options) => `<div class="wf-menu-row">${Object.entries(options).map(([v, n]) =>
      `<button class="btn link${filters[key] === v ? " on" : ""}" data-k="${key}" data-v="${v}">${n}</button>`).join("")}</div>`;
    const labels = allLabels();
    menu.innerHTML = `
      <div class="wf-menu-label">Type</div>${row("type", { "": "Any", ...TYPES })}
      <div class="wf-menu-label">Priority</div>${row("prio", { "": "Any", low: "Low", medium: "Medium", high: "High" })}
      ${board.phases.length ? `<div class="wf-menu-label">Phase</div>
        <select data-k="phase"><option value="">Any phase</option><option value="none">No phase</option>
          ${board.phases.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>` : ""}
      ${labels.length ? `<div class="wf-menu-label">Label</div>
        <select data-k="label"><option value="">Any label</option>
          ${labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}</select>` : ""}
      <hr><button class="btn link" data-a="clear" ${FILTER_KEYS.some((k) => filters[k]) ? "" : "disabled"}>Clear filters</button>`;
    menu.querySelectorAll("select").forEach((sel) => (sel.value = filters[sel.dataset.k]));
    menu.onkeydown = null;
    menu.onchange = (e) => { if (e.target.dataset.k) { setFilter(e.target.dataset.k, e.target.value); openFilterMenu(); } };
    menu.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.a === "clear") { clearFilters(); menu.hidden = true; return; }
      setFilter(b.dataset.k, b.dataset.v);
      openFilterMenu();  // re-draw the active states, stay open
    };
    menu.hidden = false;
    const r = $("wf-filter-btn").getBoundingClientRect();
    showMenuAt(r.left, r.bottom + 4);
    menu.dataset.for = "filter";
  }
  $("wf-filter-btn").onclick = () => {
    if (!menu.hidden && menu.dataset.for === "filter") menu.hidden = true;
    else openFilterMenu();
  };

  function renderRunning() {
    const bar = $("wf-running");
    const run = board.running;
    bar.hidden = !run;
    if (!run) return;
    const card = board.running_card_id && cardById(board.running_card_id);
    if (card) {
      bar.innerHTML = `<span class="positive">${I.clock}</span> <span>Working on <b>${esc(card.title)}</b></span>
        <span class="clock-sm" data-live="session"></span>
        <span class="muted">· card total <span data-live="card">${fmtDur(tracked(card))}</span></span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn stop" data-act="stop">Stop</button>`;
    } else {
      const options = board.cards.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join("");
      bar.innerHTML = `<span class="positive">${I.clock}</span>
        <span>Timer running${run.note ? `: <b>${esc(run.note)}</b>` : ""} <span class="clock-sm" data-live="session"></span></span>
        ${options ? `<select data-act="link" aria-label="Link to a card"><option value="">Count it towards a card…</option>${options}</select>` : ""}
        <span class="spacer" style="flex:1"></span>
        <button class="btn stop" data-act="stop">Stop</button>`;
    }
    tick();
  }

  $("wf-running").addEventListener("click", attempt(async (e) => {
    if (e.target.dataset.act !== "stop") return;
    await stopTimer();
  }));
  $("wf-running").addEventListener("change", attempt(async (e) => {
    if (e.target.dataset.act !== "link" || !e.target.value) return;
    await api("POST", `/api/workflow/cards/${e.target.value}/link`);
    await load();
    trackerRefresh();  // the tracker's note now shows the card title
  }));

  async function stopTimer() {
    const note = board.running && board.running.note;
    await api("POST", "/api/stop");
    const noteEl = $("note");  // the tracker's note field would otherwise keep the card title
    if (noteEl && noteEl.value === note) noteEl.value = "";
    await load();
    trackerRefresh();
  }

  async function toggleTimer(card) {
    if (card.running) return stopTimer();
    await api("POST", `/api/workflow/cards/${card.id}/start`);
    await load();
    trackerRefresh();
  }

  function matches(card) {
    if (filters.label && !card.labels.includes(filters.label)) return false;
    if (filters.prio && card.priority !== filters.prio) return false;
    if (filters.type && card.type !== filters.type) return false;
    if (filters.phase && (filters.phase === "none" ? card.phase_id !== null : card.phase_id !== Number(filters.phase))) return false;
    if (filters.q) {
      const hay = [card.title, card.description, ...card.labels, ...card.checklist.map((i) => i.text)].join("\n").toLowerCase();
      return filters.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
    }
    return true;
  }

  function renderBoard() {
    if (!board) return;
    const wrap = $("wf-board");
    const scroll = wrap.scrollLeft;
    wrap.innerHTML = "";
    for (const col of board.columns) {
      const all = cardsIn(col.id);
      const over = col.wip_limit && all.length > col.wip_limit;
      const el = document.createElement("section");
      el.className = "wf-col" + (over ? " over-limit" : "") + (col.color ? " colored" : "");
      el.dataset.col = col.id;
      el.draggable = true;  // cards are draggable too; a drag that starts on a card moves the card
      if (col.color) el.style.setProperty("--c", COLORS[col.color]);
      el.innerHTML = `
        <div class="wf-col-head" title="Drag to move the column">
          <span class="wf-grip">${I.grip}</span>
          <h3 title="${esc(col.name)} · double-click to rename">${esc(col.name)}</h3>
          ${col.is_done ? `<span class="wf-done-mark" title="Done column: cards here count as finished">${I.check}</span>` : ""}
          <span class="wf-count" title="${col.wip_limit ? "Cards / WIP limit" : "Cards"}">${all.length}${col.wip_limit ? " / " + col.wip_limit : ""}</span>
          <button class="btn link" data-act="col-menu" title="Edit column" aria-label="Edit column">${I.more}</button>
        </div>
        <ul class="wf-cards"></ul>
        <div class="wf-add"><button class="btn link" data-act="add-card">+ Add card</button></div>`;
      const list = el.querySelector(".wf-cards");
      for (const card of all.filter(matches)) list.appendChild(cardEl(card, col));
      wrap.appendChild(el);
    }
    wrap.insertAdjacentHTML("beforeend",
      `<div class="wf-add-col"><button class="btn ghost" data-act="add-col">+ Add column</button></div>`);
    wrap.scrollLeft = scroll;
  }

  function cardEl(card, col) {
    const li = document.createElement("li");
    li.className = "wf-card" + (card.running ? " running" : "") + (col.is_done ? " done" : "");
    li.draggable = true;
    li.dataset.id = card.id;

    const meta = [];
    const phase = card.phase_id && phaseById(card.phase_id);
    if (phase && filters.phase !== String(phase.id)) meta.push(`<span class="wf-phase-chip" title="Phase">${I.flag}${esc(phase.name)}</span>`);
    if (card.priority) meta.push(`<span title="${PRIO[card.priority]} priority"><i class="wf-prio ${card.priority}"></i>${PRIO[card.priority]}</span>`);
    if (card.due_date) {
      const days = Math.round((parseYmd(card.due_date) - parseYmd(board.today)) / 86400000);
      const cls = col.is_done ? "" : days < 0 ? "overdue" : days <= 1 ? "due-soon" : "";
      const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : shortDate(card.due_date);
      meta.push(`<span class="${cls}" title="Due ${esc(card.due_date)}${cls === "overdue" ? " — overdue" : ""}">${I.cal}${when}</span>`);
    }
    const doneItems = card.checklist.filter((i) => i.done).length;
    if (card.checklist.length) meta.push(`<span title="Checklist">${I.list}${doneItems}/${card.checklist.length}</span>`);
    if (card.description) meta.push(`<span title="Has a description">${I.text}</span>`);
    const sec = tracked(card);
    if (sec >= 60 || card.estimate || card.running) {
      const over = card.estimate && sec > card.estimate;
      meta.push(`<span class="tracked${over ? " over-estimate" : ""}" title="Tracked${card.estimate ? " / estimate" : ""}">${I.clock}`
        + `<span ${card.running ? 'data-live="card"' : ""}>${fmtDur(sec)}</span>${card.estimate ? " / " + hours(card.estimate) : ""}</span>`);
    }

    li.innerHTML = `
      <div class="wf-title">${card.type !== "task" ? `<span class="wf-type ${card.type}" title="${TYPES[card.type]}">${I[card.type]}</span>` : ""}<span></span></div>
      <button class="wf-play" data-act="timer" title="${card.running ? "Stop timer" : "Start timer for this card"}">${card.running ? I.stop : I.play}</button>
      ${card.labels.length ? `<div class="wf-labels">${card.labels.map((l) => `<span class="wf-label" style="--h:${hue(l)}">${esc(l)}</span>`).join("")}</div>` : ""}
      ${meta.length ? `<div class="wf-meta">${meta.join("")}</div>` : ""}
      ${card.checklist.length ? `<div class="wf-progress"><div style="width:${(doneItems / card.checklist.length) * 100}%"></div></div>` : ""}`;
    li.querySelector(".wf-title > span:last-child").textContent = card.title;
    return li;
  }

  /** Live numbers once a second: the running session and the running card's total. */
  function tick() {
    if (!board || !board.running || !isOpen() || document.hidden) return;
    const extra = liveExtra();
    document.querySelectorAll('#wf-panel [data-live="session"]').forEach((el) => (el.textContent = fmtClock(board.running.seconds + extra)));
    const card = board.running_card_id && cardById(board.running_card_id);
    if (card) document.querySelectorAll('#wf-panel [data-live="card"]').forEach((el) => (el.textContent = fmtDur(tracked(card))));
    if (editing && card && editing.id === card.id) $("wf-f-tracked").textContent = fmtDur(tracked(card));
  }

  // ---------------------------------------------------------- board interactions

  $("wf-board").addEventListener("click", attempt(async (e) => {
    const act = e.target.closest("[data-act]");
    const cardNode = e.target.closest(".wf-card");
    if (act && act.dataset.act === "timer") return toggleTimer(cardById(Number(cardNode.dataset.id)));
    if (act && act.dataset.act === "col-menu") return openColumnMenu(act, Number(act.closest(".wf-col").dataset.col));
    if (act && act.dataset.act === "add-card") {
      const colId = Number(act.closest(".wf-col").dataset.col);  // read before the button leaves the page
      return inlineInput(act, "Card title, Enter to add", async (title) => {
        await api("POST", "/api/workflow/cards", { column_id: colId, title, ...filterDefaults() });
      });
    }
    if (act && act.dataset.act === "add-col") return inlineInput(act, "Column name, Enter to add", async (name) => {
      await api("POST", "/api/workflow/columns", { name });
    });
    if (cardNode) openCard(Number(cardNode.dataset.id));
  }));

  /** Change a column; the board shows it right away, then syncs. */
  async function saveColumn(colId, changes) {
    const runningHere = board.cards.some((c) => c.running && c.column_id === colId);
    Object.assign(columnById(colId), changes);
    renderBoard();
    await api("PATCH", `/api/workflow/columns/${colId}`, changes);
    await load();
    if (runningHere && changes.is_done) trackerRefresh();  // now a done column: the timer goes on without the card
  }

  // Double-click a column title to rename it in place (Enter saves, Esc cancels).
  $("wf-board").addEventListener("dblclick", (e) => {
    const h3 = e.target.closest(".wf-col-head h3");
    if (!h3) return;
    const colId = Number(h3.closest(".wf-col").dataset.col);
    const input = document.createElement("input");
    input.className = "wf-rename";
    input.maxLength = 100;
    input.value = columnById(colId).name;
    h3.closest(".wf-col").draggable = false;  // so the mouse can select text in the field
    h3.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = attempt(async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== columnById(colId).name) await saveColumn(colId, { name });
      else renderBoard();
    });
    input.addEventListener("keydown", (k) => {
      if (k.key === "Enter") finish(true);
      if (k.key === "Escape") { k.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  });

  /** Swap a button for a text field; Enter creates (and keeps the field open for the next one). */
  function inlineInput(button, placeholder, create) {
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.maxLength = 300;
    const col = button.closest(".wf-col");
    if (col) col.draggable = false;  // so the mouse can select text in the field (re-render resets it)
    button.replaceWith(input);
    input.focus();
    const restore = () => {
      if (!input.isConnected) return;
      input.replaceWith(button);
      if (col) col.draggable = true;
    };
    input.addEventListener("blur", () => setTimeout(restore, 150));
    input.addEventListener("keydown", attempt(async (e) => {
      if (e.key === "Escape") { e.stopPropagation(); input.blur(); }
      if (e.key !== "Enter" || !input.value.trim()) return;
      await create(input.value.trim());
      const holder = input.closest(".wf-col")?.dataset.col;
      await load();
      // Keep adding: reopen the field in the re-rendered column.
      const again = holder ? document.querySelector(`.wf-col[data-col="${holder}"] [data-act="add-card"]`)
        : document.querySelector('[data-act="add-col"]');
      if (again) again.click();
    }));
  }

  // Drag & drop of cards between and within columns.
  const placeholder = document.createElement("li");
  placeholder.className = "wf-placeholder";

  // Columns: drag by the header; a bar shows where it will go.
  const colPlaceholder = document.createElement("div");
  colPlaceholder.className = "wf-col-placeholder";

  $("wf-board").addEventListener("dragstart", (e) => {
    const col = e.target.closest?.(".wf-card") ? null : e.target.closest?.(".wf-col");  // started outside a card
    if (col) {
      colDragId = Number(col.dataset.col);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "column " + colDragId);
      e.dataTransfer.setDragImage(col, 20, 20);
      setTimeout(() => col.classList.add("dragging"), 0);
      menu.hidden = true;
      return;
    }
    const node = e.target.closest(".wf-card");
    if (!node) return;
    dragId = Number(node.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(dragId));
    setTimeout(() => node.classList.add("dragging"), 0);
    menu.hidden = true;
  });
  $("wf-board").addEventListener("dragend", () => {
    dragId = colDragId = null;
    placeholder.remove();
    colPlaceholder.remove();
    document.querySelectorAll(".wf-card.dragging, .wf-col.dragging, .wf-col.drop-target").forEach((n) => n.classList.remove("dragging", "drop-target"));
  });
  /** The column the dragged one goes before (null = at the end), from the pointer's x. */
  const columnAfter = (x) => [...$("wf-board").querySelectorAll(".wf-col:not(.dragging)")].find((n) => {
    const r = n.getBoundingClientRect();
    return x < r.left + r.width / 2;
  }) || null;
  $("wf-board").addEventListener("dragover", (e) => {
    if (colDragId !== null) {
      e.preventDefault();
      $("wf-board").insertBefore(colPlaceholder, columnAfter(e.clientX) || $("wf-board").querySelector(".wf-add-col"));
      return;
    }
    const col = e.target.closest(".wf-col");
    if (dragId === null || !col) return;
    e.preventDefault();
    document.querySelectorAll(".wf-col.drop-target").forEach((n) => n !== col && n.classList.remove("drop-target"));
    col.classList.add("drop-target");
    const list = col.querySelector(".wf-cards");
    const next = [...list.querySelectorAll(".wf-card:not(.dragging)")].find((n) => {
      const r = n.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (next) list.insertBefore(placeholder, next);
    else list.appendChild(placeholder);
  });
  $("wf-board").addEventListener("drop", attempt(async (e) => {
    if (colDragId !== null) {
      e.preventDefault();
      const moved = colDragId;
      let before = colPlaceholder.nextElementSibling;
      while (before && !before.classList.contains("wf-col")) before = before.nextElementSibling;
      const ids = board.columns.map((c) => c.id).filter((id) => id !== moved);
      const at = before ? ids.indexOf(Number(before.dataset.col)) : ids.length;
      ids.splice(at, 0, moved);
      colPlaceholder.remove();
      colDragId = null;
      board.columns.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      renderBoard();
      await api("POST", "/api/workflow/columns/order", { ids });
      return load();
    }
    const col = e.target.closest(".wf-col");
    if (dragId === null || !col) return;
    e.preventDefault();
    const colId = Number(col.dataset.col);
    // Position among all cards of the column (some may be hidden by a filter).
    const ids = cardsIn(colId).map((c) => c.id).filter((id) => id !== dragId);
    if (placeholder.parentElement !== col.querySelector(".wf-cards")) col.querySelector(".wf-cards").appendChild(placeholder);
    let before = placeholder.nextElementSibling;
    while (before && !before.classList.contains("wf-card")) before = before.nextElementSibling;
    if (before && Number(before.dataset.id) === dragId) before = before.nextElementSibling;
    let after = placeholder.previousElementSibling;
    if (after && Number(after.dataset.id) === dragId) after = after.previousElementSibling;
    const position = before ? ids.indexOf(Number(before.dataset.id))
      : after ? ids.indexOf(Number(after.dataset.id)) + 1 : ids.length;
    const id = dragId;
    dragId = null;  // renderBoard() below detaches the dragged node, so its dragend never reaches the board
    const card = cardById(id);
    const wasRunning = card.running;
    // Show the result right away, then sync.
    ids.splice(position, 0, id);
    card.column_id = colId;
    ids.forEach((cid, i) => (cardById(cid).position = i));
    placeholder.remove();
    renderBoard();
    await api("POST", `/api/workflow/cards/${id}/move`, { column_id: colId, position });
    await load();
    if (wasRunning && !cardById(id)?.running) trackerRefresh();  // moved to a done column: the timer goes on without the card
  }));

  // ---------------------------------------------------------- column menu

  /** The column menu, under its ⋯ button or at (x, y) for a right click. */
  function openColumnMenu(button, colId, x, y) {
    const col = columnById(colId);
    const count = cardsIn(colId).length;
    let color = col.color;
    menu.innerHTML = `
      <div class="wf-menu-label">Edit column</div>
      <label>Name <input type="text" data-f="name" maxlength="100"></label>
      <div class="wf-menu-label">Colour</div>
      <div class="wf-swatches">
        <button type="button" class="wf-swatch none" data-color="" title="No colour" aria-label="No colour"></button>
        ${Object.entries(COLORS).map(([n, c]) => `<button type="button" class="wf-swatch" data-color="${n}" style="--c:${c}" title="${n}" aria-label="${n}"></button>`).join("")}
      </div>
      <label class="row">WIP limit <input type="number" data-f="wip" min="0" max="999"> <span class="muted small">0 = none</span></label>
      <label class="row"><input type="checkbox" data-f="done"> Done column <span class="muted small">(cards here are finished)</span></label>
      <div class="wf-menu-actions"><button class="btn start" data-a="save">Save</button></div>
      <hr>
      <button class="btn link" data-a="archive" ${count ? "" : "disabled"}>Archive all cards (${count})</button>
      <button class="btn link" data-a="delete" style="color:var(--danger)">Delete column</button>`;
    menu.querySelector('[data-f="name"]').value = col.name;
    menu.querySelector('[data-f="wip"]').value = col.wip_limit;
    menu.querySelector('[data-f="done"]').checked = col.is_done;
    const markSwatch = () => menu.querySelectorAll(".wf-swatch").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    markSwatch();
    menu.onkeydown = (e) => { if (e.key === "Enter") menu.querySelector('[data-a="save"]').click(); };
    menu.onclick = attempt(async (e) => {
      const swatch = e.target.closest(".wf-swatch");
      if (swatch) { color = swatch.dataset.color; markSwatch(); return; }
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      if (a === "save") {
        const name = menu.querySelector('[data-f="name"]').value.trim();
        if (!name) return menu.querySelector('[data-f="name"]').focus();
        menu.hidden = true;
        return saveColumn(colId, {
          name, color,
          wip_limit: Number(menu.querySelector('[data-f="wip"]').value) || 0,
          is_done: menu.querySelector('[data-f="done"]').checked,
        });
      }
      if (a === "archive") {
        menu.hidden = true;  // no question: the toast offers Undo
        return archiveCards(cardsIn(colId));
      } else if (a === "delete") {
        if (count) { menu.hidden = true; return showError(`Move or archive the ${count} card${count === 1 ? "" : "s"} in “${col.name}” first.`); }
        if (!await ask(`Delete the column “${col.name}”?`, "")) return;
        await api("DELETE", `/api/workflow/columns/${colId}`);
      }
      menu.hidden = true;
      await load();
    });
    menu.hidden = false;  // so it can be measured
    if (button) {
      const r = button.getBoundingClientRect();
      showMenuAt(r.right - menu.offsetWidth, r.bottom + 4);
    } else showMenuAt(x, y);
    menu.querySelector('[data-f="name"]').focus();
  }

  /** Show the menu at (x, y), kept inside the window; flips up when there's no room below. */
  function showMenuAt(x, y) {
    menu.hidden = false;
    menu.dataset.for = "";
    const viewW = document.documentElement.clientWidth;  // without the scrollbar
    const w = menu.offsetWidth, h = menu.offsetHeight;
    if (y + h > window.innerHeight - 8) y = Math.max(8, y - h);
    menu.style.left = Math.max(8, Math.min(x, viewW - w - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
  }
  let closedFor = "";  // what the last press outside closed: a right click on the same card shouldn't reopen it
  document.addEventListener("mousedown", (e) => {
    closedFor = "";
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="col-menu"], #wf-filter-btn')) {
      closedFor = menu.dataset.for;
      menu.hidden = true;
    }
  });
  $("wf-board").addEventListener("scroll", () => (menu.hidden = true), true);

  // ---------------------------------------------------------- card and column menus (right click)

  $("wf-board").addEventListener("contextmenu", (e) => {
    if (dragId !== null || colDragId !== null || e.target.closest("input, textarea, select")) return;
    const node = e.target.closest(".wf-card");
    if (node) {
      e.preventDefault();
      if (closedFor === "card:" + node.dataset.id) return;  // right click on the card whose menu is open: just close it
      return openCardMenu(cardById(Number(node.dataset.id)), e.clientX, e.clientY);
    }
    const col = e.target.closest(".wf-col");
    if (!col) return;
    e.preventDefault();
    openColumnMenu(null, Number(col.dataset.col), e.clientX, e.clientY);
  });

  function openCardMenu(card, x, y) {
    const others = board.columns.filter((c) => c.id !== card.column_id);
    menu.innerHTML = `
      <button class="btn link" data-a="open"><b>Open</b></button>
      <button class="btn link" data-a="timer">${card.running ? "Stop timer" : board.running ? "Switch timer to this card" : "Start timer"}</button>
      ${others.length ? `<hr><div class="wf-menu-label">Move to</div>
        ${others.map((c) => `<button class="btn link" data-a="move" data-col="${c.id}">${esc(c.name)}</button>`).join("")}` : ""}
      <hr><div class="wf-menu-label">Type</div>
      <div class="wf-menu-row">${Object.entries(TYPES).map(([v, n]) =>
        `<button class="btn link${card.type === v ? " on" : ""}" data-a="type" data-v="${v}"><span class="wf-type ${v}">${I[v]}</span>${n}</button>`).join("")}</div>
      ${board.phases.length ? `<div class="wf-menu-label">Phase</div>
        <select data-a="phase"><option value="">No phase</option>
          ${board.phases.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>` : ""}
      <div class="wf-menu-label">Priority</div>
      <div class="wf-menu-row">${Object.entries(PRIO).map(([v, n]) =>
        `<button class="btn link${card.priority === v ? " on" : ""}" data-a="prio" data-v="${v}">${v ? `<i class="wf-prio ${v}"></i>` : ""}${n}</button>`).join("")}</div>
      <hr>
      <button class="btn link" data-a="duplicate">Duplicate</button>
      <button class="btn link" data-a="archive">Archive</button>
      <button class="btn link" data-a="delete" style="color:var(--danger)">Delete</button>`;
    menu.onkeydown = null;
    /** After an edit: reload, then redraw the menu in place with the card's new values (unless it was closed meanwhile). */
    const stayOpen = async () => {
      const forThis = "card:" + card.id;
      await load();
      const fresh = cardById(card.id);
      if (!menu.hidden && menu.dataset.for === forThis && fresh) openCardMenu(fresh, parseFloat(menu.style.left), parseFloat(menu.style.top));
    };
    const phaseSel = menu.querySelector('select[data-a="phase"]');
    if (phaseSel) phaseSel.value = card.phase_id || "";
    menu.onchange = attempt(async (e) => {
      if (e.target !== phaseSel) return;
      await api("PATCH", `/api/workflow/cards/${card.id}`, { phase_id: Number(phaseSel.value) || null });
      await stayOpen();
    });
    menu.onclick = attempt(async (e) => {
      const btn = e.target.closest("button[data-a]");
      if (!btn) return;
      const a = btn.dataset.a;
      const stays = ["move", "prio", "type"].includes(a);  // edits keep the menu open for the next one
      if (!stays) menu.hidden = true;
      if (a === "open") return openCard(card.id);
      if (a === "timer") return toggleTimer(card);
      if (a === "move") {
        await api("POST", `/api/workflow/cards/${card.id}/move`, { column_id: Number(btn.dataset.col), position: 1e6 });
      } else if (a === "prio") {
        await api("PATCH", `/api/workflow/cards/${card.id}`, { priority: btn.dataset.v });
      } else if (a === "type") {
        await api("PATCH", `/api/workflow/cards/${card.id}`, { type: btn.dataset.v });
      } else if (a === "duplicate") {
        const copy = await api("POST", "/api/workflow/cards", { column_id: card.column_id, title: card.title + " (copy)" });
        await api("PATCH", `/api/workflow/cards/${copy.id}`, {
          description: card.description, priority: card.priority, due_date: card.due_date, estimate: card.estimate,
          labels: card.labels, checklist: card.checklist.map((i) => ({ text: i.text, done: false })),
          type: card.type, phase_id: card.phase_id,
        });
        await api("POST", `/api/workflow/cards/${copy.id}/move`, { column_id: card.column_id, position: card.position + 1 });
      } else if (a === "archive") {
        return archiveCards([card]);
      } else if (a === "delete") {
        if (!await ask(`Delete “${card.title}”?`, "The card is gone for good. Its tracked time stays in the tracker.")) return;
        await api("DELETE", `/api/workflow/cards/${card.id}`);
      }
      if (stays) await stayOpen();
      else await load();
      if (card.running && !["prio", "type", "duplicate"].includes(a)) trackerRefresh();  // a done column or archive takes the timer off the card
    });
    showMenuAt(x, y);
    menu.dataset.for = "card:" + card.id;
  }

  // ---------------------------------------------------------- filters, archive view

  $("wf-q").addEventListener("input", () => { filters.q = $("wf-q").value.trim(); renderBoard(); });

  /** Open the board (if needed) and the card dialog for a new card in the first column that isn't a done column. */
  /** New card in the first column that isn't a done column; it starts with the active filters' values. */
  const newCard = attempt(async (type) => {
    menu.hidden = true;
    if (!isOpen()) await setOpen(true);
    if (!board) await load();
    const col = board.columns.find((c) => !c.is_done) || board.columns[0];
    if (col) openNewCard(col.id, { ...filterDefaults(), ...(TYPES[type] && { type }) });
  });
  $("wf-new").onclick = () => newCard();

  // ---------------------------------------------------------- archive: undo, drawer, restore

  /** Archive cards; the toast offers Undo, which puts them back where they were. */
  async function archiveCards(cards) {
    if (!cards.length) return;
    const wasRunning = cards.some((c) => c.running);
    // Where they are now (index among the visible cards; stored positions can have gaps).
    const places = cards.map((c) => ({ id: c.id, column_id: c.column_id,
      position: cardsIn(c.column_id).findIndex((x) => x.id === c.id) }))
      .sort((a, b) => a.position - b.position);  // restore top-down so each lands at its old index
    await Promise.all(cards.map((c) => api("PATCH", `/api/workflow/cards/${c.id}`, { archived: true })));
    await load();
    if (drawer === "archive") await renderArchive();
    if (wasRunning) trackerRefresh();  // archiving the running card stops its timer
    showToast(cards.length === 1 ? `Archived “${cards[0].title}”` : `Archived ${cards.length} cards`, async () => {
      for (const p of places) await api("POST", `/api/workflow/cards/${p.id}/restore`, p);
      await load();
      if (drawer === "archive") await renderArchive();
      places.forEach((p) => flashCard(p.id));
    });
  }

  /** Back on top of its column (or the column it was parked in when its own was deleted). */
  async function restoreCard(c) {
    await api("POST", `/api/workflow/cards/${c.id}/restore`);
    await load();
    if (drawer === "archive") await renderArchive();
    flashCard(c.id);
    const col = columnById(c.column_id);
    showToast(`Restored “${c.title}”${col ? ` to ${col.name}` : ""}`, () => archiveCards([cardById(c.id)]));
  }

  function flashCard(id) {
    const node = document.querySelector(`.wf-card[data-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    node.classList.remove("wf-flash");
    void node.offsetWidth;  // restart the animation
    node.classList.add("wf-flash");
  }

  let toastTimer;
  const hideToastLater = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => ($("wf-toast").hidden = true), 6000); };
  $("wf-toast").addEventListener("mouseenter", () => clearTimeout(toastTimer));  // stays while you reach for Undo
  $("wf-toast").addEventListener("mouseleave", hideToastLater);
  function showToast(msg, undo) {
    const toast = $("wf-toast");
    toast.querySelector("span").textContent = msg;
    const btn = toast.querySelector("button");
    btn.hidden = !undo;
    btn.onclick = attempt(async () => { toast.hidden = true; await undo(); });
    toast.hidden = false;
    hideToastLater();
  }

  /** Open one side drawer ("archive" | "phases"), or close it (null). */
  async function setDrawer(name) {
    drawer = name;
    if (name === "archive") {
      $("wf-archive-q").value = "";
      await renderArchive();
    }
    render();
    if (name === "archive") $("wf-archive-q").focus();
  }
  $("wf-archive-btn").onclick = attempt(() => setDrawer(drawer === "archive" ? null : "archive"));
  $("wf-phases-btn").onclick = attempt(() => setDrawer(drawer === "phases" ? null : "phases"));
  document.querySelectorAll("[data-close-drawer]").forEach((b) => (b.onclick = () => setDrawer(null)));
  $("wf-archive-q").addEventListener("input", () => renderArchiveList());

  async function renderArchive() {
    archived = await api("GET", "/api/workflow/archive");
    renderArchiveList();
  }

  function renderArchiveList() {
    const ul = $("wf-archive-list");
    const q = $("wf-archive-q").value.trim().toLowerCase();
    const shown = archived.filter((c) => !q || [c.title, c.description, ...c.labels].join(" ").toLowerCase().includes(q));
    ul.innerHTML = shown.length ? "" : `<li class="muted empty">${archived.length ? "No matching cards." : "No archived cards."}</li>`;
    for (const c of shown) {
      const li = document.createElement("li");
      const col = columnById(c.column_id);
      li.title = "Open card";
      li.innerHTML = `<div class="grow"><b></b><div class="small muted">${col ? esc(col.name) : ""}
        ${c.done_at ? " · done " + shortDate(c.done_at.slice(0, 10)) : ""}${c.tracked_seconds ? " · " + fmtDur(c.tracked_seconds) + " tracked" : ""}</div></div>
        <button class="btn ghost" data-a="restore" title="${col ? `Back on top of “${esc(col.name)}”` : "Back on the board"}">Restore</button>
        <button class="btn link" data-a="delete" title="Delete for good" aria-label="Delete for good">${I.trash}</button>`;
      li.querySelector("b").textContent = c.title;
      li.onclick = attempt(async (e) => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (a === "restore") return restoreCard(c);
        if (a === "delete") {
          if (!await ask(`Delete “${c.title}”?`, "The card is gone for good. Its tracked time stays in the tracker.")) return;
          await api("DELETE", `/api/workflow/cards/${c.id}`);
          await load();
          return renderArchive();
        }
        openArchivedCard(c);
      });
      ul.appendChild(li);
    }
  }

  // ---------------------------------------------------------- phases drawer

  let editingPhase = null;  // id of the phase whose edit form is open (the list isn't redrawn meanwhile)
  let phaseDragId = null;

  function renderPhases() {
    if (editingPhase !== null) return;
    const ul = $("wf-phase-list");
    ul.innerHTML = board.phases.length ? ""
      : `<li class="muted empty">No phases yet. Add the steps until your release below, e.g. Alpha, Beta, Release 1.0.</li>`;
    for (const p of board.phases) {
      const li = document.createElement("li");
      li.className = "wf-phase" + (filters.phase === String(p.id) ? " active" : "") + (p.released_at ? " released" : "");
      li.draggable = true;
      li.dataset.id = p.id;
      li.title = filters.phase === String(p.id) ? "Show all cards again" : "Show only this phase's cards";
      let when = "";
      if (p.released_at) when = `released ${shortDate(p.released_at.slice(0, 10))}`;
      else if (p.target_date) {
        const days = Math.round((parseYmd(p.target_date) - parseYmd(board.today)) / 86400000);
        when = `<span class="${days < 0 ? "overdue" : days <= 7 ? "due-soon" : ""}">target ${shortDate(p.target_date)}${days < 0 ? " · overdue" : ""}</span>`;
      }
      li.innerHTML = `<span class="wf-grip">${I.grip}</span>
        <div class="grow">
          <div class="wf-phase-name"><b></b>${p.released_at ? `<span class="wf-badge">Released</span>` : ""}</div>
          <div class="small muted">${p.total ? `${p.done}/${p.total} done` : "no cards yet"}${when ? " · " + when : ""}</div>
          <div class="wf-progress"><div style="width:${p.total ? (p.done / p.total) * 100 : 0}%"></div></div>
        </div>
        ${filters.phase === String(p.id) ? `<button class="btn link wf-show-all" data-a="all" title="Show all cards again">${I.x}Show all</button>` : ""}
        <button class="btn link" data-a="edit" title="Edit phase" aria-label="Edit phase">${I.edit}</button>`;
      li.querySelector("b").textContent = p.name;
      ul.appendChild(li);
    }
  }

  $("wf-phase-list").addEventListener("click", (e) => {
    const li = e.target.closest(".wf-phase");
    if (!li || li.classList.contains("editing")) return;
    const p = phaseById(Number(li.dataset.id));
    if (e.target.closest('[data-a="edit"]')) return editPhase(li, p);
    if (e.target.closest('[data-a="all"]')) return setFilter("phase", "");
    setFilter("phase", filters.phase === String(p.id) ? "" : String(p.id));
  });

  function editPhase(li, p) {
    editingPhase = p.id;
    li.classList.add("editing");
    li.draggable = false;
    li.title = "";
    li.innerHTML = `<div class="wf-phase-form">
        <input data-f="name" maxlength="100" aria-label="Phase name">
        <label class="row">Target <input type="date" data-f="target"></label>
        <label class="row"><input type="checkbox" data-f="released"> Released</label>
        <div class="row">
          <button class="btn link danger" data-a="delete">Delete</button>
          <span class="spacer" style="flex:1"></span>
          <button class="btn ghost" data-a="cancel">Cancel</button>
          <button class="btn start" data-a="save">Save</button>
        </div></div>`;
    const f = (k) => li.querySelector(`[data-f="${k}"]`);
    f("name").value = p.name;
    f("target").value = p.target_date || "";
    f("released").checked = !!p.released_at;
    f("name").focus();
    const close = async () => { editingPhase = null; await load(); };
    const save = attempt(async () => {
      if (!f("name").value.trim()) return f("name").focus();
      await api("PATCH", `/api/workflow/phases/${p.id}`,
        { name: f("name").value, target_date: f("target").value || null, released: f("released").checked });
      await close();
    });
    li.onclick = attempt(async (e) => {
      const a = e.target.closest("button[data-a]")?.dataset.a;
      if (a === "save") return save();
      if (a === "cancel") return close();
      if (a === "delete") {
        if (!await ask(`Delete the phase “${p.name}”?`, p.total ? "Its cards stay on the board, without a phase." : "")) return;
        await api("DELETE", `/api/workflow/phases/${p.id}`);
        if (filters.phase === String(p.id)) filters.phase = "";
        await close();
      }
    });
    li.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
  }

  $("wf-phase-new").addEventListener("keydown", attempt(async (e) => {
    const name = e.target.value.trim();
    if (e.key !== "Enter" || !name) return;
    e.target.value = "";  // right away, so the next name can be typed while this one saves
    try {
      await api("POST", "/api/workflow/phases", { name });
    } catch (err) {
      if (!e.target.value) e.target.value = name;
      throw err;
    }
    await load();
  }));

  // Reorder phases by dragging.
  $("wf-phase-list").addEventListener("dragstart", (e) => {
    const li = e.target.closest(".wf-phase");
    if (!li) return;
    phaseDragId = Number(li.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "phase " + phaseDragId);
    setTimeout(() => li.classList.add("dragging"), 0);
  });
  $("wf-phase-list").addEventListener("dragover", (e) => {
    if (phaseDragId === null) return;
    e.preventDefault();
    const ul = $("wf-phase-list"), dragged = ul.querySelector(".wf-phase.dragging");
    if (!dragged) return;
    const next = [...ul.querySelectorAll(".wf-phase:not(.dragging)")].find((n) => {
      const r = n.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    ul.insertBefore(dragged, next || null);
  });
  $("wf-phase-list").addEventListener("drop", attempt(async (e) => {
    if (phaseDragId === null) return;
    e.preventDefault();
    phaseDragId = null;
    const ids = [...$("wf-phase-list").querySelectorAll(".wf-phase")].map((n) => Number(n.dataset.id));
    await api("POST", "/api/workflow/phases/order", { ids });
    await load();
  }));
  $("wf-phase-list").addEventListener("dragend", () => {
    phaseDragId = null;
    $("wf-phase-list").querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
  });

  // ---------------------------------------------------------- command palette (⌘K / Ctrl+K)

  const palette = { cmd: null, args: [], items: [], active: 0 };

  async function patchCard(card, fields) {
    await api("PATCH", `/api/workflow/cards/${card.id}`, fields);
    await load();
  }
  async function moveCardTo(card, colId) {
    await api("POST", `/api/workflow/cards/${card.id}/move`, { column_id: colId, position: 1e6 });
    await load();
    if (card.running) trackerRefresh();  // a done column takes the timer off the card
  }

  /** Every command; `steps` ask for a card, column, type, phase, label or priority first, then run(…picks). */
  function commands() {
    const running = board.running_card_id && cardById(board.running_card_id);
    const wide = document.body.classList.contains("wf-wide");
    return [
      { label: "New card", hint: "A", icon: I.task, run: () => newCard("task") },
      { label: "New bug", icon: I.bug, keys: "report", run: () => newCard("bug") },
      { label: "New issue", icon: I.issue, run: () => newCard("issue") },
      running && { label: `Stop timer · ${running.title}`, icon: I.stop, run: () => toggleTimer(running) },
      { label: "Start timer on…", icon: I.play, keys: "track work", steps: ["card"], run: (c) => !c.running && toggleTimer(c) },
      { label: "Open card…", icon: I.text, keys: "edit details", steps: ["card"], run: (c) => openCard(c.id) },
      { label: "Move card to…", icon: I.board, keys: "column done", steps: ["card", "column"], run: moveCardTo },
      { label: "Set type of…", icon: I.bug, keys: "bug issue task", steps: ["card", "type"], run: (c, t) => patchCard(c, { type: t }) },
      board.phases.length && { label: "Set phase of…", icon: I.flag, keys: "milestone", steps: ["card", "phase"], run: (c, p) => patchCard(c, { phase_id: p }) },
      { label: "Filter by type…", icon: I.filter, keys: "bugs issues tasks", steps: ["type"], run: (t) => setFilter("type", t) },
      board.phases.length && { label: "Filter by phase…", icon: I.filter, keys: "milestone", steps: ["phase"], run: (p) => setFilter("phase", p === null ? "none" : String(p)) },
      allLabels().length && { label: "Filter by label…", icon: I.filter, steps: ["label"], run: (l) => setFilter("label", l) },
      { label: "Filter by priority…", icon: I.filter, steps: ["prio"], run: (v) => setFilter("prio", v) },
      FILTER_KEYS.some((k) => filters[k]) && { label: "Clear filters", icon: I.x, run: clearFilters },
      { label: "Search cards", icon: I.search, keys: "find", run: () => $("wf-q").focus() },
      { label: "Show phases", icon: I.flag, keys: "milestones release roadmap", run: () => setDrawer("phases") },
      { label: "Add phase", icon: I.flag, keys: "milestone release", run: async () => { await setDrawer("phases"); $("wf-phase-new").focus(); } },
      { label: "Show archive", icon: I.trash, keys: "restore archived", run: () => setDrawer("archive") },
      { label: "Add column", icon: I.board, run: () => $("wf-board").querySelector('[data-act="add-col"]')?.click() },
      { label: wide ? "Narrow board" : "Full width board", icon: wide ? I.narrow : I.wide, run: () => setWide(!wide) },
      { label: isOpen() ? "Close board" : "Open board", hint: "W", icon: I.board, noOpen: true, run: () => setOpen(!isOpen()) },
      // The tracker's own pages and buttons, so the palette reaches them too.
      { label: "Open dashboard", icon: I.chart, keys: "statistics stats charts", noOpen: true, run: () => { location.href = "/stats"; } },
      document.getElementById("update-check") && { label: "Check for updates", icon: I.update, keys: "update upgrade version settings",
        noOpen: true, run: () => {
          document.getElementById("settings-btn").click();  // opens Settings and checks GitHub
          document.getElementById("update-status").scrollIntoView({ block: "center" });
        } },
    ].filter(Boolean);
  }

  /** The choices for one step (picks made so far in `args`). */
  function stepOptions(step, args) {
    if (step === "card") {
      return board.cards.map((c) => ({ label: c.title, value: c, icon: I[c.type],
        hint: columnById(c.column_id)?.name, keys: c.labels.join(" ") }));
    }
    if (step === "column") return board.columns.filter((c) => c.id !== args[0]?.column_id).map((c) => ({ label: c.name, value: c.id, icon: I.board }));
    if (step === "type") return Object.entries(TYPES).map(([v, n]) => ({ label: n, value: v, icon: I[v] }));
    if (step === "phase") return [{ label: "No phase", value: null, icon: I.x }, ...board.phases.map((p) => ({ label: p.name, value: p.id, icon: I.flag, hint: `${p.done}/${p.total}` }))];
    if (step === "label") return allLabels().map((l) => ({ label: l, value: l, icon: I.filter }));
    if (step === "prio") return Object.entries(PRIO).map(([v, n]) => ({ label: n === "None" ? "No priority" : n, value: v, icon: I.filter }));
    return [];
  }
  const STEP_PROMPT = { card: "Pick a card…", column: "Pick a column…", type: "Pick a type…", phase: "Pick a phase…",
    label: "Pick a label…", prio: "Pick a priority…" };

  function matchScore(item, q) {
    if (!q) return 1;
    const label = item.label.toLowerCase(), hay = label + " " + (item.keys || "").toLowerCase() + " " + (item.hint || "").toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    if (!words.every((w) => hay.includes(w))) return 0;
    return label.startsWith(q) ? 3 : label.includes(q) ? 2 : 1;
  }

  function renderPalette() {
    const q = $("wf-cmdk-q").value.trim().toLowerCase();
    let items;
    if (palette.cmd) {
      const step = palette.cmd.steps[palette.args.length];
      items = stepOptions(step, palette.args).map((o) => ({ ...o, group: STEP_PROMPT[step].replace("…", "") }));
      $("wf-cmdk-q").placeholder = STEP_PROMPT[step];
    } else {
      items = commands().map((c) => ({ ...c, group: "Commands" }));
      if (q) items.push(...board.cards.map((c) => ({ label: c.title, icon: I[c.type], group: "Cards", keys: c.labels.join(" "),
        hint: columnById(c.column_id)?.name, run: () => openCard(c.id) })));
      $("wf-cmdk-q").placeholder = "Type a command or search cards…";
    }
    const groups = [...new Set(items.map((it) => it.group))];  // keep group order; best matches first inside each
    items = items.map((it, i) => ({ it, i, score: matchScore(it, q) })).filter((x) => x.score)
      .sort((a, b) => groups.indexOf(a.it.group) - groups.indexOf(b.it.group) || b.score - a.score || a.i - b.i)
      .map((x) => x.it);
    palette.items = items.slice(0, 60);
    palette.active = Math.min(palette.active, Math.max(0, palette.items.length - 1));
    const crumb = $("wf-cmdk-crumb");
    crumb.hidden = !palette.cmd;
    if (palette.cmd) crumb.textContent = [palette.cmd.label.replace("…", ""), ...palette.args.map((a) => a?.title ?? "")].filter(Boolean).join(" › ");
    const ul = $("wf-cmdk-list");
    ul.innerHTML = palette.items.length ? "" : `<li class="empty">Nothing found</li>`;
    let group = null;
    palette.items.forEach((it, i) => {
      if (it.group !== group) { group = it.group; ul.insertAdjacentHTML("beforeend", `<li class="group">${esc(group)}</li>`); }
      const li = document.createElement("li");
      li.className = "item" + (i === palette.active ? " active" : "");
      li.dataset.i = i;
      li.setAttribute("role", "option");
      li.innerHTML = `<span class="ic">${it.icon || ""}</span><span class="lbl"></span>${it.hint ? `<span class="hint"></span>` : ""}`;
      li.querySelector(".lbl").textContent = it.label;
      if (it.hint) li.querySelector(".hint").textContent = it.hint;
      ul.appendChild(li);
    });
    ul.querySelector(".item.active")?.scrollIntoView({ block: "nearest" });
  }

  async function openPalette() {
    menu.hidden = true;
    if (!board) await load();
    palette.cmd = null;
    palette.args = [];
    palette.active = 0;
    $("wf-cmdk-q").value = "";
    renderPalette();
    $("wf-cmdk").showModal();
    $("wf-cmdk-q").focus();
  }
  const closePalette = () => $("wf-cmdk").close();

  const choose = attempt(async (i) => {
    const it = palette.items[i];
    if (!it) return;
    if (!palette.cmd && it.steps) {  // first pick of a multi-step command
      palette.cmd = it;
      palette.args = [];
    } else if (palette.cmd) {
      palette.args.push(it.value);
    }
    if (palette.cmd && palette.args.length < palette.cmd.steps.length) {
      palette.active = 0;
      $("wf-cmdk-q").value = "";
      return renderPalette();
    }
    const cmd = palette.cmd || it, args = palette.args;
    closePalette();
    if (!cmd.noOpen && !isOpen()) await setOpen(true);
    await cmd.run(...args);
  });

  $("wf-cmdk-q").addEventListener("input", () => { palette.active = 0; renderPalette(); });
  $("wf-cmdk-q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = palette.items.length;
      if (n) palette.active = (palette.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(palette.active);
    } else if (e.key === "Backspace" && !e.target.value && palette.cmd) {  // one step back
      e.preventDefault();
      if (palette.args.length) palette.args.pop(); else palette.cmd = null;
      palette.active = 0;
      renderPalette();
    }
  });
  $("wf-cmdk-list").addEventListener("mousemove", (e) => {
    const li = e.target.closest(".item");
    if (li && Number(li.dataset.i) !== palette.active) { palette.active = Number(li.dataset.i); renderPalette(); }
  });
  $("wf-cmdk-list").addEventListener("click", (e) => { const li = e.target.closest(".item"); if (li) choose(Number(li.dataset.i)); });
  closeOnBackdrop($("wf-cmdk"), closePalette);
  $("wf-cmdk-btn").onclick = () => openPalette();

  // ⌘K (Mac) / Ctrl+K: open or close the palette from anywhere on the page.
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "k" || !(MAC ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return;
    e.preventDefault();
    if ($("wf-cmdk").open) closePalette();
    else if (!document.querySelector("dialog[open]")) openPalette();
  });

  // ---------------------------------------------------------- card dialog

  function openCard(id) {
    const card = cardById(id);
    fillDialog({ ...card, checklist: card.checklist.map((i) => ({ ...i })) });
  }
  const openArchivedCard = (c) => fillDialog({ ...c, checklist: c.checklist.map((i) => ({ ...i })) });

  /** The card dialog for a card that doesn't exist yet; Save creates it (Cancel leaves nothing behind). */
  function openNewCard(columnId, extra = {}) {
    fillDialog({ id: null, column_id: columnId, title: "", description: "", priority: "", due_date: null,
      estimate: 0, labels: [], checklist: [], type: "task", phase_id: null, ...extra });
  }

  function fillDialog(card) {
    editing = card;
    const isNew = card.id === null;
    for (const id of ["wf-f-time", "wf-f-sessions-box", "wf-f-delete", "wf-f-archive"]) $(id).hidden = isNew;
    $("wf-f-save").textContent = isNew ? "Add card" : "Save";
    $("wf-f-archive").textContent = card.archived ? "Restore" : "Archive";
    $("wf-f-title").value = card.title;
    $("wf-f-desc").value = card.description;
    $("wf-f-col").innerHTML = board.columns.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("wf-f-col").value = card.column_id;
    $("wf-f-prio").value = card.priority;
    $("wf-f-type").value = card.type;
    $("wf-f-phase").innerHTML = `<option value="">No phase</option>` +
      board.phases.map((p) => `<option value="${p.id}">${esc(p.name)}${p.released_at ? " (released)" : ""}</option>`).join("");
    $("wf-f-phase").value = card.phase_id || "";
    $("wf-f-phase-box").hidden = !board.phases.length;
    $("wf-f-due").value = card.due_date || "";
    $("wf-f-est").value = card.estimate ? card.estimate / 3600 : "";
    $("wf-f-labels").value = card.labels.join(", ");
    $("wf-f-check-new").value = "";
    $("wf-f-error").textContent = "";
    $("wf-f-sessions-box").open = false;
    renderChecklist();
    if (!isNew) {
      renderCardTime();
      loadCardSessions();
    }
    dialog.showModal();
    $("wf-f-title").focus();
  }

  function renderCardTime() {
    const card = cardById(editing.id) || editing;
    const sec = tracked(card);
    $("wf-f-tracked").textContent = fmtDur(sec);
    $("wf-f-est-note").textContent = card.estimate
      ? (sec > card.estimate ? `${fmtDur(sec - card.estimate)} over the ${hours(card.estimate)} estimate`
        : `of ${hours(card.estimate)} estimate · ${fmtDur(card.estimate - sec)} left`) : "";
    const btn = $("wf-f-timer");
    btn.textContent = card.running ? "Stop timer" : board.running ? "Switch timer to this card" : "Start timer";
    btn.className = "btn " + (card.running ? "stop" : "start");
    btn.hidden = !!editing.archived;  // restore it first to work on it
    $("wf-f-link").hidden = !board.running || card.running || !!editing.archived;  // timer started elsewhere → count it here
  }

  async function loadCardSessions() {
    const id = editing.id;
    const sessions = await api("GET", `/api/workflow/cards/${id}/sessions`);
    if (!editing || editing.id !== id) return;
    $("wf-f-sessions-sum").textContent = `Sessions (${sessions.length})`;
    const ul = $("wf-f-sessions");
    ul.innerHTML = sessions.length ? "" : `<li class="muted">No time tracked on this card yet.</li>`;
    for (const s of sessions) {
      const li = document.createElement("li");
      const day = parseYmd(s.start_time.slice(0, 10)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      li.innerHTML = `<span>${day}</span><span>${s.start_time.slice(11, 16)} – ${s.running ? "now" : s.end_time.slice(11, 16)}</span>
        <span class="grow">${fmtDur(s.seconds)}</span><button type="button" class="btn link" title="Stop counting this session towards the card (it stays in the tracker)">Unlink</button>`;
      li.querySelector("button").onclick = attempt(async () => {
        await api("DELETE", `/api/workflow/sessions/${s.id}`);
        await load();
        renderCardTime();
        await loadCardSessions();
      });
      ul.appendChild(li);
    }
  }

  function renderChecklist() {
    const ul = $("wf-f-checklist");
    ul.innerHTML = "";
    editing.checklist.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = item.done ? "done" : "";
      li.innerHTML = `<input type="checkbox"><input type="text" maxlength="300"><button type="button" class="btn link" aria-label="Remove">${I.x}</button>`;
      const [box, text] = li.querySelectorAll("input");
      box.checked = item.done;
      text.value = item.text;
      box.onchange = () => { item.done = box.checked; li.className = item.done ? "done" : ""; checkCount(); };
      text.oninput = () => (item.text = text.value);
      li.querySelector("button").onclick = () => { editing.checklist.splice(i, 1); renderChecklist(); };
      ul.appendChild(li);
    });
    checkCount();
  }
  const checkCount = () => {
    const n = editing.checklist.length;
    const done = editing.checklist.filter((i) => i.done).length;
    $("wf-f-check-count").textContent = n ? `${done}/${n}` : "";
    $("wf-f-check-bar").hidden = !n;
    $("wf-f-check-bar").firstChild.style.width = n ? (done / n) * 100 + "%" : "0";
  };

  $("wf-f-check-new").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();  // don't submit the form
    const text = $("wf-f-check-new").value.trim();
    if (!text) return;
    editing.checklist.push({ text, done: false });
    $("wf-f-check-new").value = "";
    renderChecklist();
  });

  const closeDialog = () => { dialog.close(); editing = null; };
  $("wf-f-x").onclick = closeDialog;
  $("wf-f-cancel").onclick = closeDialog;
  dialog.addEventListener("cancel", () => (editing = null));  // Esc
  closeOnBackdrop(dialog, closeDialog);  // a click around the card, like Esc

  // Enter with nothing to type into focused (blank space, a checkbox): save and close the card.
  // (Listens on the document: a click on blank space can leave focus on <body>, outside the dialog.)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || !dialog.open) return;
    const el = document.activeElement;
    const ownsEnter = (el.tagName === "INPUT" && el.type !== "checkbox") || /^(TEXTAREA|SELECT|BUTTON|SUMMARY|A)$/.test(el.tagName);
    if (ownsEnter || !editing) return;
    e.preventDefault();
    $("wf-form").requestSubmit();
  });

  $("wf-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const est = Number($("wf-f-est").value);
    const fields = {
      title: $("wf-f-title").value,
      description: $("wf-f-desc").value,
      priority: $("wf-f-prio").value,
      type: $("wf-f-type").value,
      phase_id: Number($("wf-f-phase").value) || null,
      due_date: $("wf-f-due").value || null,
      estimate: est > 0 ? Math.round(est * 3600) : 0,
      labels: $("wf-f-labels").value.split(","),
      checklist: editing.checklist,
    };
    const colId = Number($("wf-f-col").value);
    try {
      if (editing.id === null) {  // new card: one request, on top of the chosen column
        await api("POST", "/api/workflow/cards", { ...fields, column_id: colId });
        closeDialog();
        await load();
        return;
      }
      const id = editing.id;
      const wasRunning = !!cardById(id)?.running;  // archived cards aren't on the board
      await api("PATCH", `/api/workflow/cards/${id}`, fields);
      if (colId !== editing.column_id) await api("POST", `/api/workflow/cards/${id}/move`, { column_id: colId, position: 1e6 });
      closeDialog();
      await load();
      if (drawer === "archive") await renderArchive();
      if (wasRunning) trackerRefresh();  // title is the tracker's note; a done column takes the timer off the card
    } catch (err) {
      $("wf-f-error").textContent = err.message;
    }
  });

  $("wf-f-timer").onclick = attempt(async () => {
    await toggleTimer(cardById(editing.id));
    renderCardTime();
    await loadCardSessions();
  });
  $("wf-f-link").onclick = attempt(async () => {
    await api("POST", `/api/workflow/cards/${editing.id}/link`);
    await load();
    trackerRefresh();
    renderCardTime();
    await loadCardSessions();
  });
  $("wf-f-archive").onclick = attempt(async () => {
    const card = editing.archived ? editing : cardById(editing.id);
    closeDialog();
    await (card.archived ? restoreCard(card) : archiveCards([card]));
  });
  $("wf-f-delete").onclick = attempt(async () => {
    if (!await ask(`Delete “${editing.title || "this card"}”?`, "The card is gone for good. Its tracked time stays in the tracker.")) return;
    const wasRunning = cardById(editing.id)?.running;
    await api("DELETE", `/api/workflow/cards/${editing.id}`);
    closeDialog();
    await load();
    if (drawer === "archive") await renderArchive();
    if (wasRunning) trackerRefresh();
  });

  // ---------------------------------------------------------- stay in sync with the tracker page

  // Start/Stop and entry edits on the tracker page change what runs; catch up right after (the loader
  // keeps the tab's dot current while the board is closed).
  for (const id of ["toggle", "session-form"]) {
    const el = $(id);
    if (el) el.addEventListener(id === "toggle" ? "click" : "submit", () => setTimeout(() => { if (isOpen()) load().catch(() => {}); }, 400));
  }

  const busy = () => dragId !== null || (panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT"
    && document.activeElement.id !== "wf-q");

  // No polling: the tracker page holds a request open and fires tracker:changed when anything changed
  // (e.g. Start/Stop from the menu bar). The 1 s clock runs only while open, visible and timing.
  let catchUp = null;  // a change came while dragging or typing: reload once that's over
  document.addEventListener("tracker:changed", function reload() {
    clearTimeout(catchUp);
    if (!isOpen() || document.hidden) return;  // opening / showing the board loads it anyway
    if (busy() || !menu.hidden) catchUp = setTimeout(reload, 2000);
    else load(true).catch(() => {});
  });
  function schedule() {
    const ticking = isOpen() && !document.hidden && !!board?.running;
    if (ticking && !tickTimer) tickTimer = setInterval(tick, 1000);
    if (!ticking && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }
  document.addEventListener("visibilitychange", () => {
    schedule();
    if (!document.hidden && isOpen()) load(true).catch(() => {});  // catch up after being away
  });

  setWide(store.get("wide") === "1");
  if (store.get("open") === "1") setOpen(true);

  window.Workflow = { setOpen, newCard, openPalette };  // for workflow-boot.js
})();
