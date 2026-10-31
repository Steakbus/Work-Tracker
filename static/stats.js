"use strict";

const $ = (id) => document.getElementById(id);
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let data = null;  // last /api/stats response

// ------------------------------------------------------------ helpers

async function api(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const shortDate = (s) => { const d = parseYmd(s); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const longDate = (s) => parseYmd(s).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 3600)}h ${pad2(Math.floor((sec % 3600) / 60))}m`;
}
const hours = (sec) => fmtDur(sec).replace(" 00m", "");
const signed = (sec) => (sec > 0 ? "+" : sec < 0 ? "−" : "±") + fmtDur(Math.abs(sec));
/** Minutes after midnight -> "08:45" */
const clockTime = (min) => `${pad2(Math.floor(min / 60) % 24)}:${pad2(Math.floor(min % 60))}`;

// ------------------------------------------------------------ charts (inline SVG)

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

const tooltip = $("tooltip");
function showTip(text, x, y) {
  tooltip.textContent = text;
  tooltip.style.left = x + "px";
  tooltip.style.top = y - 8 + "px";
  tooltip.hidden = false;
}
const hideTip = () => (tooltip.hidden = true);

/** Clean hour steps for the y axis: 0 / 2h / 4h … with at most ~4 gridlines. */
function hourTicks(maxSec) {
  const h = Math.max(1, maxSec / 3600);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => h / s <= 4) || 2000;
  const top = Math.ceil(h / step) * step;
  return { top: top * 3600, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step * 3600) };
}

/** Labels along the x axis, dropping any closer than `gap` px to the previous one. */
function xLabels(svg, items, xOf, y, gap = 44) {
  let last = -Infinity;
  items.forEach((it, i) => {
    if (!it.label || xOf(i) - last < gap) return;
    svgEl("text", { x: xOf(i), y, class: "axis", "text-anchor": "middle" }, svg).textContent = it.label;
    last = xOf(i);
  });
}

/** Column chart. items: [{ value, goal?, label?, tip }] in seconds. */
function columnChart(el, items, { height = 180 } = {}) {
  el.innerHTML = "";
  const W = el.clientWidth, H = height, L = 36, R = 4, T = 8, B = 22;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, el);
  const { top, ticks } = hourTicks(Math.max(...items.map((i) => Math.max(i.value, i.goal || 0))));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  for (const t of ticks) {
    svgEl("line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t ? "grid" : "baseline" }, svg);
    svgEl("text", { x: L - 6, y: y(t) + 4, class: "axis", "text-anchor": "end" }, svg).textContent = hours(t);
  }
  const band = (W - L - R) / items.length;
  const bw = Math.max(1, Math.min(24, band * 0.7, band - 2));  // capped width, ≥ 2px gap between columns
  const xOf = (i) => L + band * (i + 0.5);

  const bars = items.map((it, i) => {
    const x = xOf(i) - bw / 2, base = y(0), h = base - y(it.value), r = Math.min(4, bw / 2, h);
    return svgEl("path", {
      class: "col",
      d: h <= 0 ? "" : `M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}`
        + `H${x + bw - r}Q${x + bw},${base - h} ${x + bw},${base - h + r}V${base}Z`,
    }, svg);
  });
  items.forEach((it, i) => {
    if (it.goal) svgEl("line", { class: "goal-mark", x1: xOf(i) - bw / 2 - 2, x2: xOf(i) + bw / 2 + 2, y1: y(it.goal), y2: y(it.goal) }, svg);
  });
  xLabels(svg, items, xOf, H - 6);

  // Hover: the whole band is the target, not just the (maybe tiny) column.
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - L) / band);
    bars.forEach((b, j) => b.classList.toggle("active", j === i));
    if (i < 0 || i >= items.length) return hideTip();
    showTip(items[i].tip, r.left + xOf(i), r.top + Math.min(y(items[i].value), y(items[i].goal || 0)));
  });
  svg.addEventListener("mouseleave", () => { bars.forEach((b) => b.classList.remove("active")); hideTip(); });
}

/** Line chart around zero, green above and red below. points: [{ value, label?, tip }] in seconds. */
function balanceChart(el, points, { height = 200 } = {}) {
  el.innerHTML = "";
  const W = el.clientWidth, H = height, L = 52, R = 8, T = 10, B = 28;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, el);
  const lo = Math.min(0, ...points.map((p) => p.value)), hi = Math.max(0, ...points.map((p) => p.value));
  const span = Math.max(3600, hi - lo);
  const { ticks } = hourTicks(span);
  const step = ticks[1] || 3600;
  const yMin = Math.floor(lo / step) * step, yMax = Math.max(Math.ceil(hi / step) * step, yMin + step);
  const y = (v) => T + (H - T - B) * (1 - (v - yMin) / (yMax - yMin));
  const xOf = (i) => L + (points.length > 1 ? (i / (points.length - 1)) * (W - L - R) : (W - L - R) / 2);

  for (let t = yMin; t <= yMax; t += step) {
    svgEl("line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? "baseline" : "grid" }, svg);
    svgEl("text", { x: L - 6, y: y(t) + 4, class: "axis", "text-anchor": "end" }, svg).textContent = t ? signed(t).replace(" 00m", "") : "0";
  }

  // One gradient, split hard at zero: above is overtime, below is missing time.
  const id = "g" + Math.random().toString(36).slice(2);
  const zero = Math.min(1, Math.max(0, (y(0) - T) / (H - T - B)));
  const grad = svgEl("linearGradient", { id, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: T, y2: H - B }, svgEl("defs", {}, svg));
  for (const [off, cls] of [[0, "pos"], [zero, "pos"], [zero, "neg"], [1, "neg"]]) svgEl("stop", { offset: off, class: cls }, grad);

  const line = points.map((p, i) => `${i ? "L" : "M"}${xOf(i)},${y(p.value)}`).join("");
  svgEl("path", { d: `${line}L${xOf(points.length - 1)},${y(0)}L${xOf(0)},${y(0)}Z`, fill: `url(#${id})`, class: "area" }, svg);
  svgEl("path", { d: line, stroke: `url(#${id})`, class: "line" }, svg);
  xLabels(svg, points, xOf, H - 6, 56);

  // End label: where the balance stands now.
  const lastP = points[points.length - 1];
  svgEl("circle", { cx: xOf(points.length - 1), cy: y(lastP.value), r: 4, class: "dot " + (lastP.value < 0 ? "neg" : "pos") }, svg);

  const cross = svgEl("line", { y1: T, y2: H - B, class: "crosshair", visibility: "hidden" }, svg);
  const dot = svgEl("circle", { r: 4, class: "dot", visibility: "hidden" }, svg);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - L) / (W - L - R)) * (points.length - 1));
    if (i < 0 || i >= points.length) return;
    const x = xOf(i), py = y(points[i].value);
    cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    dot.setAttribute("class", "dot " + (points[i].value < 0 ? "neg" : "pos"));
    showTip(points[i].tip, r.left + x, r.top + py);
  });
  svg.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); });
}

