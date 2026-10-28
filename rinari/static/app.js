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

// 推定の内訳（記録あり／チャットなど）はモデルとは別の固定色
const FIXED_COLORS = { logged: "var(--est-logged)", unlogged: "var(--est-unlogged)" };

function colorVar(id) {
  if (id in FIXED_COLORS) return FIXED_COLORS[id];
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
    state.limits = { error: "璃奈ちゃんボードのサーバーに接続できません（起動しているか確認してください）", limits: [] };
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
    const budget = dailyBudget(item, data.fetchedAt);
    if (budget) card.append(budget);
    const usage = windowModels(item, data.fetchedAt);
    if (usage) card.append(usage);
    const est = estimateBox(item, data.fetchedAt);
    if (est) card.append(est);
    if (item.active) {
      card.append(el("span", { class: "badge active", text: "いま一番効いている枠" }));
    }
    box.append(card);
  }
  updateTitle(data);
  if (!data.error && !(data.limits || []).length) {
    box.append(el("p", { class: "empty", text: "利用上限の情報がありません" }));
  }
  renderEstimateDaily();
  renderSessionPlan();

  const ex = data.extraUsage;
  $("extra-usage").hidden = !(ex && ex.enabled && ex.monthlyLimit);
  if (ex && ex.enabled && ex.monthlyLimit) {
    $("extra-usage").textContent = `追加使用量: ${ex.usedCredits ?? 0} / ${ex.monthlyLimit} ${ex.currency || ""}`;
  }
  updateStamp();
}

