"use strict";

const $ = (id) => document.getElementById(id);
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let status = null;        // last /api/status response
let fetchedAt = 0;        // Date.now() when status was fetched (wall clock: keeps counting through sleep)
let selectedDay = null;   // "YYYY-MM-DD" shown in the day panel
let editingId = null;     // session id being edited in the form

// ------------------------------------------------------------ helpers

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

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekdayIdx = (d) => (d.getDay() + 6) % 7; // Monday = 0

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${pad2(m)}m`;
}

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}

function fmtLongDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

const hhmm = (iso) => iso.slice(11, 16);

function level(sec) {
  if (sec <= 0) return 0;
  const h = sec / 3600;
  if (h < 2) return 1;
  if (h < 5) return 2;
  if (h < 8) return 3;
  return 4;
}

// ------------------------------------------------------------ status + timer

const canNotify = () => "Notification" in window && Notification.permission === "granted";
let seenReminder = null;
/** Show a notification. Never close or replace one from code (no `tag`, no `close()`): Firefox on
 *  macOS gives all its notifications the same identity, so removing an old one also swallows the
 *  banner of the next. Only a click closes it. */
function notify(title, body) {
  const n = new Notification(title, { body });
  n.onclick = () => { window.focus(); $("note").focus(); n.close(); };
}

async function loadStatus() {
  status = await api("GET", "/api/status" + (canNotify() ? "?notify=1" : ""));
  // The server updates `last_reminder` when you come back with no timer running (or on a test).
  if (seenReminder !== null && status.last_reminder !== seenReminder && canNotify()) {
    if (status.reminder_kind === "test") notify("Work Tracker – test notification", "It works! Reminders will look like this.");
    else notify("Work Tracker – Working?", "No timer running — click to start.");
  }
  seenReminder = status.last_reminder;
  fetchedAt = Date.now();
  if (!document.hidden) { renderStatus(); renderWeek(); }  // visibilitychange catches up
}

/** Seconds elapsed since the status was fetched (only counts while running). */
function liveExtra() {
  return status && status.running ? (Date.now() - fetchedAt) / 1000 : 0;
}

function renderStatus() {
  if (!status) return;
  const extra = liveExtra();
  const run = status.running;

  // Timer
  $("clock").textContent = fmtClock(run ? run.seconds + extra : 0);
  $("since").textContent = run
    ? `Running since ${hhmm(run.start_time)}${run.note ? " · " + run.note : ""}`
    : "Timer stopped";
  const btn = $("toggle");
  btn.textContent = run ? "Stop" : "Start";
  btn.className = "btn " + (run ? "stop" : "start");
  const noteEl = $("note");
  if (run && document.activeElement !== noteEl) noteEl.value = run.note;

  // Today
  const todaySec = status.today_seconds + extra;
  const todayTarget = status.daily_target;
  $("today-worked").textContent = fmtDur(todaySec);
  $("today-target").textContent = todayTarget ? fmtDur(todayTarget).replace(" 00m", "") : "0h";
  $("today-bar").style.width = todayTarget ? Math.min(100, (todaySec / todayTarget) * 100) + "%" : "0";
  const todayLeft = Math.max(0, todayTarget - todaySec);
  if (!todayTarget) {
    $("today-remaining").textContent = "Weekend — no target today";
  } else if (todayLeft <= 0) {
    $("today-remaining").textContent = `Done! ${fmtDur(todaySec - todayTarget)} overtime`;
  } else {
    let txt = `${fmtDur(todayLeft)} left`;
    if (run) {
      const end = new Date(Date.now() + todayLeft * 1000);
      txt += ` · finished at ${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
    }
    $("today-remaining").textContent = txt;
  }

  // Week
  const weekSec = status.week_seconds + extra;
  $("week-worked").textContent = fmtDur(weekSec);
  $("week-target").textContent = hours(status.weekly_target);
  $("week-bar").style.width = status.weekly_target ? Math.min(100, (weekSec / status.weekly_target) * 100) + "%" : "0";
  const weekLeft = status.weekly_target - weekSec;
  $("week-remaining").textContent = weekLeft > 0
    ? `${fmtDur(weekLeft)} left this week`
    : `Done! ${fmtDur(-weekLeft)} overtime this week`;

  // Balance
  showBalance($("balance"), status.balance_seconds);
  showBalance($("balance-today"), status.balance_seconds + todaySec - todayTarget);
}

