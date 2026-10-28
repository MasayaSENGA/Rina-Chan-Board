import hmac
import json
import mimetypes
import os
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__, health, limits, notify, stats

STATIC_DIR = Path(__file__).parent / "static"


class Handler(BaseHTTPRequestHandler):
    server_version = f"Rinari/{__version__}"

    def log_message(self, fmt, *args):
        pass  # アクセスログは出さない

    def _host_ok(self):
        # DNS リバインディング対策: 自分自身のアドレス以外の Host ヘッダーは拒否する
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").lower()
        return host in {f"127.0.0.1:{port}", f"localhost:{port}"}

    def _send(self, code, body: bytes, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        if not self._host_ok():
            self._send(403, b"Forbidden", "text/plain; charset=utf-8")
            return
        url = urlparse(self.path)
        force = parse_qs(url.query).get("force") == ["1"]
        if url.path == "/api/limits":
            self._json(limits.fetch(force=force))
            return
        if url.path == "/api/limits/history":
            self._json({"points": limits.history()})
            return
        if url.path == "/api/stats":
            self._json(stats.get(force=force))
            return
        if url.path == "/api/health":
            self._json({"issues": health.check(self.server.started_at, self.server.tray)})
            return
        if url.path == "/api/alerts":
            if not self._token_ok():
                self._send(403, b"Forbidden", "text/plain; charset=utf-8")
                return
            try:
                after = int(parse_qs(url.query).get("after", ["0"])[0])
            except ValueError:
                after = 0
            self._json({"alerts": notify.since(after), "last": notify.latest_id(), "summary": notify.summary()})
            return
        if url.path == "/api/version":
            self._json({"version": __version__})
            return
        name = "index.html" if url.path in ("/", "/index.html") else url.path.lstrip("/")
        path = (STATIC_DIR / name).resolve()
        if STATIC_DIR.resolve() not in path.parents or not path.is_file():
            self._send(404, b"Not Found", "text/plain; charset=utf-8")
            return
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype)


    def do_POST(self):
        # 終了はトレイのアイコンからだけ受け付ける（ブラウザのページからは合言葉が分からないので送れない）
        if not self._host_ok() or urlparse(self.path).path != "/api/shutdown" or not self._token_ok():
            self._send(403, b"Forbidden", "text/plain; charset=utf-8")
            return
        self._json({"ok": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def _token_ok(self):
        return hmac.compare_digest(self.headers.get("X-Rinari-Token") or "", self.server.token)


class Server(ThreadingHTTPServer):
    # Windows の SO_REUSEADDR は使用中のポートにも重ねて bind できてしまい、
    # 2つ目の Rinari が黙って起動するので使わない（代わりに排他で bind する）
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(port):
    # 127.0.0.1 だけで待ち受ける（LAN の他の端末からは見えない）
    httpd = Server(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    httpd.token = secrets.token_urlsafe(32)  # トレイのアイコンとだけ共有する合言葉
    httpd.started_at = time.time()
    httpd.tray = None
    return httpd
