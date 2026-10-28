"""動作状態の点検。画面を開いていないあいだに起きた問題にも気づけるよう、画面の先頭に出す"""

import time

from . import limits, stats
from .paths import credentials_path, projects_dir

STALE_SECONDS = 20 * 60          # 最後に取得できてからこれ以上たったら知らせる
LOGIN_WARN_SECONDS = 3 * 86400   # ログインの期限がこれより近ければ知らせる


def _ago(sec):
    m = int(sec // 60)
    if m < 60:
        return f"{m}分前"
    if m < 1440:
        return f"{m // 60}時間{m % 60}分前"
    return f"{m // 1440}日前"


def check(started_at, tray=None):
    """問題のリストを返す。各項目は {level: critical|warning|info, text}"""
    issues = []
    now = time.time()

    data = limits.last()
    ok_at = limits.last_success_at()
    if data and data.get("error"):
        issues.append({"level": "critical", "text": "利用上限を取得できません: " + data["error"]})
    if ok_at and now - ok_at > STALE_SECONDS:
        issues.append({"level": "warning", "text": f"利用上限を最後に取得できたのは {_ago(now - ok_at)} です"})
    elif not ok_at and now - started_at > STALE_SECONDS:
        issues.append({"level": "warning", "text": "起動してから一度も利用上限を取得できていません"})

    if not credentials_path().exists():
        issues.append({"level": "critical", "text": "Claude Code のログイン情報がありません（claude を起動して /login してください）"})
    else:
        exp = limits.login_expiry()
        if exp and exp - now < LOGIN_WARN_SECONDS:
            when = "切れています" if exp <= now else f"あと{max(1, int((exp - now) // 3600))}時間で切れます"
            issues.append({"level": "warning", "text": f"Claude Code のログインの期限が{when}（claude で /login してください）"})

    if not projects_dir().exists():
        issues.append({"level": "warning", "text": f"会話ログのフォルダが見つかりません: {projects_dir()}"})
    s = stats.peek()
    if s and s.get("unpricedModels"):
        issues.append({"level": "info", "text": "単価が分からないモデルがあり、料金換算に含めていません: "
                       + ", ".join(s["unpricedModels"]) + "（rinari/pricing.py に追加してください）"})

    if tray is not None and tray.poll() is not None:
        issues.append({"level": "info", "text": "タスクトレイのアイコンが終了しています（通知は出ません。Rinari を再起動すると戻ります）"})
    return issues