function showBalance(el, bal) {
  bal = Math.trunc(bal);
  el.textContent = (bal > 0 ? "+" : bal < 0 ? "−" : "±") + fmtDur(Math.abs(bal));
  el.className = "value " + (bal > 0 ? "positive" : bal < 0 ? "negative" : "");
}

function renderWeek() {
  const wrap = $("week");
  wrap.innerHTML = "";
  const maxSec = Math.max(10 * 3600, ...status.week_days.map((d) => d.seconds + (d.date === status.today ? liveExtra() : 0)));
  status.week_days.forEach((d, i) => {
    const sec = d.seconds + (d.date === status.today ? liveExtra() : 0);
    const col = document.createElement("div");
    col.className = "day-col" + (d.date === status.today ? " today" : "");
    col.innerHTML = `
      <div class="track">
        <div class="fill" style="height:${(sec / maxSec) * 100}%"></div>
        ${d.target ? `<div class="goal" style="bottom:${(d.target / maxSec) * 100}%"></div>` : ""}
      </div>
      <div class="name">${DAY_NAMES[i]}</div>
      <div class="hours">${fmtDur(sec)}</div>`;
    col.addEventListener("click", () => selectDay(d.date));
    wrap.appendChild(col);
  });
}

$("toggle").addEventListener("click", async () => {
  try {
    if (status && status.running) {
      await api("POST", "/api/stop", { note: $("note").value });
      $("note").value = "";
    } else {
      await api("POST", "/api/start", { note: $("note").value });
    }
    await refreshAll();
  } catch (e) {
    alert(e.message);
  }
});

// While running, the note field edits the running session's note (saved on Enter / blur).
async function saveRunningNote() {
  const run = status && status.running;
  if (!run || $("note").value.trim() === run.note) return;
  try {
    await api("PATCH", `/api/sessions/${run.id}`, { note: $("note").value });
    await loadStatus();
    if (selectedDay === status.today) await loadDay();
  } catch (e) {
    alert(e.message);
  }
}

$("note").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (status && status.running) $("note").blur();
  else $("toggle").click();
});
$("note").addEventListener("blur", saveRunningNote);

// ------------------------------------------------------------ heatmap

function heatmapRange() {
  const today = parseYmd(status.today);
  const v = $("year-select").value;
  if (v === "last") return { start: addDays(today, -364), end: today, label: "in the last year" };
  const y = Number(v);
  return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), label: `in ${y}` };
}

function fillYearSelect() {
  const sel = $("year-select");
  const current = sel.value || "last";
  const thisYear = parseYmd(status.today).getFullYear();
  sel.innerHTML = `<option value="last">Last 12 months</option>`;
  for (let y = thisYear; y >= status.first_year; y--) {
    sel.insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
  }
  sel.value = [...sel.options].some((o) => o.value === current) ? current : "last";
}

async function renderHeatmap() {
  const today = parseYmd(status.today);
  const { start, end, label } = heatmapRange();
  const fetchEnd = end > today ? today : end;
  const totals = await api("GET", `/api/days?from=${ymd(start)}&to=${ymd(fetchEnd)}`);

  const grid = $("heatmap");
  grid.innerHTML = "";

  // Weekday labels in column 1
  ["Mon", "", "Wed", "", "Fri", "", ""].forEach((name, i) => {
    const el = document.createElement("div");
    el.className = "weekday";
    el.style.gridRow = i + 2;
    el.textContent = name;
    grid.appendChild(el);
  });

  const gridStart = addDays(start, -weekdayIdx(start));
  const gridEnd = addDays(end, 6 - weekdayIdx(end));
  let total = 0, activeDays = 0, lastMonthCol = -10;

  for (let i = 0, d = gridStart; d <= gridEnd; i++, d = addDays(gridStart, i)) {
    const col = 2 + Math.floor(i / 7);
    const key = ymd(d);
    const inRange = d >= start && d <= end;
    const sec = totals[key] || 0;

    // Month label where a month begins (or at the very first column)
    if (inRange && (d.getDate() === 1 || d.getTime() === start.getTime()) && col - lastMonthCol >= 3) {
      const m = document.createElement("div");
      m.className = "month";
      m.style.gridColumn = `${col} / span 3`;
      m.textContent = MONTHS[d.getMonth()];
      grid.appendChild(m);
      lastMonthCol = col;
    }

    const cell = document.createElement("div");
    cell.style.gridColumn = col;
    cell.style.gridRow = weekdayIdx(d) + 2;
    if (!inRange) {
      cell.className = "cell pad";
    } else if (d > today) {
      cell.className = "cell future";
    } else {
      cell.className = `cell l${level(sec)}` + (key === selectedDay ? " selected" : "");
      cell.dataset.date = key;
      cell.dataset.sec = sec;
      total += sec;
      if (sec > 0) activeDays++;
    }
    grid.appendChild(cell);
  }

  $("heatmap-title").textContent = `${fmtDur(total)} worked ${label}`;
  $("heatmap-summary").textContent = `${activeDays} active day${activeDays === 1 ? "" : "s"}`;
}

