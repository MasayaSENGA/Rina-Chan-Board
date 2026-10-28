import os
from pathlib import Path


def claude_dir() -> Path:
    """Claude Code の設定フォルダ（CLAUDE_CONFIG_DIR があればそちら）"""
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(env) if env else Path.home() / ".claude"


def credentials_path() -> Path:
    return claude_dir() / ".credentials.json"


def projects_dir() -> Path:
    return claude_dir() / "projects"


def cache_dir() -> Path:
    """集計キャッシュの置き場所。リポジトリの外（ユーザーごとの領域）に置く"""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_CACHE_HOME")
    root = Path(base) if base else Path.home() / ".cache"
    d = root / "Rinari"
    d.mkdir(parents=True, exist_ok=True)
    return d
