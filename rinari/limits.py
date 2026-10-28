"""利用上限の取得。Claude Code の /usage と同じ非公開エンドポイントを使う。

アクセストークンは Claude Code CLI のログイン情報（.credentials.json）を共有する。
トークンは api.anthropic.com（取得）と platform.claude.com（更新）以外には送らず、
ブラウザへの応答にも含めない。
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

from . import __version__
from .paths import cache_dir, credentials_path

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"  # Claude Code の公開クライアントID
USER_AGENT = f"Rinari/{__version__}"

CACHE_SECONDS = 60       # 通常の取得間隔の下限
FORCE_MIN_SECONDS = 15   # 「今すぐ更新」でもこれより短い間隔では取りに行かない
POLL_SECONDS = 5 * 60    # 画面を開いていなくても記録のために取得する間隔
HISTORY_KEEP_SECONDS = 35 * 24 * 3600  # 記録を残す期間

_cred_lock = threading.Lock()
_cache_lock = threading.Lock()
_history_lock = threading.Lock()
_cache = {"at": 0.0, "data": None}


def _history_path():
    return cache_dir() / "limits-history.jsonl"


def _append_history(result):
    """取得した使用率を1行1件で追記する（利用上限 API は過去の値を返さないため手元に貯める）"""
    entry = {
        "t": round(result["fetchedAt"], 1),
        "limits": [{"kind": x["kind"], "label": x["label"], "percent": x["percent"], "resetsAt": x["resetsAt"]}
                   for x in result["limits"]],
    }
    with _history_lock:
        try:
            with open(_history_path(), "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError:
            pass


def history(days=8):
    """直近 days 日分の記録を返す。古すぎる記録はついでに削る"""
    now = time.time()
    since = now - days * 86400
    path = _history_path()
    out, keep, dropped = [], [], False
    with _history_lock:
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.readlines()
        except OSError:
            return []
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                dropped = True
                continue
            if e.get("t", 0) < now - HISTORY_KEEP_SECONDS:
                dropped = True
                continue
            keep.append(line)
            if e["t"] >= since:
                out.append(e)
        if dropped:
            tmp = path.with_suffix(".tmp")
            try:
                tmp.write_text("".join(keep), encoding="utf-8")
                os.replace(tmp, path)
            except OSError:
                pass
    return out


def poll_forever():
    """サーバーが動いている間、一定間隔で取得して記録を貯める"""
    while True:
        try:
            fetch()
        except Exception:
            pass
        time.sleep(POLL_SECONDS)


class LimitsError(Exception):
    pass


def _read_credentials():
    path = credentials_path()
    if not path.exists():
        raise LimitsError("ログイン情報がありません（claude を起動して /login してください）")
    try:
        all_ = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise LimitsError(f"ログイン情報を読めません: {e}")
    oauth = all_.get("claudeAiOauth")
    if not isinstance(oauth, dict) or not oauth.get("accessToken"):
        raise LimitsError("ログイン情報にアクセストークンがありません（claude で /login してください）")
    return all_, oauth


def _write_credentials(all_):
    path = credentials_path()
    tmp = path.with_name(path.name + ".rinari.tmp")
    try:
        tmp.write_text(json.dumps(all_, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    finally:
        # トークンを含む一時ファイルを失敗時にも残さない
        try:
            tmp.unlink()
        except OSError:
            pass


def _post_json(url, body):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def _access_token(force_refresh=False):
    """毎回ファイルを読み直し、期限切れ（または force）なら更新して書き戻す。
    書き戻すことで Claude Code CLI 側も新しいトークンをそのまま使える。"""
    with _cred_lock:
        all_, oauth = _read_credentials()
        now_ms = int(time.time() * 1000)
        if not force_refresh and int(oauth.get("expiresAt") or 0) > now_ms + 60_000:
            return oauth["accessToken"], oauth

        rt = oauth.get("refreshToken")
        if not rt:
            raise LimitsError("トークンの期限切れ（claude で /login してください）")
        body = {"grant_type": "refresh_token", "refresh_token": rt, "client_id": CLIENT_ID}
        if oauth.get("scopes"):
            body["scope"] = " ".join(oauth["scopes"])
        try:
            res = _post_json(TOKEN_URL, body)
        except urllib.error.HTTPError as e:
            if e.code in (400, 401):
                raise LimitsError("ログインの有効期限切れ（claude で /login してください）")
            raise LimitsError(f"トークン更新に失敗: HTTP {e.code}")
        except (urllib.error.URLError, OSError) as e:
            raise LimitsError(f"トークン更新の通信エラー: {e}")
        if not res.get("access_token"):
            raise LimitsError("トークン更新に失敗（claude で /login してください）")
        oauth["accessToken"] = res["access_token"]
        if res.get("refresh_token"):
            oauth["refreshToken"] = res["refresh_token"]
        if res.get("expires_in"):
            oauth["expiresAt"] = now_ms + int(res["expires_in"]) * 1000
        if res.get("refresh_token_expires_in"):
            oauth["refreshTokenExpiresAt"] = now_ms + int(res["refresh_token_expires_in"]) * 1000
        _write_credentials(all_)
        return oauth["accessToken"], oauth


def _get_usage(token):
    req = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": "Bearer " + token,
            "anthropic-beta": "oauth-2025-04-20",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def _label(item):
    kind = item.get("kind") or ""
    scope = item.get("scope") or {}
    model = ((scope.get("model") or {}).get("display_name")) if isinstance(scope, dict) else None
    surface = scope.get("surface") if isinstance(scope, dict) else None
    if kind == "session":
        return "5時間枠"
    if kind == "weekly_all":
        return "週間（全モデル）"
    if model:
        return f"週間（{model}）"
    if surface:
        return f"週間（{surface}）"
    return kind or "不明な枠"


def _normalize(raw):
    """応答から画面に必要な項目だけを取り出す"""
    limits = []
    items = raw.get("limits")
    if isinstance(items, list) and items:
        for it in items:
            if not isinstance(it, dict) or it.get("percent") is None:
                continue
            limits.append({
                "label": _label(it),
                "kind": it.get("kind"),
                "group": it.get("group"),
                "percent": float(it["percent"]),
                "severity": it.get("severity") or "normal",
                "resetsAt": it.get("resets_at"),
                "active": bool(it.get("is_active")),
            })
    else:
        # limits[] が無い古い形式の応答
        for key, label in (("five_hour", "5時間枠"), ("seven_day", "週間（全モデル）")):
            w = raw.get(key)
            if isinstance(w, dict) and w.get("utilization") is not None:
                limits.append({
                    "label": label, "kind": key, "group": "session" if key == "five_hour" else "weekly",
                    "percent": float(w["utilization"]), "severity": None,
                    "resetsAt": w.get("resets_at"), "active": False,
                })

    extra = raw.get("extra_usage") if isinstance(raw.get("extra_usage"), dict) else None
    return {
        "limits": limits,
        "extraUsage": {
            "enabled": bool(extra.get("is_enabled")),
            "usedCredits": extra.get("used_credits"),
            "monthlyLimit": extra.get("monthly_limit"),
            "currency": extra.get("currency"),
        } if extra else None,
    }


def fetch(force=False):
    """利用上限を返す。短時間の再取得はキャッシュで返して 429 を避ける"""
    with _cache_lock:
        age = time.time() - _cache["at"]
        if _cache["data"] is not None and age < (FORCE_MIN_SECONDS if force else CACHE_SECONDS):
            return _cache["data"]

        result = {"fetchedAt": time.time(), "error": None, "limits": [], "extraUsage": None, "plan": None}
        try:
            token, oauth = _access_token()
            result["plan"] = {"subscription": oauth.get("subscriptionType"), "tier": oauth.get("rateLimitTier")}
            try:
                raw = _get_usage(token)
            except urllib.error.HTTPError as e:
                # 期限内でも失効していることがあるので1回だけ更新して再試行
                if e.code != 401:
                    raise
                token, _ = _access_token(force_refresh=True)
                raw = _get_usage(token)
            result.update(_normalize(raw))
        except LimitsError as e:
            result["error"] = str(e)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                result["error"] = "認証エラー（claude で /login してください）"
            elif e.code == 429:
                result["error"] = "取得回数の制限中（しばらく待ってください）"
            else:
                result["error"] = f"取得失敗: HTTP {e.code}"
        except (urllib.error.URLError, OSError) as e:
            result["error"] = f"通信エラー: {e}"
        except ValueError as e:
            result["error"] = f"応答を読めません: {e}"

        if not result["error"]:
            _append_history(result)

        # エラー時は前回の値を残して表示を続ける
        if result["error"] and _cache["data"] and not _cache["data"].get("error"):
            prev = dict(_cache["data"])
            prev["error"] = result["error"]
            prev["stale"] = True
            _cache["at"] = time.time()
            _cache["data"] = prev
            return prev
        _cache["at"] = time.time()
        _cache["data"] = result
        return result