const tooltip = $("tooltip");
$("heatmap").addEventListener("mouseover", (e) => {
  const c = e.target.closest(".cell[data-date]");
  if (!c) { tooltip.hidden = true; return; }
  const sec = Number(c.dataset.sec);
  tooltip.textContent = `${sec ? fmtDur(sec) : "No work"} on ${fmtLongDate(parseYmd(c.dataset.date))}`;
  const r = c.getBoundingClientRect();
  tooltip.style.left = r.left + r.width / 2 + "px";
  tooltip.style.top = r.top - 6 + "px";
  tooltip.hidden = false;
});
$("heatmap").addEventListener("mouseleave", () => (tooltip.hidden = true));
$("heatmap").addEventListener("click", (e) => {
  const c = e.target.closest(".cell[data-date]");
  if (c) selectDay(c.dataset.date);
});
$("year-select").addEventListener("change", renderHeatmap);

// ------------------------------------------------------------ day panel + manual entries

async function selectDay(day) {
  selectedDay = day;
  document.querySelectorAll(".heatmap .cell.selected").forEach((c) => c.classList.remove("selected"));
  const cell = document.querySelector(`.heatmap .cell[data-date="${day}"]`);
  if (cell) cell.classList.add("selected");
  resetForm();
  await loadDay();
}

