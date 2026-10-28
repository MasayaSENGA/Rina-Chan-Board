import argparse
import os
import sys
import threading
import webbrowser
from pathlib import Path

from . import __version__, limits, stats, tray
from .server import serve

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def set_startup(on):
    """サインイン時にウィンドウなしで起動するよう登録する／やめる（HKCU の Run に書く）"""
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        if not on:
            try:
                winreg.DeleteValue(key, "Rinari")
            except FileNotFoundError:
                pass
            print("PC 起動時の自動起動をやめました。")
            return
        exe = Path(sys.executable)
        pyw = exe.with_name("pythonw.exe")
        script = Path(__file__).resolve().parent.parent / "rinari.pyw"
        cmd = f'"{pyw if pyw.exists() else exe}" "{script}" --no-browser'
        winreg.SetValueEx(key, "Rinari", 0, winreg.REG_SZ, cmd)
        print(f"PC 起動時に自動で起動するよう登録しました: {cmd}")


def main():
    ap = argparse.ArgumentParser(prog="rinari", description="Claude の利用上限とモデル別の使用割合を表示するローカルダッシュボード")
    ap.add_argument("--port", type=int, default=8765, help="待ち受けるポート（既定: 8765）")
    ap.add_argument("--no-browser", action="store_true", help="起動時にブラウザを開かない")
    ap.add_argument("--no-tray", action="store_true", help="タスクトレイのアイコン（と通知）を出さない")
    ap.add_argument("--startup", choices=["on", "off"], help="PC 起動時の自動起動を登録する（on）／やめる（off）")
    args = ap.parse_args()
    if args.startup:
        if os.name != "nt":
            sys.exit("--startup は Windows だけで使えます。")
        set_startup(args.startup == "on")
        return

    url = f"http://127.0.0.1:{args.port}/"
    try:
        httpd = serve(args.port)
    except OSError:
        print(f"ポート {args.port} は使用中です。璃奈ちゃんボードがすでに起動していれば {url} を開いてください。"
              "別のポートで起動するときは --port を指定してください。")
        sys.exit(1)
    print(f"璃奈ちゃんボード {__version__}: {url}  （終了は Ctrl+C か、タスクトレイのアイコンから）")
    # 初回の集計は時間がかかるので先に始めておく
    threading.Thread(target=stats.get, daemon=True).start()
    # 画面を開いていなくても利用上限の推移を記録する
    threading.Thread(target=limits.poll_forever, daemon=True).start()
    if not args.no_tray:
        httpd.tray = tray.start(url, httpd.shutdown)
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        if httpd.tray:
            httpd.tray.terminate()


if __name__ == "__main__":
    main()
