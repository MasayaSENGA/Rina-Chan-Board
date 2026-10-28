"""タスクトレイのアイコン（Windows のみ）。PowerShell の WinForms で表示する（追加のインストールは不要）"""

import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parent / "tray.ps1"


def start(port, token):
    """トレイのアイコンを起動して Popen を返す。Windows 以外や起動できないときは None"""
    if os.name != "nt":
        return None
    exe = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    try:
        return subprocess.Popen(
            [str(exe), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA",
             "-WindowStyle", "Hidden", "-File", str(SCRIPT),
             "-Port", str(port), "-ParentPid", str(os.getpid()), "-Token", token],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    except OSError:
        return None