async function loadDay() {
  const sessions = await api("GET", `/api/sessions?date=${selectedDay}`);
  const day = parseYmd(selectedDay);
  $("day-title").textContent = fmtLongDate(day);

  const list = $("day-sessions");
  list.innerHTML = "";
  if (!sessions.length) {
    list.innerHTML = `<li class="empty">No sessions on this day.</li>`;
    return;
  }
  let prevEnd = null;
  for (const s of sessions) {
    if (prevEnd && s.start_time > prevEnd) {  // gap between two sessions, e.g. a lunch break
      list.insertAdjacentHTML("beforeend", `<li class="gap small muted">Break ${when(prevEnd)} – ${when(s.start_time)}
        · ${fmtDur((new Date(s.start_time) - new Date(prevEnd)) / 1000)}</li>`);
    }
    prevEnd = s.end_time;
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="times">${when(s.start_time)} – ${s.running ? "now" : when(s.end_time)}</span>
      <span class="dur">${fmtDur(s.seconds)}</span>
      <span class="note"></span>`;
    li.querySelector(".note").textContent = s.note;
    const edit = document.createElement("button");
    edit.className = "btn link";
    edit.textContent = "Edit";
    edit.onclick = () => startEdit(s);
    li.append(edit);
    if (!s.running) {
      const del = document.createElement("button");
      del.className = "btn link";
      del.textContent = "Delete";
      del.onclick = async () => {
        if (!confirm("Delete this session?")) return;
        await api("DELETE", `/api/sessions/${s.id}`);
        await refreshAll();
      };
      li.append(del);
    } else {
      li.insertAdjacentHTML("beforeend", `<span class="small positive">running</span>`);
    }
    li.appendChild(detailsBlock(s));
    list.appendChild(li);
  }
}

/** "HH:MM" on the selected day, otherwise "MM-DD HH:MM". */
const when = (iso) => iso.slice(0, 10) === selectedDay ? hhmm(iso) : iso.slice(5, 16).replace("T", " ");
const localIso = (d) => `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const AWAY_REASON = { sleep: "Mac asleep", lock: "screen locked", "display-off": "display off / lid closed" };
const openDetails = new Set();  // session ids whose details stay expanded across re-renders

/** Collapsible per-session details: timeline (green = Mac in use, grey = away), away periods, add a break.
 *  Click a time on the timeline or in the away list to use it as start, end or break boundary. */
function detailsBlock(s) {
  const d = document.createElement("details");
  d.className = "details";
  d.open = openDetails.has(s.id);
  d.ontoggle = () => (d.open ? openDetails.add(s.id) : openDetails.delete(s.id));
  d.innerHTML = `<summary class="small muted">Timeline & break${s.away.length ? ` · ${s.away.length} away` : ""}</summary>`;

  const t0 = new Date(s.start_time), t1 = s.running ? new Date() : new Date(s.end_time);
  const bar = document.createElement("div");
  bar.className = "timeline";
  bar.title = "";
  d.appendChild(bar);
  // Time under the pointer; on a grey (away) part snap to its nearest edge.
  const timeAt = (e) => {
    const seg = e.target.closest("i");
    if (seg) {
      const r = seg.getBoundingClientRect();
      return new Date(Number(e.clientX - r.left < r.width / 2 ? seg.dataset.from : seg.dataset.to));
    }
    const r = bar.getBoundingClientRect();
    return new Date(t0.getTime() + ((e.clientX - r.left) / r.width) * (t1 - t0));
  };
  bar.onmousemove = (e) => {
    tooltip.textContent = hhmm(localIso(timeAt(e))) + " — click to use";
    tooltip.style.left = e.clientX + "px";
    tooltip.style.top = bar.getBoundingClientRect().top - 6 + "px";
    tooltip.hidden = false;
  };
  bar.onmouseleave = () => (tooltip.hidden = true);
  bar.onclick = (e) => openTimeMenu(e, timeAt(e), s, d);

  const ends = document.createElement("div");
  ends.className = "timeline-ends small muted";
  ends.innerHTML = `<span>${when(s.start_time)}</span><span>${s.running ? "now" : when(s.end_time)}</span>`;
  d.appendChild(ends);

  for (const a of s.away) {
    const a0 = Math.max(new Date(a.start_time), t0), a1 = Math.min(new Date(a.end_time), t1);
    const seg = document.createElement("i");
    seg.style.left = ((a0 - t0) / (t1 - t0)) * 100 + "%";
    seg.style.width = ((a1 - a0) / (t1 - t0)) * 100 + "%";
    seg.dataset.from = new Date(a.start_time).getTime();
    seg.dataset.to = new Date(a.end_time).getTime();
    bar.appendChild(seg);

    const row = document.createElement("div");
    row.className = "small muted";
    row.innerHTML = `Away <button class="btn link t"></button> → <button class="btn link t"></button>
      · ${fmtDur((a1 - a0) / 1000)} · ${AWAY_REASON[a.reason] || a.reason}`;
    [a.start_time, a.end_time].forEach((iso, i) => {
      const btn = row.querySelectorAll(".t")[i];
      btn.textContent = when(iso);
      btn.onclick = (e) => openTimeMenu(e, new Date(iso), s, d);
    });
    d.appendChild(row);
  }

  // ponytail: break times are on the session's start date; sessions spanning midnight need Edit
  const f = document.createElement("form");
  f.className = "break-form small";
  f.innerHTML = `<span class="muted">Break</span> <input type="time" class="b0" required value="12:00"> –
    <input type="time" class="b1" required value="12:45"> <button class="btn">Add break</button>`;
  const day = s.start_time.slice(0, 10);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("POST", `/api/sessions/${s.id}/break`,
        { start_time: `${day}T${f.querySelector(".b0").value}`, end_time: `${day}T${f.querySelector(".b1").value}` });
      await refreshAll();
    } catch (err) {
      $("form-error").textContent = err.message;
    }
  };
  d.appendChild(f);
  return d;
}

// Small menu for a clicked time: the time can be fine-tuned, then used for the edit form or the break.
const timeMenu = document.createElement("div");
timeMenu.className = "time-menu";
timeMenu.hidden = true;
document.body.appendChild(timeMenu);
document.addEventListener("click", (e) => { if (!timeMenu.contains(e.target)) timeMenu.hidden = true; });

function openTimeMenu(e, date, s, d) {
  e.stopPropagation();
  e.preventDefault();
  tooltip.hidden = true;
  timeMenu.innerHTML = `<input type="time" value="${hhmm(localIso(date))}">
    <button class="btn link" data-a="start">Set as start</button>
    <button class="btn link" data-a="end">Set as end</button>
    <button class="btn link" data-a="b0">Break from</button>
    <button class="btn link" data-a="b1">Break until</button>`;
  timeMenu.onclick = (ev) => {
    const action = ev.target.dataset.a;
    if (!action) return;
    const hm = timeMenu.querySelector("input").value;
    const iso = `${ymd(date)}T${hm}`;
    if (action === "start") startEdit(s, { start: iso });
    else if (action === "end") startEdit(s, { end: iso });
    else d.querySelector("." + action).value = hm;
    timeMenu.hidden = true;
  };
  timeMenu.style.left = e.pageX + "px";
  timeMenu.style.top = e.pageY + 10 + "px";
  timeMenu.hidden = false;
  timeMenu.querySelector("input").focus();
}