// タブのタイトルに 5時間枠の使用率とリセットまでの時間を出す（タブを見るだけで分かるように）
function updateTitle(data) {
  const s = (data.limits || []).find((x) => x.kind === "session") || (data.limits || [])[0];
  if (!s || data.error && !data.stale) {
    document.title = "璃奈ちゃんボード";
    return;
  }
  let left = "";
  if (s.resetsAt) {
    const m = Math.max(0, Math.round((Date.parse(s.resetsAt) - Date.now()) / 60000));
    left = m >= 1440 ? `・あと${Math.floor(m / 1440)}日` : `・あと${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  }
  document.title = `${Math.round(s.percent)}%${left} | 璃奈ちゃんボード`;
}

// 枠の期間（始まり〜今）に会話ログで使ったモデルの内訳（料金換算）
function windowModels(item, fetchedAt) {
  if (!item.resetsAt || !fetchedAt || !state.stats?.hours) return null;
  const reset = Date.parse(item.resetsAt);
  const start = reset - windowLength(item);
  const now = fetchedAt * 1000;
  const onlyModel = scopeModel(item);
  const byModel = new Map();
  let cost = 0;
  for (const r of state.stats.hours) {
    const t = new Date(`${r[0]}T${String(r[1]).padStart(2, "0")}:00:00`).getTime();
    if (t + HOUR <= start || t > now) continue;
    if (onlyModel && !modelLabel(r[2]).toLowerCase().startsWith(onlyModel)) continue;
    const k = seriesKey(r[2]);
    byModel.set(k, (byModel.get(k) || 0) + r[8]);
    cost += r[8];
  }
  if (!cost) return null;
  const bar = el("div", { class: "mini-bar wide" });
  const parts = [];
  for (const id of seriesOrder(byModel.keys())) {
    const v = byModel.get(id);
    if (!v) continue;
    const s = el("span");
    s.style.flex = `${v} 0 0`;
    s.style.background = colorVar(id);
    bar.append(s);
    parts.push([id, modelLabel(id), `${pct((v / cost) * 100)}（${usd(v)}）`]);
  }
  bar.addEventListener("mousemove", (e) => showTip(e, "この枠で使ったモデル", parts, usd(cost)));
  bar.addEventListener("mouseleave", hideTip);
  const top = parts.slice(0, 2).map(([, label, v]) => `${label} ${v.split("（")[0]}`).join("・");
  const per = item.percent >= 1 ? `・1% あたり約 ${usd(cost / item.percent)}` : "";
  return el("div", { class: "window-models" },
    el("div", { class: "small muted", text: `この枠で使ったモデル: ${usd(cost)} 相当${per}` }),
    bar,
    el("div", { class: "small", text: top }));
}

// モデル別の週間枠（例: 週間（Fable））はそのモデルだけを数える。対象のモデル名（小文字）か null
function scopeModel(item) {
  const only = /^週間（(.+)）$/.exec(item.label)?.[1];
  return only && only !== "全モデル" ? only.toLowerCase() : null;
}

// ---------- 利用上限の推移と予測 ----------

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

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

// ---------- 1日あたりの目安（週間枠） ----------

// 週間枠の残りを、リセットまでの日数で均した「今日使ってよい量」
function dailyBudget(item, fetchedAt) {
  if (!item.resetsAt || !fetchedAt || windowLength(item) !== 7 * DAY || item.percent >= 100) return null;
  const now = fetchedAt * 1000;
  const reset = Date.parse(item.resetsAt);
  if (reset <= now) return null;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = reset - windowLength(item);
  // 今日の始まりの使用率。枠が今日始まったなら 0、そうでなければ今日の最初の記録
  let base, baseAt;
  if (start >= midnight.getTime()) [baseAt, base] = [start, 0];
  else [baseAt, base] = windowPoints(item, fetchedAt).find(([t]) => t >= midnight.getTime());
  const allowance = (100 - base) / Math.max(1, (reset - midnight) / DAY);
  const used = Math.max(0, item.percent - base);
  const ratio = allowance > 0 ? used / allowance : 1;
  const daysLeft = (reset - now) / DAY;
  const perDay = (100 - item.percent) / Math.max(1, daysLeft);

  const fill = el("span");
  fill.style.width = Math.min(100, ratio * 100) + "%";
  const sev = ratio > 1 ? "critical" : ratio > 0.8 ? "warning" : "normal";
  const late = baseAt - midnight > 30 * 60 * 1000 && start < midnight;
  return el("div", { class: "budget" },
    el("div", { class: "small" },
      el("span", { text: `今日の目安 約${pct(allowance)}` }),
      el("span", { class: "budget-used" + (ratio > 1 ? " over" : ""),
        text: ratio > 1 ? `（今日 +${pct(used)}・目安を超えています）` : `（今日はここまで +${pct(used)}）` })),
    el("div", { class: "meter small-bar " + sev }, fill),
    el("div", { class: "small muted", text:
      (daysLeft < 1
        ? `リセットまでに使えるのは残り ${pct(100 - item.percent)}`
        : `残り ${pct(100 - item.percent)} をあと${daysLeft.toFixed(1)}日で均すと1日 約${pct(perDay)}`)
      + (late ? `（今日の記録は ${fmtTime(new Date(baseAt))} から）` : "") }));
}

// ---------- チャット・Cowork の推定 ----------
// 利用上限の % はチャットや Cowork も含む全体の値だが、会話ログには Code（と一部の Cowork）しか残らない。
// 「会話ログの料金換算で説明できる分」を差し引いた残りを、チャットなど記録のない利用と推定する。
// 枠の減り方が料金換算にほぼ比例する、という前提の目安。

const costCache = new Map(); // 対象のモデル -> 5分ごとの料金換算の累積
const CAL_MIN_SEGMENTS = 3;

function costSeries(onlyModel) {
  const key = onlyModel || "";
  let s = costCache.get(key);
  if (s) return s;
  const byT = new Map();
  for (const [t, model, v] of state.stats?.buckets || []) {
    if (onlyModel && !modelLabel(model).toLowerCase().startsWith(onlyModel)) continue;
    byT.set(t, (byT.get(t) || 0) + v);
  }
  const ts = [...byT.keys()].sort((a, b) => a - b);
  const sum = [0];
  for (const t of ts) sum.push(sum[sum.length - 1] + byT.get(t));
  s = { ts: ts.map((t) => t * 1000), sum };
  costCache.set(key, s);
  return s;
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// a 以上 b 未満に会話ログで使った料金換算（5分刻み）
function costBetween(s, a, b) {
  return s.sum[lowerBound(s.ts, b)] - s.sum[lowerBound(s.ts, a)];
}

// 記録を枠（リセット時刻が同じもの）ごとにまとめる。各枠の点の先頭には始まり（0%）を置く
function historyWindows(label, length) {
  const map = new Map();
  for (const e of state.history) {
    for (const x of e.limits) {
      if (x.label !== label || !x.resetsAt) continue;
      const reset = Date.parse(x.resetsAt);
      const key = Math.round(reset / (15 * 60 * 1000));
      let w = map.get(key);
      if (!w) map.set(key, (w = { reset, pts: [[reset - length, 0]] }));
      w.pts.push([e.t * 1000, x.percent]);
    }
  }
  for (const w of map.values()) w.pts.sort((a, b) => a[0] - b[0]);
  return [...map.values()];
}

// 5時間枠の 1% が週間枠の何% にあたるか。どちらもチャットを含む全体の値なので記録だけで分かる
function sessionPerWeekly(label) {
  const SAME = 2 * 60 * 1000;
  let ds = 0, dw = 0, prev = null;
  for (const e of state.history) {
    const s = e.limits.find((x) => x.kind === "session");
    const w = e.limits.find((x) => x.label === label);
    const cur = s?.resetsAt && w?.resetsAt ? { s: Date.parse(s.resetsAt), w: Date.parse(w.resetsAt), ps: s.percent, pw: w.percent } : null;
    if (prev && cur && Math.abs(cur.s - prev.s) < SAME && Math.abs(cur.w - prev.w) < SAME) {
      ds += Math.max(0, cur.ps - prev.ps);
      dw += Math.max(0, cur.pw - prev.pw);
    }
    prev = cur;
  }
  return dw >= 3 ? ds / dw : null;
}

// 使用率 1% が料金換算でいくらにあたるか（k）。
// 記録を区間に分け、区間ごとの「料金換算 ÷ 増えた%」を求める。チャットを使った区間は % だけ増えて値が小さくなるので、
// 大きい方（80パーセンタイル）を Code だけを使ったときの値とみなす。
function calibrate(item) {
  const length = windowLength(item);
  const session = length === 5 * HOUR;
  const s = costSeries(scopeModel(item));
  const minSpan = session ? 30 * 60 * 1000 : 6 * HOUR;
  const minDelta = session ? 3 : 2; // % は整数でしか返らないので、ある程度増えた区間だけを使う
  const ratios = [];
  for (const w of historyWindows(item.label, length)) {
    let a = w.pts[0];
    for (const b of w.pts.slice(1)) {
      if (b[0] - a[0] < minSpan || b[1] - a[1] < minDelta) continue;
      const c = costBetween(s, a[0], b[0]);
      if (c >= 0.5) ratios.push(c / (b[1] - a[1]));
      a = b;
    }
  }
  if (ratios.length >= CAL_MIN_SEGMENTS) {
    ratios.sort((x, y) => x - y);
    return { k: ratios[Math.floor(0.8 * (ratios.length - 1))], n: ratios.length, from: "self" };
  }
  // 週間枠は増え方がゆっくりで区間が集まりにくいので、5時間枠の値から換算する
  if (!session && !scopeModel(item)) {
    const sess = (state.limits?.limits || []).find((x) => x.kind === "session");
    const ks = sess && calibrate(sess);
    const r = sessionPerWeekly(item.label);
    if (ks && r) return { k: ks.k * r, n: ks.n, from: "session" };
  }
  return null;
}

function estimate(item, fetchedAt) {
  if (!item.resetsAt || !fetchedAt || !state.stats?.buckets) return null;
  const cal = calibrate(item);
  if (!cal) return { pending: true };
  const start = Date.parse(item.resetsAt) - windowLength(item);
  const cost = costBetween(costSeries(scopeModel(item)), start, fetchedAt * 1000);
  const logged = Math.min(item.percent, cost / cal.k);
  return { cal, cost, logged, unlogged: Math.max(0, item.percent - logged) };
}

function calBasis(cal) {
  return cal.from === "session"
    ? `1% ≈ ${usd(cal.k)}（5時間枠の推定から換算）`
    : `1% ≈ ${usd(cal.k)}（Code を使った ${cal.n} 区間から推定）`;
}

function estimateBox(item, fetchedAt) {
  const e = estimate(item, fetchedAt);
  if (!e) return null;
  if (e.pending) {
    return el("div", { class: "estimate small muted",
      text: "チャット・Cowork の推定: Code を使った時間帯の記録が貯まると表示します" });
  }
  if (!item.percent) return null;
  const bar = el("div", { class: "mini-bar wide" });
  for (const id of ["logged", "unlogged"]) {
    if (!e[id]) continue;
    const s = el("span");
    s.style.flex = `${e[id]} 0 0`;
    s.style.background = colorVar(id);
    bar.append(s);
  }
  const lines = [
    ["logged", "記録あり（Code・Cowork）", `${pct(e.logged)}（${usd(e.cost)}）`],
    ["unlogged", "チャットなど（推定）", pct(e.unlogged)],
  ];
  bar.addEventListener("mousemove", (ev) => showTip(ev, "この枠の内訳（推定）", lines));
  bar.addEventListener("mouseleave", hideTip);
  const share = (e.unlogged / item.percent) * 100;
  return el("div", { class: "estimate" },
    el("div", { class: "small", text: `チャット・Cowork など（推定）: 約${pct(e.unlogged)}（使った分の${Math.round(share)}%）` }),
    bar,
    el("div", { class: "small muted", text: calBasis(e.cal) }));
}

// 週間枠の増え方を日ごとに「記録あり」と「チャットなど」に分ける（直近7日）
function renderEstimateDaily() {
  const box = $("estimate-daily");
  box.replaceChildren();
  const item = (state.limits?.limits || []).find((x) => x.kind === "weekly_all");
  const cal = item && state.stats?.buckets ? calibrate(item) : null;
  if (!cal) {
    box.append(el("p", { class: "empty", text: item
      ? "Code を使った時間帯の記録が貯まると表示します（璃奈ちゃんボードを起動しているあいだ5分ごとに記録します）"
      : "週間枠の情報がありません" }));
    return;
  }
  const s = costSeries(null);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(localDate(d));
  }
  const byDay = new Map(days.map((d) => [d, { delta: 0, cost: 0 }]));
  // 記録の区間ごとに、増えた% と料金換算を区間の終わりの日に足す。
  // 長く間が空いた区間（璃奈ちゃんボードを止めていた間や、記録を始める前）はどの日の分か分からないので数えない
  for (const w of historyWindows(item.label, windowLength(item))) {
    for (let i = 1; i < w.pts.length; i++) {
      const [a, pa] = w.pts[i - 1], [b, pb] = w.pts[i];
      const d = byDay.get(localDate(new Date(b)));
      if (!d || b - a > 12 * HOUR) continue;
      d.delta += Math.max(0, pb - pa);
      d.cost += costBetween(s, a, b);
    }
  }
  const rows = days.map((day) => {
    const d = byDay.get(day);
    const logged = Math.min(d.delta, d.cost / cal.k);
    return { day, delta: d.delta, logged, unlogged: d.delta - logged };
  });
  const max = Math.max(1, ...rows.map((r) => r.delta));
  const total = rows.reduce((a, r) => [a[0] + r.delta, a[1] + r.unlogged], [0, 0]);

  box.append(el("p", { class: "small", text: total[0]
    ? `直近7日で週間枠を ${pct(total[0])} 使い、そのうち約 ${pct(total[1])}（${Math.round((total[1] / total[0]) * 100)}%）がチャット・Cowork など記録のない利用と推定されます。`
    : "直近7日の記録では、週間枠は増えていません。" }));
  const table = el("table", { class: "bars-table" });
  const tbody = el("tbody");
  for (const r of rows) {
    const [, mo, da] = r.day.split("-");
    const label = `${+mo}/${+da}（${WEEKDAYS[new Date(r.day + "T00:00:00").getDay()]}）`;
    const bar = el("span", { class: "hbar stack" });
    for (const id of ["logged", "unlogged"]) {
      if (r[id] <= 0) continue;
      const seg = el("span");
      seg.style.width = (r[id] / max) * 100 + "%";
      seg.style.background = colorVar(id);
      bar.append(seg);
    }
    const lines = [["logged", "記録あり（Code・Cowork）", pct(r.logged)], ["unlogged", "チャットなど（推定）", pct(r.unlogged)]];
    bar.addEventListener("mousemove", (e) => showTip(e, label, lines, pct(r.delta)));
    bar.addEventListener("mouseleave", hideTip);
    tbody.append(el("tr", {},
      el("td", { text: label }),
      el("td", { class: "bar-cell" }, bar),
      el("td", { class: "num", text: r.delta ? `+${pct(r.delta)}` : "-" }),
      el("td", { class: "num muted", text: r.delta ? `チャットなど ${pct(r.unlogged)}` : "" }),
    ));
  }
  table.append(tbody);
  const legend = el("div", { class: "legend" });
  for (const [id, name] of [["logged", "記録あり（Code・Cowork）"], ["unlogged", "チャット・Cowork など（推定）"]]) {
    const sw = el("span", { class: "swatch" });
    sw.style.background = colorVar(id);
    legend.append(el("div", { class: "legend-item" }, sw, el("span", { text: name })));
  }
  box.append(el("div", { class: "table-wrap" }, table), legend,
    el("p", { class: "muted small", text: `週間枠の ${calBasis(cal)}。日ごとの値は璃奈ちゃんボードを起動していた間の記録だけを数えています。` }));
}

// ---------- 5時間枠の始まる時刻 ----------
// 5時間枠は最初に送ったときから5時間。使い始める前に短いメッセージで枠を始めておくと、
// 忙しい時間帯の途中でリセットされ、1つの枠に使い方が集中しにくくなる。

const PLAN_MIN_DAYS = 3;
const PLAN_MIN_USE = 0.5; // 1時間あたりの平均がこれ以上の時間帯を「使う時間」とみなす（5時間枠の%）

// 時間帯ごとの 5時間枠の増え方（1日あたりの平均）。チャットも含む全体の値
function sessionProfile(weekdaysOnly) {
  const sum = Array(24).fill(0);
  const cover = Array.from({ length: 24 }, () => new Set());
  let prev = null;
  for (const e of state.history) {
    const x = e.limits.find((l) => l.kind === "session");
    if (!x) {
      prev = null;
      continue;
    }
    const t = e.t * 1000;
    const d = new Date(t);
    const wd = d.getDay();
    // 間が空いた（璃奈ちゃんボードを止めていた）ところは、どの時間帯に使ったか分からないので数えない
    if (prev && t - prev.t <= 15 * 60 * 1000 && (!weekdaysOnly || (wd >= 1 && wd <= 5))) {
      const same = x.resetsAt && prev.resetsAt && Math.abs(Date.parse(x.resetsAt) - Date.parse(prev.resetsAt)) < 2 * 60 * 1000;
      sum[d.getHours()] += same ? Math.max(0, x.percent - prev.percent) : x.percent;
      cover[d.getHours()].add(localDate(d));
    }
    prev = { t, percent: x.percent, resetsAt: x.resetsAt };
  }
  const days = new Set(cover.flatMap((c) => [...c]));
  return { u: sum.map((v, h) => (cover[h].size ? v / cover[h].size : 0)), days: days.size };
}

// 1日の枠の並びを作る。primer の時刻には使っていなくても枠を始める
function planWindows(u, primer) {
  const wins = [];
  let end = 0;
  for (let h = 0; h < 24; h++) {
    if (h < end || (h !== primer && u[h] < PLAN_MIN_USE)) continue;
    wins.push({ start: h, load: u.slice(h, h + 5).reduce((a, b) => a + b, 0) });
    end = h + 5;
  }
  return wins;
}

const peakOf = (wins) => Math.max(0, ...wins.map((w) => w.load));

function renderSessionPlan() {
  const box = $("session-plan");
  box.replaceChildren();
  let prof = sessionProfile(true), scope = "平日";
  if (prof.days < PLAN_MIN_DAYS) [prof, scope] = [sessionProfile(false), "毎日"];
  if (prof.days < PLAN_MIN_DAYS) {
    box.append(el("p", { class: "empty",
      text: `璃奈ちゃんボードの記録が${PLAN_MIN_DAYS}日分貯まると、時間帯ごとの使い方から提案します（いま${prof.days}日分）` }));
    return;
  }
  const u = prof.u;
  const base = planWindows(u, null);
  let best = null;
  for (let s = 0; s < 24; s++) {
    const wins = planWindows(u, s);
    // 同じくらいなら遅い方（使い始めに近い方）を選ぶ
    if (!best || peakOf(wins) <= peakOf(best.wins) + 0.01) best = { s, wins };
  }
  const basePeak = peakOf(base), bestPeak = peakOf(best.wins);
  const better = basePeak - bestPeak >= 5 && bestPeak <= basePeak * 0.85 && best.wins[0]?.start !== base[0]?.start;
  const shown = better ? best.wins : base;
  const hours = (wins) => wins.map((w) => w.start + "時").join("・");

  if (!base.length) {
    box.append(el("p", { class: "small", text: `${scope}（${prof.days}日分）の記録では、5時間枠をほとんど使っていません。` }));
  } else {
    box.append(el("p", { class: "small", text:
      `いつもの使い方（${scope}・${prof.days}日分の平均）だと、枠は ${hours(base)} に始まり、いちばん多い枠で 5時間枠の約${Math.round(basePeak)}% を使います。`
      + (basePeak >= 100 ? "上限に達しやすい使い方です。" : "") }));
    box.append(el("p", { class: "plan-advice" + (better ? "" : " muted"), text: better
      ? `${best.s}時台に短いメッセージを1つ送って枠を始めておくと、枠は ${hours(best.wins)} に始まり、いちばん多い枠は約${Math.round(bestPeak)}% に下がります。`
      : "今の始まり方で枠ごとの偏りは小さく、始める時刻をずらしても大きくは変わりません。" }));
  }

  // 時間帯ごとの平均（棒）と、枠の区切り（帯）
  const W = 960, H = 140, L = 40, R = 8, T = 8, B = 20;
  const pw = W - L - R, ph = H - T - B;
  const maxV = niceMax(Math.max(1, ...u));
  const x = (h) => L + (h / 24) * pw;
  const y = (v) => T + ph - (v / maxV) * ph;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `時間帯ごとの5時間枠の使い方。枠は ${hours(shown)} に始まります` });
  shown.forEach((w, i) => {
    root.append(svg("rect", { class: "band" + (i % 2 ? " alt" : ""), x: x(w.start), y: T,
      width: x(Math.min(24, w.start + 5)) - x(w.start), height: ph }));
  });
  for (let i = 0; i <= 2; i++) {
    const v = (maxV * i) / 2;
    if (i > 0) root.append(svg("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    const t = svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = Math.round(v) + "%";
    root.append(t);
  }
  const step = pw / 24, bw = step * 0.6;
  u.forEach((v, h) => {
    const cx = x(h) + step / 2;
    if (v > 0) {
      const node = svg("path", { d: roundedTop(cx - bw / 2, y(v), bw, T + ph - y(v), Math.min(3, (T + ph - y(v)) / 2)) });
      node.style.fill = "var(--series-1)";
      root.append(node);
    }
    if (h % 3 === 0) {
      const t = svg("text", { x: x(h), y: H - 4, "text-anchor": "middle" });
      t.textContent = String(h);
      root.append(t);
    }
    const hit = svg("rect", { class: "hit", x: x(h), y: T, width: step, height: ph });
    hit.addEventListener("mousemove", (e) => {
      const w = shown.find((w) => h >= w.start && h < w.start + 5);
      const lines = [[null, "1日あたりの平均", `${pct(v)}`]];
      if (w) lines.push([null, `${w.start}時に始まる枠の合計`, `約${Math.round(w.load)}%`]);
      showTip(e, `${h}時台`, lines);
    });
    hit.addEventListener("mouseleave", hideTip);
    root.insertBefore(hit, root.firstChild);
  });
  root.append(svg("line", { class: "baseline", x1: L, x2: W - R, y1: T + ph, y2: T + ph }));
  box.append(el("div", { class: "chart" }, root));
  box.append(el("p", { class: "muted small", text:
    "棒は時間帯ごとの5時間枠の増え方（1日あたりの平均、チャットも含む）、帯は" + (better ? "提案どおりに始めたときの" : "いつもの") + "枠です。璃奈ちゃんボードを起動していた時間だけを数えています。" }));
}

// ---------- モデル別の使用割合 ----------

async function loadStats(force = false) {
  try {
    const res = await fetch("/api/stats" + (force ? "?force=1" : ""));
    state.stats = await res.json();
    costCache.clear();
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
  renderCache(rows);
  renderProjects(rows, metric);
  renderSessions(metric);
  renderReview(metric);
  // 利用上限のカードにある「この枠で使ったモデル」は会話ログの集計を使う
  if (state.limits) renderLimits();
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

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const HEAT_STEPS = 6;

function renderHeatmap(metric) {
  const box = $("heatmap");
  box.replaceChildren();
  const from = periodStart();
  // grid[曜日(日=0)][時]。時間帯の行は [日付, 時, モデル, 応答数, …] で、値の位置は日別の行と同じ
  const grid = WEEKDAYS.map(() => Array(24).fill(0));
  for (const r of state.stats?.hours || []) {
    if (from && r[0] < from) continue;
    const wd = new Date(r[0] + "T00:00:00").getDay();
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

function modelBar(models, total) {
  // models: Map(モデル -> 値)。「その他」にまとめてから割合のバーにする
  const merged = new Map();
  for (const [id, v] of models) merged.set(seriesKey(id), (merged.get(seriesKey(id)) || 0) + v);
  const bar = el("div", { class: "mini-bar" });
  const parts = [];
  for (const id of seriesOrder(merged.keys())) {
    const v = merged.get(id);
    if (!v) continue;
    const s = el("span");
    s.style.flex = `${v} 0 0`;
    s.style.background = colorVar(id);
    bar.append(s);
    parts.push([id, modelLabel(id), pct((v / total) * 100)]);
  }
  return { bar, parts };
}

// ---------- キャッシュの効率 ----------

function renderCache(rows) {
  const byModel = new Map();
  const sum = [0, 0, 0, 0, 0];
  for (const r of rows) {
    const k = seriesKey(r[1]);
    const m = byModel.get(k) || [0, 0, 0, 0];
    m[0] += r[4]; m[1] += r[6]; m[2] += r[7]; m[3] += r[9] || 0;
    byModel.set(k, m);
    sum[0] += r[4]; sum[1] += r[6]; sum[2] += r[7]; sum[3] += r[9] || 0; sum[4] += r[8];
  }
  const rate = (m) => (m[0] + m[1] + m[2] ? (m[2] / (m[0] + m[1] + m[2])) * 100 : 0);
  const stats = $("cache-stats");
  stats.replaceChildren();
  for (const [label, value] of [
    ["キャッシュ読込率", pct(rate(sum))],
    ["節約額", usd(sum[3])],
    ["キャッシュなしの場合", usd(sum[4] + sum[3])],
    ["実際（料金換算）", usd(sum[4])],
  ]) {
    stats.append(el("div", { class: "stat" }, el("div", { class: "stat-label", text: label }), el("div", { class: "stat-value", text: value })));
  }
  const tbody = $("cache-table").tBodies[0];
  tbody.replaceChildren();
  const models = seriesOrder(byModel.keys());
  for (const id of models) {
    const m = byModel.get(id);
    const sw = el("span", { class: "swatch" });
    sw.style.background = colorVar(id);
    const fill = el("span");
    fill.style.width = rate(m) + "%";
    tbody.append(el("tr", {},
      el("td", {}, el("span", { class: "cell-model" }, sw, modelLabel(id))),
      el("td", {}, el("span", { class: "rate" }, el("span", { class: "meter small-meter" }, fill), pct(rate(m)))),
      el("td", { class: "num", text: compact(m[0]) }),
      el("td", { class: "num", text: compact(m[1]) }),
      el("td", { class: "num", text: compact(m[2]) }),
      el("td", { class: "num", text: usd(m[3]) }),
    ));
  }
  if (!models.length) tbody.append(el("tr", {}, el("td", { colspan: "6", class: "empty", text: "データなし" })));
}

// ---------- 会話別 ----------

const SESSION_LIMIT = 20;

function sessionValue(models, metric) {
  // models: { モデル: [応答数, 入力, 出力, キャッシュ作成, キャッシュ読込, 料金換算, 節約] }
  let v = 0;
  for (const m of Object.values(models)) v += valueOf([null, null, null, ...m], metric);
  return v;
}

function filteredSessions() {
  const from = periodStart();
  const fromMs = from ? new Date(from + "T00:00:00").getTime() : 0;
  return (state.stats?.sessions || []).filter((s) => s[4] * 1000 >= fromMs);
}

function renderSessions(metric) {
  $("session-metric-head").textContent = METRIC_LABEL[metric];
  const list = filteredSessions()
    .map((s) => ({ s, v: sessionValue(s[5], metric), msgs: sessionValue(s[5], "messages") }))
    .sort((a, b) => b.v - a.v);
  const tbody = $("session-table").tBodies[0];
  tbody.replaceChildren();
  for (const { s, v, msgs } of list.slice(0, SESSION_LIMIT)) {
    const [, project, title, , last, models] = s;
    const per = new Map(Object.entries(models).map(([id, m]) => [id, valueOf([null, null, null, ...m], metric)]));
    const { bar, parts } = modelBar(per, v || 1);
    const name = title || "（無題）";
    bar.addEventListener("mousemove", (e) => showTip(e, name, parts));
    bar.addEventListener("mouseleave", hideTip);
    tbody.append(el("tr", {},
      el("td", { class: "cell-session" }, el("span", { class: "session-title", text: name, title: name }),
        el("span", { class: "muted small", text: project })),
      el("td", {}, bar),
      el("td", { class: "num", text: fmtDateTime(new Date(last * 1000)) }),
      el("td", { class: "num", text: nf.format(msgs) }),
      el("td", { class: "num", text: fmtMetric(v) }),
    ));
  }
  if (!list.length) tbody.append(el("tr", {}, el("td", { colspan: "5", class: "empty", text: "データなし" })));
  $("session-note").textContent = list.length > SESSION_LIMIT
    ? `この期間に使った ${nf.format(list.length)} 件の会話のうち、上位 ${SESSION_LIMIT} 件です。値は会話全体の合計です（期間より前の分も含みます）。`
    : "値は会話全体の合計です（期間より前の分も含みます）。";
}

// ---------- 振り返り ----------

function sumRange(rows, from, to) {
  // from 以上 to 以下の日付（YYYY-MM-DD）の合計 [料金換算, 応答数, 全トークン, 選んだ値]
  const out = [0, 0, 0, 0];
  for (const r of rows) {
    if (r[0] < from || r[0] > to) continue;
    out[0] += r[8];
    out[1] += r[3];
    out[2] += r[4] + r[5] + r[6] + r[7];
    out[3] += valueOf(r, state.metric);
  }
  return out;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function change(cur, prev) {
  if (!prev) return cur ? "新規" : "-";
  const c = ((cur - prev) / prev) * 100;
  return (c >= 0 ? "+" : "") + (Math.abs(c) < 10 ? c.toFixed(1) : Math.round(c)) + "%";
}

function renderReview(metric) {
  const rows = state.stats?.rows || [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const wd = today.getDay();
  const weekStart = addDays(today, -wd);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  // 先月の「今日と同じ日」。先月が短いときは月末で止める
  const prevMonthSameDay = new Date(Math.min(
    new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth(), today.getDate()).getTime(),
    addDays(monthStart, -1).getTime()));
  const D = localDate;
  const periods = [
    ["今週（日曜〜今日）", sumRange(rows, D(weekStart), D(today)), sumRange(rows, D(addDays(weekStart, -7)), D(addDays(today, -7)))],
    ["先週", sumRange(rows, D(addDays(weekStart, -7)), D(addDays(weekStart, -1))), sumRange(rows, D(addDays(weekStart, -14)), D(addDays(weekStart, -8)))],
    ["今月（1日〜今日）", sumRange(rows, D(monthStart), D(today)), sumRange(rows, D(prevMonthStart), D(prevMonthSameDay))],
    ["先月", sumRange(rows, D(prevMonthStart), D(addDays(monthStart, -1))),
      sumRange(rows, D(new Date(today.getFullYear(), today.getMonth() - 2, 1)), D(addDays(prevMonthStart, -1)))],
  ];
  $("compare-metric-head").textContent = `前の期間比（${METRIC_LABEL[metric]}）`;
  const tbody = $("compare-table").tBodies[0];
  tbody.replaceChildren();
  for (const [label, cur, prev] of periods) {
    tbody.append(el("tr", {},
      el("td", { text: label }),
      el("td", { class: "num", text: usd(cur[0]) }),
      el("td", { class: "num", text: nf.format(cur[1]) }),
      el("td", { class: "num", text: compact(cur[2]) }),
      el("td", { class: "num", text: change(cur[3], prev[3]) }),
    ));
  }

  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const s = addDays(weekStart, -7 * i);
    const e = addDays(s, 6);
    weeks.push([`${s.getMonth() + 1}/${s.getDate()}〜${e.getMonth() + 1}/${e.getDate()}`, sumRange(rows, D(s), D(e))[3]]);
  }
  renderBars("weekly-table", weeks, "前週比");
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const s = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const e = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
    months.push([`${s.getFullYear()}/${s.getMonth() + 1}`, sumRange(rows, D(s), D(e))[3]]);
  }
  renderBars("monthly-table", months, "前月比");
}

function renderBars(id, items, changeLabel) {
  const tbody = $(id).tBodies[0];
  tbody.replaceChildren();
  const max = Math.max(0, ...items.map((x) => x[1]));
  // 記録が始まる前の空の期間は出さない
  const firstUsed = items.findIndex((x) => x[1] > 0);
  if (firstUsed < 0) {
    tbody.append(el("tr", {}, el("td", { class: "empty", text: "データなし" })));
    return;
  }
  items.forEach(([label, v], i) => {
    if (i < firstUsed) return;
    const fill = el("span");
    fill.style.width = (max ? (v / max) * 100 : 0) + "%";
    tbody.append(el("tr", {},
      el("td", { text: label }),
      el("td", { class: "bar-cell" }, el("span", { class: "hbar" }, fill)),
      el("td", { class: "num", text: fmtMetric(v) }),
      el("td", { class: "num muted", text: i > firstUsed ? `${changeLabel} ${change(v, items[i - 1][1])}` : "" }),
    ));
  });
}

// ---------- CSV ----------

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(name, header, lines) {
  // Excel で文字化けしないよう BOM を付ける
  const text = "﻿" + [header, ...lines].map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function periodSuffix() {
  const from = periodStart();
  return (from ? from : "all") + "_" + localDate(new Date());
}

$("export-rows").addEventListener("click", () => {
  downloadCsv(`璃奈ちゃんボード-usage_${periodSuffix()}.csv`,
    ["日付", "モデル", "プロジェクト", "応答数", "入力", "出力", "キャッシュ作成", "キャッシュ読込", "料金換算USD", "キャッシュ節約USD"],
    filteredRows());
});

$("export-sessions").addEventListener("click", () => {
  const lines = [];
  for (const [id, project, title, first, last, models] of filteredSessions()) {
    for (const [model, m] of Object.entries(models)) {
      lines.push([id, project, title || "", fmtIso(first), fmtIso(last), model, ...m]);
    }
  }
  downloadCsv(`璃奈ちゃんボード-sessions_${periodSuffix()}.csv`,
    ["会話ID", "プロジェクト", "タイトル", "開始", "最終", "モデル", "応答数", "入力", "出力", "キャッシュ作成", "キャッシュ読込", "料金換算USD", "キャッシュ節約USD"],
    lines);
});

function fmtIso(sec) {
  const d = new Date(sec * 1000);
  return `${localDate(d)} ${fmtTime(d).padStart(5, "0")}`;
}

// ---------- 動作状態 ----------

const HEALTH_TEXT = { critical: "問題", warning: "注意", info: "お知らせ" };

async function loadHealth() {
  let issues;
  try {
    issues = (await (await fetch("/api/health")).json()).issues || [];
  } catch (e) {
    issues = [{ level: "critical", text: "璃奈ちゃんボードのサーバーに接続できません（起動しているか確認してください）" }];
  }
  const box = $("health");
  box.replaceChildren(...issues.map((x) =>
    el("li", { class: "health-item " + x.level }, el("strong", { text: HEALTH_TEXT[x.level] || "" }), el("span", { text: x.text }))));
  box.hidden = !issues.length;
}

// ---------- 開閉 ----------

function setFold(box, open) {
  box.classList.toggle("folded", !open);
  box.querySelector(".fold").setAttribute("aria-expanded", String(open));
  box.querySelector(":scope > .fold-body").hidden = !open;
}

function initFolds() {
  const boxes = [...document.querySelectorAll("[data-fold]")];
  for (const box of boxes) {
    const key = "rinari.fold." + box.dataset.fold;
    const body = box.querySelector(":scope > .fold-body");
    body.id = "fold-" + box.dataset.fold;
    box.querySelector(".fold").setAttribute("aria-controls", body.id);
    let saved = null;
    try { saved = localStorage.getItem(key); } catch (_) {}
    setFold(box, saved !== "0");
    box.querySelector(".fold").addEventListener("click", () => {
      const open = box.classList.contains("folded");
      setFold(box, open);
      try { localStorage.setItem(key, open ? "1" : "0"); } catch (_) {}
      syncFoldAll();
    });
  }
  const syncFoldAll = () => {
    $("fold-all").textContent = boxes.every((b) => b.classList.contains("folded")) ? "すべて開く" : "すべて閉じる";
  };
  $("fold-all").addEventListener("click", () => {
    const open = boxes.every((b) => b.classList.contains("folded"));
    for (const box of boxes) {
      setFold(box, open);
      try { localStorage.setItem("rinari.fold." + box.dataset.fold, open ? "1" : "0"); } catch (_) {}
    }
    syncFoldAll();
  });
  syncFoldAll();
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
  await loadHealth();
  btn.disabled = false;
});

initFolds();
renderStats();
loadLimits().then(loadHealth);
loadStats();
setInterval(loadLimits, LIMITS_INTERVAL_MS);
setInterval(loadStats, STATS_INTERVAL_MS);
setInterval(loadHealth, 60 * 1000);
// リセットまでの残り時間の表示を進める
setInterval(() => state.limits && renderLimits(), 60 * 1000);
