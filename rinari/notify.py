"""利用上限の通知。取得のたびに使用率と予測を調べ、知らせることがあれば溜めておく。

溜めた通知はタスクトレイ（tray.ps1）が /api/alerts で受け取り、Windows の通知として出す。
同じ枠・同じ内容では一度しか知らせない（Rinari を再起動しても繰り返さないよう記録を残す）。
"""

import json
import os
import threading
import time
from datetime import datetime

from . import limits
from .paths import cache_dir

THRESHOLDS = (80, 95)       # 使用率がこれを超えたら知らせる（%）
FORECAST_MINUTES = 30       # このペースだとこの時間以内に上限に達するなら知らせる
ERROR_REPEAT = 2            # 取得の失敗がこの回数続いたら知らせる
KEEP_ALERTS = 50

_lock = threading.Lock()
_alerts = []
_seq = {"n": 0}
_errors = {"count": 0, "notified": False}
_fired = None  # 知らせ済みのキー -> 期限（UNIX秒）


def _state_path():
    return cache_dir() / "notify-state.json"


def _load_fired():
    try:
        d = json.loads(_state_path().read_text(encoding="utf-8"))
        return {k: float(v) for k, v in d.get("fired", {}).items()}
    except (OSError, ValueError, AttributeError):
        return {}


def _save_fired():
    path = _state_path()
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps({"fired": _fired}), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def _push(level, title, body):
    _seq["n"] += 1
    _alerts.append({"id": _seq["n"], "t": time.time(), "level": level, "title": title, "body": body})
    del _alerts[:-KEEP_ALERTS]


def _once(key, until, level, title, body):
    """key で一度だけ知らせる。until を過ぎた記録は捨てる"""
    if key in _fired:
        return False
    _fired[key] = until
    _push(level, title, body)
    return True


def _parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def _hm(ts):
    return datetime.fromtimestamp(ts).strftime("%H:%M")


def _recent_rate(label, reset, now, span):
    """直近 span 秒の記録から使用率の増え方（%/秒）を求める。記録が足りなければ None"""
    pts = []
    for e in limits.history(days=1):
        if e["t"] < now - span:
            continue
        for x in e["limits"]:
            r = _parse_ts(x.get("resetsAt"))
            if x["label"] == label and r and abs(r - reset) < 120:
                pts.append((e["t"], x["percent"]))
    pts.sort()
    if len(pts) < 2 or pts[-1][0] - pts[0][0] < span / 4:
        return None
    return max(0.0, (pts[-1][1] - pts[0][1]) / (pts[-1][0] - pts[0][0]))


def _check_limits(result):
    now = result["fetchedAt"]
    for item in result["limits"]:
        reset = _parse_ts(item.get("resetsAt"))
        if not reset:
            continue
        # リセット時刻は取得ごとに少しずれることがあるので 15 分単位に丸めて枠を見分ける
        win = f"{item['label']}@{round(reset / 900)}"
        p = item["percent"]
        until = reset + 3600
        left = f"リセットは {_hm(reset)}"

        if p >= 100:
            _once(win + ":100", until, "critical", f"{item['label']}が上限に達しました", left)
            for t in THRESHOLDS:
                _fired.setdefault(f"{win}:{t}", until)
            continue
        crossed = [t for t in THRESHOLDS if p >= t]
        if crossed:
            top = crossed[-1]
            if _once(f"{win}:{top}", until, "critical" if top >= 95 else "warning",
                     f"{item['label']}が {round(p)}% になりました", left):
                for t in crossed:  # 一気に上がったときは低い方の通知を出さない
                    _fired.setdefault(f"{win}:{t}", until)

        session = item.get("kind") == "session" or item.get("group") == "session"
        rate = _recent_rate(item["label"], reset, now, 3600 if session else 86400)
        if rate:
            hit = now + (100 - p) / rate
            if hit < reset and hit - now <= FORECAST_MINUTES * 60:
                _once(f"{win}:forecast", until, "warning", f"{item['label']}がまもなく上限です",
                      f"このペースだと {_hm(hit)} ごろ上限に達します（{left}）")


def _check_error(result):
    err = result.get("error")
    if not err:
        if _errors["notified"]:
            _push("normal", "利用上限を取得できるようになりました", "")
        _errors.update(count=0, notified=False)
        return
    if "取得回数の制限" in err:  # 一時的なもの
        return
    _errors["count"] += 1
    if _errors["count"] >= ERROR_REPEAT and not _errors["notified"]:
        _errors["notified"] = True
        _push("critical", "利用上限を取得できません", err)


def on_result(result):
    global _fired
    with _lock:
        if _fired is None:
            _fired = _load_fired()
        before = dict(_fired)
        _check_error(result)
        if not result.get("error"):
            _check_limits(result)
        now = time.time()
        _fired = {k: v for k, v in _fired.items() if v > now}
        if _fired != before:
            _save_fired()


def summary():
    """トレイのツールチップ用の短い要約（例: 5時間 42% · 週 63%）"""
    data = limits.last()
    if not data:
        return "Rinari"
    if data.get("error") and not data.get("limits"):
        return "Rinari: 取得できません"
    parts = []
    for x in data["limits"]:
        name = "5時間" if x.get("kind") == "session" else x["label"].replace("週間（全モデル）", "週").replace("週間", "週")
        parts.append(f"{name} {round(x['percent'])}%")
    return "Rinari: " + " · ".join(parts) if parts else "Rinari"


def since(after):
    with _lock:
        return [a for a in _alerts if a["id"] > after]


def latest_id():
    return _seq["n"]


limits.on_result(on_result)
