"""Claude Code の会話ログ（projects/**/*.jsonl）からモデル別の使用量を集計する。
Cowork が手元に残す会話ログ（同じ形式）もあれば「Cowork」というプロジェクトとして加える。

ログは数百MBになるので、ファイルごとの抽出結果を (更新時刻, サイズ) をキーに
キャッシュし、変わったファイルだけ読み直す。キャッシュはリポジトリの外に置く。
"""

import json
import threading
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from .paths import cache_dir, cowork_dirs, projects_dir
from .pricing import cache_savings_usd, cost_usd

CACHE_VERSION = 3
MIN_RESCAN_SECONDS = 30  # 通常の読み直し間隔の下限
FORCE_MIN_SECONDS = 5    # 「今すぐ更新」でもこれより短い間隔では読み直さない
BUCKET_SECONDS = 5 * 60  # 利用上限の記録と突き合わせるための料金換算の刻み
BUCKET_KEEP_SECONDS = 35 * 86400  # 利用上限の記録と同じ期間だけ返す
COWORK_PROJECT = "Cowork"

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


def _user_text(m):
    """ユーザー発言の本文。コマンドやシステムが差し込んだもの（< で始まる）は除く"""
    c = m.get("content") if isinstance(m, dict) else None
    if isinstance(c, list):
        c = next((x.get("text") for x in c if isinstance(x, dict) and x.get("type") == "text"), None)
    if not isinstance(c, str):
        return None
    c = " ".join(c.split())
    return c if c and not c.startswith("<") else None


def _parse_file(path: Path, project_name=None):
    """1ファイルから応答ごとの [id, 時刻(UNIX秒), モデル, プロジェクト, 入力, 出力,
    キャッシュ作成(5分), キャッシュ作成(1時間), キャッシュ読込, fastモード, セッションID] と、
    会話のタイトル（名前を付けていればその名前、無ければ最初の発言）を取り出す"""
    records = []
    title = first_prompt = None
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            if '"custom-title"' in line:
                try:
                    title = json.loads(line).get("customTitle") or title
                except ValueError:
                    pass
                continue
            if first_prompt is None and '"user"' in line:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") == "user" and not d.get("isMeta"):
                    first_prompt = _user_text(d.get("message"))
                continue
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
            project = project_name or (Path(cwd).name if cwd else path.parent.name)
            cc = int(u.get("cache_creation_input_tokens") or 0)
            detail = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
            cc1h = int(detail.get("ephemeral_1h_input_tokens") or 0)
            cc5m = cc - cc1h if detail else cc  # 内訳が無い古いログは5分扱い
            records.append([
                m.get("id") or d.get("uuid"), ts, model, project,
                int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0),
                cc5m, cc1h, int(u.get("cache_read_input_tokens") or 0),
                1 if u.get("speed") == "fast" else 0,
                d.get("sessionId") or path.stem,
            ])
    title = title or first_prompt
    return records, (title[:80] if title else None)


def _log_files():
    """(ファイル, プロジェクト名の上書き) を並べる"""
    root = projects_dir()
    if root.exists():
        for p in root.rglob("*.jsonl"):
            yield p, None
    for d in cowork_dirs():
        # セッションごとの .claude/projects/ の下が会話ログ。audit.jsonl など別形式のものは読まない
        for p in d.rglob("*.jsonl"):
            if ".claude" in p.parts and "projects" in p.parts:
                yield p, COWORK_PROJECT


def _scan():
    cached = _state["files"] if _state["files"] is not None else _load_cache()
    files, changed = {}, False
    for p, project_name in _log_files():
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
            recs, title = _parse_file(p, project_name)
        except OSError:
            continue
        files[key] = {"mtime": st.st_mtime, "size": st.st_size, "records": recs, "title": title}
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
    # 値はどれも [応答数, 入力, 出力, キャッシュ作成, キャッシュ読込, 料金換算USD, キャッシュによる節約USD]
    rows = defaultdict(lambda: [0, 0, 0, 0, 0, 0.0, 0.0])    # (日付, モデル, プロジェクト)
    hours = defaultdict(lambda: [0, 0, 0, 0, 0, 0.0, 0.0])   # (日付, 時, モデル)
    sessions = {}  # セッションID -> {プロジェクト, タイトル, 最初, 最後, モデル -> 値}
    buckets = defaultdict(float)  # (5分の区切り, モデル) -> 料金換算USD
    bucket_since = time.time() - BUCKET_KEEP_SECONDS
    unpriced = set()
    first = last = None
    for f in files.values():
        for rid, ts, model, project, i, o, cc5m, cc1h, cr, fast, sid in f["records"]:
            if rid in seen:
                continue
            seen.add(rid)
            usd = cost_usd(model, i, o, cc5m, cc1h, cr, bool(fast))
            if usd is None:
                unpriced.add(model)
                usd = 0.0
            saved = cache_savings_usd(model, i, cc5m, cc1h, cr, bool(fast)) or 0.0
            dt = datetime.fromtimestamp(ts)  # このPCのタイムゾーンで日付と時刻を切る
            day = dt.strftime("%Y-%m-%d")
            s = sessions.get(sid)
            if s is None:
                s = sessions[sid] = {"project": project, "title": None, "first": ts, "last": ts,
                                     "models": defaultdict(lambda: [0, 0, 0, 0, 0, 0.0, 0.0])}
            s["title"] = s["title"] or f.get("title")
            s["first"], s["last"] = min(s["first"], ts), max(s["last"], ts)
            for r in (rows[(day, model, project)], hours[(day, dt.hour, model)], s["models"][model]):
                r[0] += 1
                r[1] += i
                r[2] += o
                r[3] += cc5m + cc1h
                r[4] += cr
                r[5] += usd
                r[6] += saved
            if ts >= bucket_since:
                buckets[(int(ts // BUCKET_SECONDS) * BUCKET_SECONDS, model)] += usd
            first = ts if first is None or ts < first else first
            last = ts if last is None or ts > last else last

    def vals(v):
        return [*v[:5], round(v[5], 6), round(v[6], 6)]

    return {
        "generatedAt": time.time(),
        "firstAt": first,
        "lastAt": last,
        "fields": ["date", "model", "project", "messages", "input", "output", "cacheCreate", "cacheRead",
                   "costUsd", "cacheSavedUsd"],
        "rows": [[d, m, p, *vals(v)] for (d, m, p), v in sorted(rows.items())],
        "hourFields": ["date", "hour", "model", "messages", "input", "output", "cacheCreate", "cacheRead",
                       "costUsd", "cacheSavedUsd"],
        "hours": [[d, h, m, *vals(v)] for (d, h, m), v in sorted(hours.items())],
        "sessionFields": ["id", "project", "title", "firstAt", "lastAt", "models"],
        "sessions": [
            [sid, s["project"], s["title"], round(s["first"]), round(s["last"]),
             {m: vals(v) for m, v in s["models"].items()}]
            for sid, s in sorted(sessions.items(), key=lambda kv: -kv[1]["last"])
        ],
        "bucketFields": ["t", "model", "costUsd"],
        "buckets": [[t, m, round(v, 6)] for (t, m), v in sorted(buckets.items()) if v],
        "unpricedModels": sorted(unpriced),
    }


def get(force=False):
    with _lock:
        age = time.time() - _state["at"]
        if _state["result"] is None or age >= (FORCE_MIN_SECONDS if force else MIN_RESCAN_SECONDS):
            _state["result"] = _aggregate(_scan())
            _state["at"] = time.time()
        return _state["result"]


def peek():
    """集計済みの結果を返す（まだ無ければ None）。集計を待たない"""
    return _state["result"]
