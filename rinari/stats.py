"""Claude Code の会話ログ（projects/**/*.jsonl）からモデル別の使用量を集計する。

ログは数百MBになるので、ファイルごとの抽出結果を (更新時刻, サイズ) をキーに
キャッシュし、変わったファイルだけ読み直す。キャッシュはリポジトリの外に置く。
"""

import json
import threading
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from .paths import cache_dir, projects_dir
from .pricing import cost_usd

CACHE_VERSION = 2
MIN_RESCAN_SECONDS = 30  # 通常の読み直し間隔の下限
FORCE_MIN_SECONDS = 5    # 「今すぐ更新」でもこれより短い間隔では読み直さない

_lock = threading.Lock()
_state = {"at": 0.0, "files": None, "result": None}


def _cache_file() -> Path:
    return cache_dir() / "stats-cache.json"


def _load_cache():
    try:
        d = json.loads(_cache_file().read_text(encoding="utf-8"))
        if d.get("version") == CACHE_VERSION:
            return d.get("files", {})
    except (OSError, ValueError):
        pass
    return {}


def _save_cache(files):
    path = _cache_file()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"version": CACHE_VERSION, "files": files}), encoding="utf-8")
    tmp.replace(path)


def _parse_file(path: Path):
    """1ファイルから応答ごとの [id, 時刻(UNIX秒), モデル, プロジェクト, 入力, 出力,
    キャッシュ作成(5分), キャッシュ作成(1時間), キャッシュ読込, fastモード] を取り出す"""
    records = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            if '"usage"' not in line or '"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "assistant":
                continue
            m = d.get("message")
            if not isinstance(m, dict) or not isinstance(m.get("usage"), dict):
                continue
            model = m.get("model") or "?"
            if model.startswith("<"):  # <synthetic> などAPIを通っていない応答
                continue
            try:
                ts = datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp()
            except (KeyError, ValueError, AttributeError):
                continue
            u = m["usage"]
            cwd = d.get("cwd") or ""
            project = Path(cwd).name if cwd else path.parent.name
            cc = int(u.get("cache_creation_input_tokens") or 0)
            detail = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
            cc1h = int(detail.get("ephemeral_1h_input_tokens") or 0)
            cc5m = cc - cc1h if detail else cc  # 内訳が無い古いログは5分扱い
            records.append([
                m.get("id") or d.get("uuid"), ts, model, project,
                int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0),
                cc5m, cc1h, int(u.get("cache_read_input_tokens") or 0),
                1 if u.get("speed") == "fast" else 0,
            ])
    return records


def _scan():
    root = projects_dir()
    cached = _state["files"] if _state["files"] is not None else _load_cache()
    files, changed = {}, False
    if root.exists():
        for p in root.rglob("*.jsonl"):
            try:
                st = p.stat()
            except OSError:
                continue
            key = str(p)
            c = cached.get(key)
            if c and c["mtime"] == st.st_mtime and c["size"] == st.st_size:
                files[key] = c
                continue
            try:
                recs = _parse_file(p)
            except OSError:
                continue
            files[key] = {"mtime": st.st_mtime, "size": st.st_size, "records": recs}
            changed = True
    if changed or len(files) != len(cached):
        try:
            _save_cache(files)
        except OSError:
            pass
    _state["files"] = files
    return files


def _aggregate(files):
    # 同じ応答が複数行・複数ファイル（再開したセッションなど）に出るので id で重複を除く
    seen = set()
    # (日付, モデル, プロジェクト) / (日付, 時) -> [応答数, 入力, 出力, キャッシュ作成, キャッシュ読込, 料金換算USD]
    rows = defaultdict(lambda: [0, 0, 0, 0, 0, 0.0])
    hours = defaultdict(lambda: [0, 0, 0, 0, 0, 0.0])
    unpriced = set()
    first = last = None
    for f in files.values():
        for rid, ts, model, project, i, o, cc5m, cc1h, cr, fast in f["records"]:
            if rid in seen:
                continue
            seen.add(rid)
            usd = cost_usd(model, i, o, cc5m, cc1h, cr, bool(fast))
            if usd is None:
                unpriced.add(model)
                usd = 0.0
            dt = datetime.fromtimestamp(ts)  # このPCのタイムゾーンで日付と時刻を切る
            day = dt.strftime("%Y-%m-%d")
            for r in (rows[(day, model, project)], hours[(day, dt.hour)]):
                r[0] += 1
                r[1] += i
                r[2] += o
                r[3] += cc5m + cc1h
                r[4] += cr
                r[5] += usd
            first = ts if first is None or ts < first else first
            last = ts if last is None or ts > last else last
    return {
        "generatedAt": time.time(),
        "firstAt": first,
        "lastAt": last,
        "fields": ["date", "model", "project", "messages", "input", "output", "cacheCreate", "cacheRead", "costUsd"],
        "rows": [[d, m, p, *v[:5], round(v[5], 6)] for (d, m, p), v in sorted(rows.items())],
        "hourFields": ["date", "hour", "", "messages", "input", "output", "cacheCreate", "cacheRead", "costUsd"],
        "hours": [[d, h, "", *v[:5], round(v[5], 6)] for (d, h), v in sorted(hours.items())],
        "unpricedModels": sorted(unpriced),
    }


def get(force=False):
    with _lock:
        age = time.time() - _state["at"]
        if _state["result"] is None or age >= (FORCE_MIN_SECONDS if force else MIN_RESCAN_SECONDS):
            _state["result"] = _aggregate(_scan())
            _state["at"] = time.time()
        return _state["result"]