function resetForm() {
  editingId = null;
  $("f-start").value = `${selectedDay}T09:00`;
  $("f-end").value = `${selectedDay}T17:00`;
  $("f-note").value = "";
  $("f-end").required = true;
  $("f-submit").textContent = "Add entry";
  $("f-cancel").hidden = true;
  $("form-error").textContent = "";
}

/** Load a session into the form; `set` overrides start/end. The running session keeps running
 *  while End is empty ("Save"); with an end time it stops ("Save & stop"). */
function startEdit(s, set = {}) {
  editingId = s.id;
  editingRunning = s.running;
  $("f-start").value = (set.start || s.start_time).slice(0, 16);
  $("f-end").value = (set.end || s.end_time || "").slice(0, 16);
  $("f-end").required = !s.running;
  $("f-note").value = s.note;
  submitLabel();
  $("f-cancel").hidden = false;
  $("form-error").textContent = "";
  $("session-form").scrollIntoView({ block: "nearest" });
}

let editingRunning = false;
const submitLabel = () =>
  ($("f-submit").textContent = !editingRunning ? "Save" : $("f-end").value ? "Save & stop" : "Save (keeps running)");
$("f-end").addEventListener("input", () => editingId && submitLabel());

$("f-cancel").addEventListener("click", resetForm);

$("session-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { start_time: $("f-start").value, end_time: $("f-end").value, note: $("f-note").value };
  try {
    if (editingId) await api("PUT", `/api/sessions/${editingId}`, body);
    else await api("POST", "/api/sessions", body);
    resetForm();
    await refreshAll();
  } catch (err) {
    $("form-error").textContent = err.message;
  }
});

// Catch up immediately when the tab becomes visible again (renders are skipped while hidden).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && status) { renderStatus(); renderWeek(); }
});

// ------------------------------------------------------------ settings (notifications)

const notifySupported = "Notification" in window;
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const PERMISSION_TEXT = { granted: icon("check") + " allowed", default: "not enabled yet", denied: icon("blocked") + " blocked" };

function renderSettings() {
  const perm = notifySupported ? Notification.permission : "unsupported";
  const browser = $("chk-browser");
  browser.innerHTML = notifySupported ? PERMISSION_TEXT[perm] : "not supported";
  browser.className = perm === "granted" ? "positive" : perm === "default" ? "" : "negative";
  const watcher = $("chk-watcher");
  watcher.innerHTML = status && status.watcher ? icon("check") + " active" : "off (macOS only, or WAKE_PROMPT=0)";
  watcher.className = status && status.watcher ? "positive" : "muted";
  $("enable-notify").hidden = perm !== "default";
  // Nudge until notifications are set up.
  $("settings-btn").classList.toggle("attention", notifySupported && perm !== "granted");
}

// ------------------------------------------------------------ settings (work goal)

/** "8h", "7h 30m" */
const hours = (sec) => fmtDur(sec).replace(" 00m", "");
const goalText = (g) => `${hours(g.daily_seconds * g.workdays.length)} per week · `
  + `${g.workdays.map((d) => DAY_NAMES[d]).join(", ")} · ${hours(g.daily_seconds)} per workday`;

$("goal-days").innerHTML = DAY_NAMES.map((n, i) =>
  `<label><input type="checkbox" value="${i}"> ${n}</label>`).join("");

async function loadGoals() {
  const goals = await api("GET", "/api/goals");
  const today = status.today;
  const current = goals.filter((g) => !g.valid_from || g.valid_from <= today).pop();
  $("goal-current").innerHTML = `<b>Now:</b> ${goalText(current)}`;
  const planned = $("goal-planned");
  planned.innerHTML = "";
  for (const g of goals.filter((g) => g.valid_from > today)) {
    const li = document.createElement("li");
    li.innerHTML = `<span>From ${fmtLongDate(parseYmd(g.valid_from))}: ${goalText(g)}</span>`;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn link";
    cancel.textContent = "Cancel";
    cancel.onclick = async () => { await api("DELETE", `/api/goals/${g.valid_from}`); await goalsChanged(); };
    li.appendChild(cancel);
    planned.appendChild(li);
  }
  // Prefill the form with the current goal, starting today.
  $("goal-hours").value = (current.daily_seconds * current.workdays.length) / 3600;
  $("goal-days").querySelectorAll("input").forEach((c) => (c.checked = current.workdays.includes(Number(c.value))));
  $("goal-from").value = $("goal-from").min = today;
  $("goal-error").textContent = "";
  goalHint();
}

