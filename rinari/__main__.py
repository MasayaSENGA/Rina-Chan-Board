import argparse
import sys
import threading
import webbrowser

from . import __version__, limits, stats
from .server import serve


def main():
    ap = argparse.ArgumentParser(prog="rinari", description="Claude の利用上限とモデル別の使用割合を表示するローカルダッシュボード")
    ap.add_argument("--port", type=int, default=8765, help="待ち受けるポート（既定: 8765）")
    ap.add_argument("--no-browser", action="store_true", help="起動時にブラウザを開かない")
    args = ap.parse_args()

    url = f"http://127.0.0.1:{args.port}/"
    try:
        httpd = serve(args.port)
    except OSError:
        print(f"ポート {args.port} は使用中です。Rinari がすでに起動していれば {url} を開いてください。"
              "別のポートで起動するときは --port を指定してください。")
        sys.exit(1)
    print(f"Rinari {__version__}: {url}  （終了は Ctrl+C）")
    # 初回の集計は時間がかかるので先に始めておく
    threading.Thread(target=stats.get, daemon=True).start()
    # 画面を開いていなくても利用上限の推移を記録する
    threading.Thread(target=limits.poll_forever, daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
