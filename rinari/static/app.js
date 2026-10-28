"use strict";

const LIMITS_INTERVAL_MS = 5 * 60 * 1000;
const STATS_INTERVAL_MS = 60 * 1000;
const MAX_SERIES = 8; // 9つ目以降のモデルは「その他」にまとめる
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  period: 30,
  metric: "total",
  stats: null,
  limits: null,
  history: [],
  colorOf: new Map(), // モデルID -> 色の番号（全期間の使用量順で固定。期間を変えても色は変わらない）
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// ---------- 数値・日時の表示 ----------

const nf = new Intl.NumberFormat("ja-JP");

function compact(n) {
  if (n >= 1e8) return trim(n / 1e8) + "億";
  if (n >= 1e4) return trim(n / 1e4) + "万";
  return nf.format(Math.round(n));
}
function trim(x) {
  return (x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100).toString();
}
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
function usd(x) {
  if (x > 0 && x < 0.01) return "<$0.01";
  return x >= 1000 ? usd0.format(x) : usd2.format(x);
}
function pct(x) {
  if (x === 0) return "0%";
  if (x < 0.1) return "<0.1%";
  return (x < 10 ? x.toFixed(1) : Math.round(x).toString()) + "%";
}

function fmtDateTime(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtRemaining(ms) {
  if (ms <= 0) return "まもなく";
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `あと ${d}日${h}時間`;
  if (h > 0) return `あと ${h}時間${mm}分`;
  return `あと ${mm}分`;
}
function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- モデル名と色 ----------

const FAMILIES = ["opus", "sonnet", "haiku", "fable"];

function modelLabel(id) {
  if (id === "other") return "その他";
  const parts = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  const fam = parts.find((p) => FAMILIES.includes(p));
  if (!fam) return id;
  const ver = parts.filter((p) => /^\d+$/.test(p)).join(".");
  return fam[0].toUpperCase() + fam.slice(1) + (ver ? " " + ver : "");
}

function colorVar(id) {
  const slot = state.colorOf.get(id);
  return slot ? `var(--series-${slot})` : "var(--series-other)";
}

function assignColors(rows) {
  const totals = new Map();
  for (const r of rows) totals.set(r[1], (totals.get(r[1]) || 0) + r[4] + r[5] + r[6] + r[7]);
  const order = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  state.colorOf = new Map(order.slice(0, MAX_SERIES).map((id, i) => [id, i + 1]));
}

// ---------- 利用上限 ----------

async function loadLimits(force = false) {
  try {
    const res = await fetch("/api/limits" + (force ? "?force=1" : ""));
    state.limits = await res.json();
    const h = await fetch("/api/limits/history");
    state.history = (await h.json()).points || [];
  } catch (e) {
    state.limits = { error: "Rinari のサーバーに接続できません（起動しているか確認してください）", limits: [] };
  }
  renderLimits();
}

const SEVERITY_TEXT = { normal: "余裕あり", warning: "注意", critical: "上限間近" };

function severityOf(item) {
  if (item.severity && item.severity in SEVERITY_TEXT) return item.severity;
  return item.percent >= 90 ? "critical" : item.percent >= 70 ? "warning" : "normal";
}

function renderLimits() {
  const data = state.limits;
  const box = $("limits");
  box.replaceChildren();

  const err = $("limits-error");
  err.hidden = !data.error;
  err.textContent = data.error ? (data.stale ? "最新の値を取得できませんでした: " : "") + data.error : "";

  if (data.plan) {
    const tier = (data.plan.tier || "").replace(/^default_claude_/, "").replace(/_/g, " ");
    const plan = [data.plan.subscription, tier].filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join(" · ");
    $("plan").textContent = plan;
    $("plan").hidden = !plan;
  }

  for (const item of data.limits || []) {
    const sev = severityOf(item);
    const fill = el("span");
    fill.style.width = Math.min(100, Math.max(0, item.percent)) + "%";
    const meter = el("div", {
      class: "meter " + sev, role: "meter", "aria-valuemin": "0", "aria-valuemax": "100",
      "aria-valuenow": String(item.percent), "aria-label": item.label,
    }, fill);

    const badges = el("div", { class: "limit-head" },
      el("span", { class: "limit-label", text: item.label }),
      el("span", { class: "badge " + sev }, el("span", { class: "dot" }), SEVERITY_TEXT[sev]),
    );

    let reset = "";
    if (item.resetsAt) {
      const d = new Date(item.resetsAt);
      reset = `${fmtDateTime(d)} にリセット（${fmtRemaining(d - Date.now())}）`;
    }
    const value = el("div", { class: "limit-value" }, String(Math.round(item.percent)), el("small", { text: "%" }));
    const card = el("div", { class: "limit" }, badges, value, meter, el("div", { class: "limit-reset", text: reset }));
    const trend = limitTrend(item, data.fetchedAt);
    if (trend) {
      card.append(trend.chart);
      card.append(el("div", { class: "forecast" + (trend.hits ? " critical" : "") },
        el("span", { class: "forecast-main", text: trend.text }), el("span", { class: "muted", text: trend.basis })));
    }
    if (item.active) {
      card.append(el("span", { class: "badge active", text: "いま一番効いている枠" }));
    }
    box.append(card);
  }
  if (!data.error && !(data.limits || []).length) {
    box.append(el("p", { class: "empty", text: "利用上限の情報がありません" }));
  }

  const ex = data.extraUsage;
  $("extra-usage").hidden = !(ex && ex.enabled && ex.monthlyLimit);
  if (ex && ex.enabled && ex.monthlyLimit) {
    $("extra-usage").textContent = `追加使用量: ${ex.usedCredits ?? 0} / ${ex.monthlyLimit} ${ex.currency || ""}`;
  }
  updateStamp();
}

// ---------- 利用上限の推移と予測 ----------

const HOUR = 3600 * 1000;

function windowLength(item) {
  return item.kind === "session" || item.group === "session" ? 5 * HOUR : 7 * 24 * HOUR;
}

// 今の枠（リセット時刻が同じ記録）の点を集める
function windowPoints(item, nowSec) {
  const reset = Date.parse(item.resetsAt);
  const pts = [];
  for (const e of state.history) {
    for (const x of e.limits) {
      if (x.label !== item.label || !x.resetsAt) continue;
      if (Math.abs(Date.parse(x.resetsAt) - reset) > 2 * 60 * 1000) continue;
      pts.push([e.t * 1000, x.percent]);
    }
  }
  pts.push([nowSec * 1000, item.percent]);
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

function forecast(item, pts, now) {
  const reset = Date.parse(item.resetsAt);
  const start = reset - windowLength(item);
  const p = item.percent;
  // 直近のペース（5時間枠は直近1時間、週間枠は直近24時間）。記録が足りなければ枠の始まりからの平均
  const span = item.kind === "session" ? HOUR : 24 * HOUR;
  const recent = pts.filter(([t]) => t >= now - span);
  let rate, basis;
  if (recent.length >= 2 && now - recent[0][0] >= span / 4) {
    rate = (p - recent[0][1]) / (now - recent[0][0]);
    basis = item.kind === "session" ? "直近1時間のペース" : "直近24時間のペース";
  } else {
    rate = p / Math.max(now - start, 60 * 1000);
    basis = "この枠の平均ペース";
  }
  rate = Math.max(0, rate);
  const atReset = p + rate * (reset - now);
  const hitAt = rate > 0 && p < 100 ? now + (100 - p) / rate : null;
  return { start, reset, rate, atReset, hitAt: hitAt && hitAt < reset ? hitAt : null, basis };
}

function limitTrend(item, fetchedAt) {
  if (!item.resetsAt || !fetchedAt) return null;
  const now = fetchedAt * 1000;
  const pts = windowPoints(item, fetchedAt);
  const f = forecast(item, pts, now);

  let text;
  if (item.percent >= 100) text = "上限に達しています";
  else if (f.hitAt) text = `このペースだと ${fmtDateTime(new Date(f.hitAt))} ごろ上限に達します`;
  else text = `このペースならリセット時 約${Math.round(Math.min(100, f.atReset))}%`;

  const W = 320, H = 96, L = 32, R = 8, T = 8, B = 18;
  const pw = W - L - R, ph = H - T - B;
  const x = (t) => L + ((t - f.start) / (f.reset - f.start)) * pw;
  const y = (v) => T + ph - (Math.min(100, Math.max(0, v)) / 100) * ph;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "trend", role: "img",
    "aria-label": `${item.label}の推移: 現在${Math.round(item.percent)}%。${text}` });

  for (const v of [0, 50, 100]) {
    root.append(svg("line", { class: v === 0 ? "baseline" : "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const t = svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = v + "%";
    root.append(t);
  }
  const short = item.kind === "session";
  const lab = (t) => (short ? fmtTime(new Date(t)) : fmtDateTime(new Date(t)).split(" ")[0]);
  for (const [t, anchor] of [[f.start, "start"], [f.reset, "end"]]) {
    const tx = svg("text", { x: x(t), y: H - 4, "text-anchor": anchor });
    tx.textContent = lab(t);
    root.append(tx);
  }

  // 予測（点線）: 今からリセットまで。上限に達するならそこまで
  const endT = f.hitAt || f.reset;
  const endV = f.hitAt ? 100 : f.atReset;
  root.append(svg("line", { class: "projection" + (f.hitAt ? " critical" : ""),
    x1: x(now), y1: y(item.percent), x2: x(endT), y2: y(endV) }));

  // 実績（実線）
  const visible = pts.filter(([t]) => t >= f.start);
  if (visible.length > 1) {
    root.append(svg("polyline", { class: "actual", points: visible.map(([t, v]) => `${x(t)},${y(v)}`).join(" ") }));
  }
  root.append(svg("circle", { class: "now-dot", cx: x(now), cy: y(item.percent), r: 4 }));

  // ホバーで一番近い記録（今より先は予測値）を表示
  const hit = svg("rect", { class: "hit", x: L, y: T, width: pw, height: ph });
  hit.addEventListener("mousemove", (e) => {
    const box = root.getBoundingClientRect();
    const t = f.start + ((((e.clientX - box.left) / box.width) * W - L) / pw) * (f.reset - f.start);
    if (t > now) {
      const tt = Math.min(t, endT);
      showTip(e, "予測", [[null, fmtDateTime(new Date(tt)), `約${Math.round(Math.min(100, item.percent + f.rate * (tt - now)))}%`]]);
      return;
    }
    let best = null;
    for (const pt of visible) if (!best || Math.abs(pt[0] - t) < Math.abs(best[0] - t)) best = pt;
    showTip(e, fmtDateTime(new Date(best[0])), [[null, item.label, `${Math.round(best[1])}%`]]);
  });
  hit.addEventListener("mouseleave", hideTip);
  root.append(hit);

  const basis = visible.length > 1 ? `（${f.basis}）` : `（${f.basis}・記録はこれから貯まります）`;
  return { chart: root, text, basis, hits: !!f.hitAt || item.percent >= 100 };
}

// ---------- モデル別の使用割合 ----------

async function loadStats(force = false) {
  try {
    const res = await fetch("/api/stats" + (force ? "?force=1" : ""));
    state.stats = await res.json();
    assignColors(state.stats.rows);
  } catch (e) {
    state.stats = state.stats || { rows: [] };
  }
  renderStats();
}

function valueOf(r, metric) {
  // r = [日付, モデル, プロジェクト, 応答数, 入力, 出力, キャッシュ作成, キャッシュ読込, 料金換算USD]
  if (metric === "messages") return r[3];
  if (metric === "cost") return r[8];
  if (metric === "output") return r[5];
  return r[4] + r[5] + r[6] + r[7];
}

function periodStart() {
  if (!state.period) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (state.period - 1));
  return localDate(d);
}

function filteredRows() {
  const from = periodStart();
  return (state.stats?.rows || []).filter((r) => !from || r[0] >= from);
}

// 色の番号が付いていないモデルは「その他」にまとめる
const seriesKey = (id) => (state.colorOf.has(id) ? id : "other");

function seriesOrder(ids) {
  return [...ids].sort((a, b) => (state.colorOf.get(a) || 99) - (state.colorOf.get(b) || 99));
}

function renderStats() {
  const rows = filteredRows();
  const metric = state.metric;

  // モデルごとの合計
  const byModel = new Map();
  for (const r of rows) {
    const k = seriesKey(r[1]);
    const m = byModel.get(k) || [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) m[i] += r[3 + i];
    byModel.set(k, m);
  }
  const val = (m) =>
    metric === "messages" ? m[0] : metric === "output" ? m[2] : metric === "cost" ? m[5] : m[1] + m[2] + m[3] + m[4];
  const models = seriesOrder(byModel.keys());
  const total = models.reduce((s, id) => s + val(byModel.get(id)), 0);

  renderSummary(rows);
  renderShare(models, byModel, val, total);
  renderModelTable(models, byModel, val, total);
  renderDaily(rows, metric);
  renderHeatmap(metric);
  renderProjects(rows, metric);
  updateStamp();
}

function renderShare(models, byModel, val, total) {
  const bar = $("share-bar");
  const legend = $("legend");
  bar.replaceChildren();
  legend.replaceChildren();
  if (!total) {
    legend.append(el("p", { class: "empty", text: state.stats ? "この期間の利用はありません" : "集計中…" }));
    bar.setAttribute("aria-label", "データなし");
    return;
  }
  const desc = [];
  for (const id of models) {
    const v = val(byModel.get(id));
    if (!v) continue;
    const share = (v / total) * 100;
    const seg = el("span");
    seg.style.flex = `${v} 0 0`;
    seg.style.background = colorVar(id);
    seg.addEventListener("mousemove", (e) => showTip(e, modelLabel(id), [[id, modelLabel(id), `${pct(share)}（${fmtMetric(v)}）`]]));
    seg.addEventListener("mouseleave", hideTip);
    bar.append(seg);

    const sw = el("span", { class: "swatch" });
    sw.style.background = colorVar(id);
    legend.append(el("div", { class: "legend-item" }, sw, el("span", { text: modelLabel(id) }),
      el("span", { class: "pct", text: pct(share) }), el("span", { class: "val", text: fmtMetric(v) })));
    desc.push(`${modelLabel(id)} ${pct(share)}`);
  }
  bar.setAttribute("aria-label", desc.join("、"));
}

function fmtMetric(v, metric = state.metric) {
  if (metric === "messages") return `${nf.format(v)}回`;
  if (metric === "cost") return usd(v);
  return compact(v);
}

const METRIC_LABEL = { total: "全トークン", output: "出力トークン", messages: "応答数", cost: "料金換算" };

function renderSummary(rows) {
  const box = $("stat-row");
  box.replaceChildren();
  let cost = 0, msgs = 0, tokens = 0;
  for (const r of rows) {
    cost += r[8];
    msgs += r[3];
    tokens += r[4] + r[5] + r[6] + r[7];
  }
  const days = dayList(rows).length || 1;
  const items = [
    ["API 料金換算", usd(cost)],
    ["1日あたり", usd(cost / days)],
    ["応答数", nf.format(msgs)],
    ["全トークン", compact(tokens)],
  ];
  for (const [label, value] of items) {
    box.append(el("div", { class: "stat" }, el("div", { class: "stat-label", text: label }), el("div", { class: "stat-value", text: value })));
  }
}

function renderModelTable(models, byModel, val, total) {
  const tbody = $("model-table").tBodies[0];
  tbody.replaceChildren();
  for (const id of models) {
    const m = byModel.get(id);
    const sw = el("span", { class: "swatch" });
    sw.style.background = colorVar(id);
    tbody.append(el("tr", {},
      el("td", {}, el("span", { class: "cell-model" }, sw, modelLabel(id))),
      el("td", { class: "num", text: nf.format(m[0]) }),
      el("td", { class: "num", text: compact(m[1]) }),
      el("td", { class: "num", text: compact(m[2]) }),
      el("td", { class: "num", text: compact(m[3]) }),
      el("td", { class: "num", text: compact(m[4]) }),
      el("td", { class: "num", text: usd(m[5]) }),
      el("td", { class: "num", text: total ? pct((val(m) / total) * 100) : "-" }),
    ));
  }
  if (!models.length) tbody.append(el("tr", {}, el("td", { colspan: "8", class: "empty", text: "データなし" })));
}

function dayList(rows) {
  let from = periodStart();
  if (!from) from = rows.length ? rows[0][0] : localDate(new Date());
  const days = [];
  const d = new Date(from + "T00:00:00");
  const end = localDate(new Date());
  while (localDate(d) <= end) {
    days.push(localDate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function renderDaily(rows, metric) {
  const box = $("daily");
  box.replaceChildren();
  const days = dayList(rows);
  const byDay = new Map(days.map((d) => [d, new Map()]));
  const ids = new Set();
  for (const r of rows) {
    const day = byDay.get(r[0]);
    if (!day) continue;
    const k = seriesKey(r[1]);
    ids.add(k);
    day.set(k, (day.get(k) || 0) + valueOf(r, metric));
  }
  const order = seriesOrder(ids);
  const totals = days.map((d) => [...byDay.get(d).values()].reduce((a, b) => a + b, 0));
  const maxV = niceMax(Math.max(0, ...totals));

  const W = 960, H = 240, L = 56, R = 8, T = 8, B = 24;
  const pw = W - L - R, ph = H - T - B;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "日別の推移" });

  for (let i = 0; i <= 4; i++) {
    const v = (maxV * i) / 4;
    const y = T + ph - (v / maxV) * ph;
    if (i > 0) root.append(svg("line", { class: "grid", x1: L, x2: W - R, y1: y, y2: y }));
    const t = svg("text", { x: L - 8, y: y + 4, "text-anchor": "end" });
    t.textContent = metric === "messages" ? nf.format(v) : metric === "cost" ? usd0.format(v) : compact(v);
    root.append(t);
  }

  const step = pw / days.length;
  const bw = Math.max(2, Math.min(24, step * 0.7));
  const labelEvery = Math.ceil(days.length / 10);

  days.forEach((day, i) => {
    const cx = L + step * i + step / 2;
    const vals = byDay.get(day);
    const present = order.filter((id) => vals.get(id) > 0);
    let y = T + ph;
    present.forEach((id, j) => {
      const h = (vals.get(id) / maxV) * ph;
      const top = j === present.length - 1;
      // セグメント同士の間に 2px の隙間を空ける
      const gap = j > 0 ? 2 : 0;
      const hh = Math.max(0, h - gap);
      const x = cx - bw / 2;
      const yTop = y - gap - hh;
      const node = top
        ? svg("path", { d: roundedTop(x, yTop, bw, hh, Math.min(4, bw / 2, hh)) })
        : svg("rect", { x, y: yTop, width: bw, height: hh });
      node.style.fill = colorVar(id);
      root.append(node);
      y -= h;
    });

    if (i % labelEvery === 0 || days.length <= 10) {
      const t = svg("text", { x: cx, y: H - 6, "text-anchor": "middle" });
      const [, mo, da] = day.split("-");
      t.textContent = `${+mo}/${+da}`;
      root.append(t);
    }

    const hit = svg("rect", { class: "hit", x: L + step * i, y: T, width: step, height: ph });
    hit.addEventListener("mousemove", (e) => {
      const [, mo, da] = day.split("-");
      const lines = order.filter((id) => vals.get(id) > 0).reverse()
        .map((id) => [id, modelLabel(id), fmtMetric(vals.get(id))]);
      showTip(e, `${+mo}/${+da}`, lines.length ? lines : [[null, "利用なし", ""]], lines.length > 1 ? fmtMetric(totals[i]) : null);
    });
    hit.addEventListener("mouseleave", hideTip);
    root.insertBefore(hit, root.firstChild);
  });
  root.append(svg("line", { class: "baseline", x1: L, x2: W - R, y1: T + ph, y2: T + ph }));
  box.append(root);
}

function roundedTop(x, y, w, h, r) {
  if (h <= 0) return "";
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const HEAT_STEPS = 6;

function renderHeatmap(metric) {
  const box = $("heatmap");
  box.replaceChildren();
  const from = periodStart();
  // grid[曜日(月=0)][時]。時間帯の行は [日付, 時, "", 応答数, …] で、値の位置は日別の行と同じ
  const grid = WEEKDAYS.map(() => Array(24).fill(0));
  for (const r of state.stats?.hours || []) {
    if (from && r[0] < from) continue;
    const wd = (new Date(r[0] + "T00:00:00").getDay() + 6) % 7;
    grid[wd][r[1]] += valueOf(r, metric);
  }
  const max = Math.max(0, ...grid.flat());

  const table = el("div", { class: "heat-grid", role: "img", "aria-label": `曜日と時間帯ごとの${METRIC_LABEL[metric]}` });
  table.append(el("span"));
  for (let h = 0; h < 24; h++) table.append(el("span", { class: "heat-hour", text: h % 3 === 0 ? String(h) : "" }));
  grid.forEach((row, wd) => {
    table.append(el("span", { class: "heat-day", text: WEEKDAYS[wd] }));
    row.forEach((v, h) => {
      const step = v > 0 && max > 0 ? Math.min(HEAT_STEPS, 1 + Math.floor((v / max) * HEAT_STEPS)) : 0;
      const cell = el("span", { class: "heat-cell s" + step });
      cell.addEventListener("mousemove", (e) => showTip(e, `${WEEKDAYS[wd]}曜 ${h}時台`, [[null, METRIC_LABEL[metric], fmtMetric(v)]]));
      cell.addEventListener("mouseleave", hideTip);
      table.append(cell);
    });
  });
  box.append(table);

  const legend = el("div", { class: "heat-legend muted small" }, "少");
  for (let i = 1; i <= HEAT_STEPS; i++) legend.append(el("span", { class: "heat-cell s" + i }));
  legend.append("多");
  if (!max) legend.append(el("span", { text: "（この期間の利用はありません）" }));
  box.append(legend);
}

function renderProjects(rows, metric) {
  $("project-metric-head").textContent = METRIC_LABEL[metric];
  const map = new Map();
  for (const r of rows) {
    const p = map.get(r[2]) || { msgs: 0, total: 0, models: new Map() };
    const v = valueOf(r, metric);
    p.msgs += r[3];
    p.total += v;
    const k = seriesKey(r[1]);
    p.models.set(k, (p.models.get(k) || 0) + v);
    map.set(r[2], p);
  }
  const list = [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  const tbody = $("project-table").tBodies[0];
  tbody.replaceChildren();
  for (const [name, p] of list) {
    const bar = el("div", { class: "mini-bar" });
    const parts = [];
    for (const id of seriesOrder(p.models.keys())) {
      const v = p.models.get(id);
      if (!v) continue;
      const s = el("span");
      s.style.flex = `${v} 0 0`;
      s.style.background = colorVar(id);
      bar.append(s);
      parts.push([id, modelLabel(id), pct((v / p.total) * 100)]);
    }
    bar.addEventListener("mousemove", (e) => showTip(e, name, parts));
    bar.addEventListener("mouseleave", hideTip);
    tbody.append(el("tr", {},
      el("td", { text: name }),
      el("td", {}, bar),
      el("td", { class: "num", text: nf.format(p.msgs) }),
      el("td", { class: "num", text: fmtMetric(p.total) }),
    ));
  }
  if (!list.length) tbody.append(el("tr", {}, el("td", { colspan: "4", class: "empty", text: "データなし" })));
}

// ---------- ツールチップ ----------

function showTip(e, title, lines, total = null) {
  const tip = $("tooltip");
  tip.replaceChildren(el("div", { class: "tt-title", text: title }));
  for (const [id, label, value] of lines) {
    const row = el("div", { class: "tt-row" });
    if (id) {
      const sw = el("span", { class: "swatch" });
      sw.style.background = colorVar(id);
      row.append(sw);
    }
    row.append(el("span", { text: label }), el("span", { class: "v", text: value }));
    tip.append(row);
  }
  if (total) tip.append(el("div", { class: "tt-row tt-total" }, el("span", { text: "合計" }), el("span", { class: "v", text: total })));
  tip.hidden = false;
  const pad = 12, r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, y) + "px";
}
function hideTip() {
  $("tooltip").hidden = true;
}

// ---------- 画面の操作 ----------

function updateStamp() {
  const t = state.limits?.fetchedAt;
  $("updated").textContent = t ? `上限: ${fmtDateTime(new Date(t * 1000))} 取得` : "";
}

function bindSeg(id, key, parse) {
  const box = $(id);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    for (const x of box.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    state[key] = parse(b.dataset.v);
    try { localStorage.setItem("rinari." + key, b.dataset.v); } catch (_) {}
    renderStats();
  });
  let saved = null;
  try { saved = localStorage.getItem("rinari." + key); } catch (_) {}
  const b = saved && box.querySelector(`button[data-v="${saved}"]`);
  if (b) {
    for (const x of box.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
    state[key] = parse(saved);
  }
}

bindSeg("period", "period", Number);
bindSeg("metric", "metric", String);

$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.disabled = true;
  await Promise.all([loadLimits(true), loadStats(true)]);
  btn.disabled = false;
});

renderStats();
loadLimits();
loadStats();
setInterval(loadLimits, LIMITS_INTERVAL_MS);
setInterval(loadStats, STATS_INTERVAL_MS);
// リセットまでの残り時間の表示を進める
setInterval(() => state.limits && renderLimits(), 60 * 1000);