function goalHint() {
  const days = $("goal-days").querySelectorAll("input:checked").length;
  const h = Number($("goal-hours").value);
  $("goal-hint").textContent = days && h
    ? `= ${hours((h * 3600) / days)} per workday. Applies from the start date on — past days keep the goal they had.`
    : "Pick the hours and at least one workday.";
}
$("goal-form").addEventListener("input", goalHint);

async function goalsChanged() {
  await refreshAll();  // today, week and overtime use the new goal
  await loadGoals();
}

$("goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("PUT", "/api/goals", {
      valid_from: $("goal-from").value,
      weekly_hours: Number($("goal-hours").value),
      workdays: [...$("goal-days").querySelectorAll("input:checked")].map((c) => Number(c.value)),
    });
    await goalsChanged();
    $("goal-hint").innerHTML = icon("check") + " Saved. " + $("goal-hint").textContent;
  } catch (err) {
    $("goal-error").textContent = err.message;
  }
});

async function enableNotifications() {
  if (notifySupported && Notification.permission === "default") await Notification.requestPermission();
  renderSettings();
  await loadStatus();  // starts reporting this tab as able to notify
}

$("settings-btn").addEventListener("click", () => {
  renderSettings();
  loadGoals();
  $("test-result").textContent = "";
  $("settings").showModal();
});
$("enable-notify").addEventListener("click", enableNotifications);
$("test-notify").addEventListener("click", async () => {
  const result = $("test-result");
  if (!notifySupported) {
    result.textContent = "This browser can't show notifications — try Firefox, Chrome or Safari.";
    return;
  }
  await enableNotifications();
  if (Notification.permission !== "granted") {
    result.textContent = "Notifications are blocked for this site — see “Nothing showed up?” below, step 1.";
    $("notify-help").open = true;
    return;
  }
  try {
    await api("POST", "/api/test-notification");
    await loadStatus();  // same path as a real reminder: server → this tab → notification
    result.textContent = "Sent! You should see “Work Tracker – test notification” now. "
      + "Nothing? Open “Nothing showed up?” below.";
  } catch (e) {
    result.textContent = "Couldn't reach the server: " + e.message;
  }
});

// ------------------------------------------------------------ boot

async function refreshAll() {
  await loadStatus();
  fillYearSelect();
  await Promise.all([renderHeatmap(), loadDay()]);
}

async function init() {
  status = await api("GET", "/api/status");
  selectedDay = status.today;
  $("today-label").textContent = fmtLongDate(parseYmd(status.today));
  resetForm();
  await refreshAll();
  renderSettings();

  // Only the clock shows seconds, so only it ticks; the rest shows minutes and is redrawn every 30s
  // (bars don't re-animate every second). Nothing ticks while the timer is stopped or the tab hidden.
  let ticks = 0;
  setInterval(() => {
    if (!status || !status.running || document.hidden) return;
    if (++ticks % 30) $("clock").textContent = fmtClock(status.running.seconds + liveExtra());
    else { renderStatus(); renderWeek(); }
  }, 1000);
  watchChanges();
}

// No polling: /api/wait answers when something changes (Start/Stop anywhere, a reminder, coming back
// to the Mac) or after 5 min, which also catches a new day.
async function watchChanges() {
  let version = -1;
  for (;;) {
    try {
      const v = (await api("GET", `/api/wait?v=${version}`)).version;
      if (version === -1) { version = v; continue; }  // the first answer just hands out the current version
      const prevToday = status.today;
      await loadStatus();
      if (status.today !== prevToday) {
        $("today-label").textContent = fmtLongDate(parseYmd(status.today));
        await refreshAll();
      }
      if (v !== version) document.dispatchEvent(new Event("tracker:changed"));  // e.g. the Workflow board
      version = v;  // only once handled: a failed reload asks again
    } catch {
      await new Promise((r) => setTimeout(r, 5000));  // server restarting or the Mac just woke up
    }
  }
}

init().catch((e) => {
  document.querySelector("main").insertAdjacentHTML(
    "afterbegin",
    `<div class="card error">Could not reach the server: ${e.message}</div>`
  );
});