/** Horizontal bars as a list: [{ label, value, text }]. */
function hbars(el, items, empty) {
  el.innerHTML = items.length ? "" : `<li class="muted small">${empty}</li>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  for (const it of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="hb-label"></span><span class="hb-track"><i style="width:${(it.value / max) * 100}%"></i></span>
      <span class="hb-value">${it.text}</span>`;
    li.querySelector(".hb-label").textContent = it.label;
    li.title = `${it.label}: ${it.text}`;
    el.appendChild(li);
  }
}

// ------------------------------------------------------------ render

function render() {
  const d = data;
  $("range-label").textContent = `${longDate(d.from)} – ${longDate(d.to)}`;

  // Headline numbers
  $("s-total").textContent = fmtDur(d.total_seconds);
  $("s-total-sub").textContent = `${plural(d.active_days, "active day")} · ${plural(d.sessions, "session")}`;
  const ot = $("s-overtime");
  ot.textContent = signed(d.overtime_seconds);
  ot.className = "value " + (d.overtime_seconds > 0 ? "positive" : d.overtime_seconds < 0 ? "negative" : "");
  $("s-overtime-sub").textContent = `${fmtDur(d.total_seconds)} worked of a ${hours(d.target_seconds)} goal`;
  const rate = d.target_days ? d.goal_met_days / d.target_days : 0;
  $("s-goal").textContent = d.target_days ? `${Math.round(rate * 100)}%` : "–";
  $("s-goal-bar").style.width = rate * 100 + "%";
  $("s-goal-sub").textContent = d.target_days
    ? `Daily goal met on ${d.goal_met_days} of ${plural(d.target_days, "workday")}` : "No finished workdays yet";
  $("s-streak").textContent = plural(d.current_streak, "day");
  $("s-streak-sub").textContent = `Workdays in a row with work · best ${plural(d.best_streak, "day")}`;
  $("s-avg").textContent = fmtDur(d.active_days ? d.total_seconds / d.active_days : 0);
  const perWeek = d.weeks.length ? d.total_seconds / d.weeks.length : 0;
  $("s-avg-sub").textContent = `${fmtDur(perWeek)} per week on average`;
  $("s-typical").textContent = d.typical_start === null ? "–" : `${clockTime(d.typical_start)} – ${clockTime(d.typical_end)}`;
  $("s-typical-sub").textContent = d.typical_start === null ? "" : "Median first start and last stop";

  // Hours per week
  columnChart($("c-weeks"), d.weeks.map((w, i) => {
    const mon = parseYmd(w.week);
    const prev = i && parseYmd(d.weeks[i - 1].week);
    return {
      value: w.seconds,
      goal: w.target,
      label: !i || mon.getMonth() !== prev.getMonth() ? MONTHS[mon.getMonth()] : "",
      tip: `Week of ${shortDate(w.week)}: ${fmtDur(w.seconds)}${w.target ? ` of ${hours(w.target)}` : ""}`,
    };
  }), { height: 200 });

  // Running overtime balance
  let bal = 0;
  balanceChart($("c-balance"), d.days.map((day, i) => {
    bal += day.seconds - day.target;
    const dt = parseYmd(day.date);
    return {
      value: bal,
      label: !i || dt.getDate() === 1 ? shortDate(day.date) : "",
      tip: `${shortDate(day.date)}: ${signed(bal)}`,
    };
  }));

  // Time of day: only the hours with work, plus an hour around them
  const used = d.hours.map((s, h) => (s ? h : -1)).filter((h) => h >= 0);
  const h0 = used.length ? Math.max(0, used[0] - 1) : 8, h1 = used.length ? Math.min(23, used[used.length - 1] + 1) : 18;
  columnChart($("c-hours"), d.hours.slice(h0, h1 + 1).map((sec, i) => ({
    value: sec,
    label: (h0 + i) % 3 === 0 ? `${pad2(h0 + i)}:00` : "",
    tip: `${pad2(h0 + i)}:00 – ${pad2(h0 + i + 1)}:00: ${fmtDur(sec)}`,
  })));

  // Weekday averages: Mon–Fri always, weekend days only when you worked on them
  columnChart($("c-weekdays"), d.weekdays.map((w, i) => ({ ...w, i }))
    .filter((w) => w.i < 5 || w.days)
    .map((w) => ({
      value: w.days ? w.seconds / w.days : 0,
      label: DAY_NAMES[w.i],
      tip: `${DAY_NAMES[w.i]}: ${fmtDur(w.days ? w.seconds / w.days : 0)} on average · ${plural(w.days, "day")}`,
    })));

  hbars($("c-notes"), d.notes.map((n) => ({ label: n.note, value: n.seconds, text: fmtDur(n.seconds) })),
    "No notes yet — type what you're working on next to Start.");
  hbars($("c-lengths"), d.session_lengths.map((b) => ({ label: b.label, value: b.count, text: plural(b.count, "session") })),
    "No sessions yet.");

  // Records
  const bestWeek = d.weeks.reduce((a, w) => (!a || w.seconds > a.seconds ? w : a), null);
  const records = [
    d.best_day && ["Longest day", fmtDur(d.best_day[1]), longDate(d.best_day[0])],
    bestWeek && bestWeek.seconds && ["Best week", fmtDur(bestWeek.seconds), `Week of ${shortDate(bestWeek.week)}`],
    d.longest_session && ["Longest session", fmtDur(d.longest_session.seconds),
      longDate(d.longest_session.start_time.slice(0, 10)) + (d.longest_session.note ? ` · ${d.longest_session.note}` : "")],
    d.earliest_start && ["Earliest start", clockTime(d.earliest_start[1]), longDate(d.earliest_start[0])],
    d.latest_end && ["Latest finish", clockTime(d.latest_end[1]), longDate(d.latest_end[0])],
    ["Days off", `${d.days_off.vacation} vacation · ${d.days_off.sick} sick`, ""],
  ].filter(Boolean);
  const list = $("records");
  list.innerHTML = "";
  for (const [label, value, sub] of records) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="label"></span><b></b><span class="small muted"></span>`;
    [label, value, sub].forEach((t, i) => (li.children[i].textContent = t));
    list.appendChild(li);
  }
}

// ------------------------------------------------------------ period + boot

function rangeQuery() {
  const v = $("range-select").value || "all";  // no options yet on the first load
  const today = new Date();
  if (v === "all") return "";
  if (v === "30") return `?from=${ymd(addDays(today, -29))}`;
  if (v === "365") return `?from=${ymd(addDays(today, -364))}`;
  return `?from=${v}-01-01&to=${v}-12-31`;
}

async function load() {
  data = await api("/api/stats" + rangeQuery());
  const sel = $("range-select");
  if (!sel.options.length) {
    sel.innerHTML = `<option value="all">All time</option><option value="30">Last 30 days</option>
      <option value="365">Last 12 months</option>`;
    for (let y = new Date().getFullYear(); y >= data.first_year; y--) sel.insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
  }
  render();
}

$("range-select").addEventListener("change", load);
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => data && render(), 150); });

// Like the tracker tab: /api/wait answers when something changes (or after 5 min), then reload.
async function watchChanges() {
  let version = -1;
  for (;;) {
    try {
      const v = (await api(`/api/wait?v=${version}`)).version;
      if (version !== -1) await load();
      version = v;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

load().then(watchChanges).catch((e) => {
  document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="card error">Could not load statistics: ${e.message}</div>`);
});
