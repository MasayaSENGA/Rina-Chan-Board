"""タスクトレイのアイコン（Windows のみ）。Win32 API を ctypes で直接呼ぶ（追加のインストールは不要）

Rinari と同じプロセスの別スレッドで動かす。PowerShell のスクリプトや exe を使わないので、
スマート アプリ コントロールで止められない（動くのは署名済みの python.exe / pythonw.exe だけ）。
- 左ダブルクリック / メニュー: ダッシュボードを開く
- Rinari の通知を Windows の通知として出す
- アイコンに使用率の数字を描く（いま一番効いている枠。70% から黄、90% から赤）
"""

import os
import threading
import webbrowser

from . import notify

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
                    ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
                    ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
                    ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND), ("uID", wintypes.UINT),
                    ("uFlags", wintypes.UINT), ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HICON),
                    ("szTip", wintypes.WCHAR * 128), ("dwState", wintypes.DWORD), ("dwStateMask", wintypes.DWORD),
                    ("szInfo", wintypes.WCHAR * 256), ("uTimeout", wintypes.UINT),
                    ("szInfoTitle", wintypes.WCHAR * 64), ("dwInfoFlags", wintypes.DWORD),
                    ("guidItem", ctypes.c_byte * 16), ("hBalloonIcon", wintypes.HICON)]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                    ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    class ICONINFO(ctypes.Structure):
        _fields_ = [("fIcon", wintypes.BOOL), ("xHotspot", wintypes.DWORD), ("yHotspot", wintypes.DWORD),
                    ("hbmMask", wintypes.HBITMAP), ("hbmColor", wintypes.HBITMAP)]

    class LOGBRUSH(ctypes.Structure):
        _fields_ = [("lbStyle", wintypes.UINT), ("lbColor", wintypes.DWORD), ("lbHatch", ctypes.c_size_t)]

    def _sig(dll, name, res, *args):
        f = getattr(dll, name)
        f.restype, f.argtypes = res, list(args)

    H, P = wintypes.HANDLE, ctypes.c_void_p
    _sig(user32, "DefWindowProcW", LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    _sig(user32, "RegisterClassW", wintypes.ATOM, ctypes.POINTER(WNDCLASSW))
    _sig(user32, "UnregisterClassW", wintypes.BOOL, wintypes.LPCWSTR, wintypes.HINSTANCE)
    _sig(user32, "CreateWindowExW", wintypes.HWND, wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
         wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU,
         wintypes.HINSTANCE, P)
    _sig(user32, "DestroyWindow", wintypes.BOOL, wintypes.HWND)
    _sig(user32, "PostMessageW", wintypes.BOOL, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    _sig(user32, "PostQuitMessage", None, ctypes.c_int)
    _sig(user32, "GetMessageW", wintypes.BOOL, ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT,
         wintypes.UINT)
    _sig(user32, "TranslateMessage", wintypes.BOOL, ctypes.POINTER(wintypes.MSG))
    _sig(user32, "DispatchMessageW", LRESULT, ctypes.POINTER(wintypes.MSG))
    _sig(user32, "RegisterWindowMessageW", wintypes.UINT, wintypes.LPCWSTR)
    _sig(user32, "SetTimer", ctypes.c_size_t, wintypes.HWND, ctypes.c_size_t, wintypes.UINT, P)
    _sig(user32, "KillTimer", wintypes.BOOL, wintypes.HWND, ctypes.c_size_t)
    _sig(user32, "CreatePopupMenu", wintypes.HMENU)
    _sig(user32, "AppendMenuW", wintypes.BOOL, wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR)
    _sig(user32, "SetMenuDefaultItem", wintypes.BOOL, wintypes.HMENU, wintypes.UINT, wintypes.UINT)
    _sig(user32, "TrackPopupMenu", wintypes.BOOL, wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int,
         ctypes.c_int, wintypes.HWND, P)
    _sig(user32, "DestroyMenu", wintypes.BOOL, wintypes.HMENU)
    _sig(user32, "GetCursorPos", wintypes.BOOL, ctypes.POINTER(wintypes.POINT))
    _sig(user32, "SetForegroundWindow", wintypes.BOOL, wintypes.HWND)
    _sig(user32, "CreateIconIndirect", wintypes.HICON, ctypes.POINTER(ICONINFO))
    _sig(user32, "DestroyIcon", wintypes.BOOL, wintypes.HICON)
    _sig(user32, "FillRect", ctypes.c_int, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.HBRUSH)
    _sig(user32, "DrawTextW", ctypes.c_int, wintypes.HDC, wintypes.LPCWSTR, ctypes.c_int,
         ctypes.POINTER(wintypes.RECT), wintypes.UINT)
    _sig(gdi32, "CreateCompatibleDC", wintypes.HDC, wintypes.HDC)
    _sig(gdi32, "DeleteDC", wintypes.BOOL, wintypes.HDC)
    _sig(gdi32, "CreateDIBSection", wintypes.HBITMAP, wintypes.HDC, ctypes.POINTER(BITMAPINFOHEADER),
         wintypes.UINT, ctypes.POINTER(P), H, wintypes.DWORD)
    _sig(gdi32, "CreateBitmap", wintypes.HBITMAP, ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.UINT, P)
    _sig(gdi32, "SelectObject", H, wintypes.HDC, H)
    _sig(gdi32, "DeleteObject", wintypes.BOOL, H)
    _sig(gdi32, "GetStockObject", H, ctypes.c_int)
    _sig(gdi32, "RoundRect", wintypes.BOOL, wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
         ctypes.c_int, ctypes.c_int)
    _sig(gdi32, "Arc", wintypes.BOOL, wintypes.HDC, *[ctypes.c_int] * 8)
    _sig(gdi32, "MoveToEx", wintypes.BOOL, wintypes.HDC, ctypes.c_int, ctypes.c_int, P)
    _sig(gdi32, "LineTo", wintypes.BOOL, wintypes.HDC, ctypes.c_int, ctypes.c_int)
    _sig(gdi32, "ExtCreatePen", H, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(LOGBRUSH), wintypes.DWORD, P)
    _sig(gdi32, "CreateFontW", H, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
         wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
         wintypes.DWORD, wintypes.DWORD, wintypes.LPCWSTR)
    _sig(gdi32, "SetTextColor", wintypes.DWORD, wintypes.HDC, wintypes.DWORD)
    _sig(gdi32, "SetBkMode", ctypes.c_int, wintypes.HDC, ctypes.c_int)
    _sig(shell32, "Shell_NotifyIconW", wintypes.BOOL, wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW))
    _sig(kernel32, "GetModuleHandleW", wintypes.HMODULE, wintypes.LPCWSTR)

WM_DESTROY, WM_CLOSE, WM_COMMAND, WM_TIMER, WM_USER = 0x0002, 0x0010, 0x0111, 0x0113, 0x0400
WM_LBUTTONDBLCLK, WM_RBUTTONUP = 0x0203, 0x0205
WM_TRAY = WM_USER + 1
NIN_BALLOONUSERCLICK = WM_USER + 5
NIM_ADD, NIM_MODIFY, NIM_DELETE = 0, 1, 2
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO = 0x1, 0x2, 0x4, 0x10
NIIF = {"critical": 3, "warning": 2}  # それ以外は 1（情報）
ID_OPEN, ID_TEST, ID_QUIT = 1, 2, 3
TIMER_POLL, TIMER_FIRST = 1, 2

SIZE = 32   # アイコンの大きさ（表示する大きさには Windows が縮める）
SS = 4      # なめらかに描くため、4倍の大きさで描いてから縮める
BLUE = (42, 120, 214)
COLORS = {"critical": ((208, 59, 59), (255, 255, 255)), "warning": ((250, 178, 25), (11, 11, 11))}


def _coverage(draw, center=False):
    """draw(hdc) で白く描いた部分の濃さ（0〜1）を SIZE×SIZE のリストで返す。center なら描いた部分を真ん中に寄せる"""
    n = SIZE * SS
    dc = gdi32.CreateCompatibleDC(None)
    bits = ctypes.c_void_p()
    bih = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=n, biHeight=-n, biPlanes=1, biBitCount=32)
    bmp = gdi32.CreateDIBSection(dc, ctypes.byref(bih), 0, ctypes.byref(bits), None, 0)
    old = gdi32.SelectObject(dc, bmp)
    try:
        ctypes.memset(bits, 0, n * n * 4)
        draw(dc)
        px = ctypes.string_at(bits, n * n * 4)[1::4]  # 緑の値で見る
    finally:
        gdi32.SelectObject(dc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(dc)
    ox = oy = 0
    if center:
        # 文字の上下の余白はフォントによって偏るので、実際に描かれた範囲で合わせる
        ink = [i for i, v in enumerate(px) if v]
        if ink:
            ys = (ink[0] // n, ink[-1] // n)
            xs = (min(i % n for i in ink), max(i % n for i in ink))
            ox, oy = (xs[0] + xs[1] + 1 - n) // 2, (ys[0] + ys[1] + 1 - n) // 2
    out = []
    for y in range(SIZE):
        for x in range(SIZE):
            s = 0
            for dy in range(SS):
                sy = y * SS + dy + oy
                if not 0 <= sy < n:
                    continue
                for dx in range(SS):
                    sx = x * SS + dx + ox
                    if 0 <= sx < n:
                        s += px[sy * n + sx]
            out.append(s / (SS * SS * 255))
    return out


def _round_rect(diameter):
    def draw(dc):
        gdi32.SelectObject(dc, gdi32.GetStockObject(0))  # WHITE_BRUSH
        gdi32.SelectObject(dc, gdi32.GetStockObject(8))  # NULL_PEN
        gdi32.RoundRect(dc, 0, 0, SIZE * SS + 1, SIZE * SS + 1, diameter * SS, diameter * SS)
    return draw


def _make_icon(shape, mark, bg, fg):
    """shape（背景の形）を bg 色で、その上に mark を fg 色で描いたアイコン"""
    data = bytearray()
    for a, t in zip(shape, mark):
        b, g, r = (round(bg[i] * (1 - t) + fg[i] * t) for i in (2, 1, 0))
        data += bytes((b, g, r, round(a * 255)))
    bits = ctypes.c_void_p()
    bih = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=SIZE, biHeight=-SIZE, biPlanes=1,
                           biBitCount=32)
    color = gdi32.CreateDIBSection(None, ctypes.byref(bih), 0, ctypes.byref(bits), None, 0)
    ctypes.memmove(bits, bytes(data), len(data))
    mask = gdi32.CreateBitmap(SIZE, SIZE, 1, 1, None)
    try:
        return user32.CreateIconIndirect(ctypes.byref(ICONINFO(fIcon=True, hbmMask=mask, hbmColor=color)))
    finally:
        gdi32.DeleteObject(color)
        gdi32.DeleteObject(mask)


def _rinari_icon():
    """favicon.svg と同じ図柄（半円のメーターと針）"""
    def mark(dc):
        lb = LOGBRUSH(lbStyle=0, lbColor=0xFFFFFF)
        # PS_GEOMETRIC | PS_SOLID | PS_ENDCAP_ROUND | PS_JOIN_ROUND
        pen = gdi32.ExtCreatePen(0x10000, round(3.5 * SS), ctypes.byref(lb), 0, None)
        old = gdi32.SelectObject(dc, pen)
        s = SS
        gdi32.Arc(dc, 7 * s, 13 * s, 25 * s, 31 * s, 25 * s, 22 * s, 7 * s, 22 * s)
        gdi32.MoveToEx(dc, 16 * s, 22 * s, None)
        gdi32.LineTo(dc, 21 * s, 15 * s)
        gdi32.DeleteObject(gdi32.SelectObject(dc, old))
    return _make_icon(_coverage(_round_rect(14)), _coverage(mark), BLUE, (255, 255, 255))


def _percent_icon(percent, level):
    """使用率の数字のアイコン。色は画面のバッジ（余裕あり／注意／上限間近）と同じ"""
    bg, fg = COLORS.get(level, (BLUE, (255, 255, 255)))
    text = str(min(999, max(0, int(percent))))
    size = 13 if len(text) >= 3 else 19  # 3桁（100%）は小さい字にして収める

    def mark(dc):
        font = gdi32.CreateFontW(-size * SS, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 3, 0, "Segoe UI")  # NONANTIALIASED
        old = gdi32.SelectObject(dc, font)
        gdi32.SetTextColor(dc, 0xFFFFFF)
        gdi32.SetBkMode(dc, 1)  # TRANSPARENT
        rc = wintypes.RECT(0, 0, SIZE * SS, SIZE * SS)
        user32.DrawTextW(dc, text, -1, ctypes.byref(rc), 0x20 | 0x100)  # DT_SINGLELINE | DT_NOCLIP
        gdi32.DeleteObject(gdi32.SelectObject(dc, old))
    return _make_icon(_coverage(_round_rect(10)), _coverage(mark, center=True), bg, fg)


class Tray:
    """トレイのアイコン。別スレッドでメッセージループを回す"""

    def __init__(self, url, on_quit):
        self.url = url
        self.on_quit = on_quit
        self.hwnd = None
        self.hicon = None
        self.icon_key = None
        self.last = 0
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run, name="rinari-tray", daemon=True)

    # health.check から見る（subprocess.Popen と同じ形）: 動いていれば None
    def poll(self):
        return None if self.thread.is_alive() else 0

    def terminate(self):
        if self.hwnd and self.thread.is_alive():
            user32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)
            self.thread.join(2)

    def _run(self):
        try:
            self._setup()
        except Exception:
            self.ready.set()
            return
        self.ready.set()
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        user32.UnregisterClassW("RinariTray", self.hinst)

    def _setup(self):
        self.hinst = kernel32.GetModuleHandleW(None)
        self._proc = WNDPROC(self._wndproc)  # 解放されないように持っておく
        wc = WNDCLASSW(lpfnWndProc=self._proc, hInstance=self.hinst, lpszClassName="RinariTray")
        if not user32.RegisterClassW(ctypes.byref(wc)):
            raise OSError(ctypes.get_last_error())
        # エクスプローラーが再起動したときにアイコンを出し直す
        self.taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")
        self.hwnd = user32.CreateWindowExW(0, "RinariTray", "Rinari", 0, 0, 0, 0, 0, None, None, self.hinst, None)
        if not self.hwnd:
            raise OSError(ctypes.get_last_error())
        self.hicon = _rinari_icon()
        self._notify(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP, tip="Rinari")
        # 起動直後に一度見て、あとは30秒ごと
        user32.SetTimer(self.hwnd, TIMER_FIRST, 3000, None)
        user32.SetTimer(self.hwnd, TIMER_POLL, 30000, None)

    def _notify(self, op, flags, tip=None, title="", body="", level=None):
        nid = NOTIFYICONDATAW(cbSize=ctypes.sizeof(NOTIFYICONDATAW), hWnd=self.hwnd, uID=1, uFlags=flags,
                              uCallbackMessage=WM_TRAY, hIcon=self.hicon)
        if tip is not None:
            nid.szTip = tip if len(tip) < 128 else tip[:126] + "…"
        if flags & NIF_INFO:
            nid.szInfoTitle = title[:63]
            nid.szInfo = (body or " ")[:255]
            nid.uTimeout = 10000
            nid.dwInfoFlags = NIIF.get(level, 1)
        return shell32.Shell_NotifyIconW(op, ctypes.byref(nid))

    def _wndproc(self, hwnd, msg, wparam, lparam):
        try:
            if msg == WM_TRAY:
                if lparam in (WM_LBUTTONDBLCLK, NIN_BALLOONUSERCLICK):
                    self._open()
                elif lparam == WM_RBUTTONUP:
                    self._menu()
                return 0
            if msg == WM_TIMER:
                if wparam == TIMER_FIRST:
                    user32.KillTimer(hwnd, TIMER_FIRST)
                self._check()
                return 0
            if msg == WM_CLOSE:
                user32.DestroyWindow(hwnd)
                return 0
            if msg == WM_DESTROY:
                self._notify(NIM_DELETE, 0)
                if self.hicon:
                    user32.DestroyIcon(self.hicon)
                user32.PostQuitMessage(0)
                return 0
            if msg == self.taskbar_created:
                self._notify(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP, tip=notify.summary())
                return 0
        except Exception:
            pass
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _open(self):
        webbrowser.open(self.url)

    def _menu(self):
        menu = user32.CreatePopupMenu()
        user32.AppendMenuW(menu, 0, ID_OPEN, "ダッシュボードを開く")
        user32.AppendMenuW(menu, 0, ID_TEST, "通知をテスト")
        user32.AppendMenuW(menu, 0x800, 0, None)  # MF_SEPARATOR
        user32.AppendMenuW(menu, 0, ID_QUIT, "Rinari を終了")
        user32.SetMenuDefaultItem(menu, ID_OPEN, False)  # 太字にする
        pt = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        # 前に出しておかないと、メニューの外をクリックしても閉じない
        user32.SetForegroundWindow(self.hwnd)
        cmd = user32.TrackPopupMenu(menu, 0x100 | 0x2, pt.x, pt.y, 0, self.hwnd, None)  # RETURNCMD | RIGHTBUTTON
        user32.PostMessageW(self.hwnd, 0, 0, 0)
        user32.DestroyMenu(menu)
        if cmd == ID_OPEN:
            self._open()
        elif cmd == ID_TEST:
            self._notify(NIM_MODIFY, NIF_INFO, title="Rinari", body="通知はこのように表示されます")
        elif cmd == ID_QUIT:
            threading.Thread(target=self.on_quit, daemon=True).start()
            user32.DestroyWindow(self.hwnd)

    def _set_icon(self, info):
        key = (info["percent"], info["level"]) if info else ()
        if key == self.icon_key:
            return
        old = self.hicon
        self.hicon = _percent_icon(info["percent"], info["level"]) if info else _rinari_icon()
        self.icon_key = key
        self._notify(NIM_MODIFY, NIF_ICON)
        if old:
            user32.DestroyIcon(old)

    def _check(self):
        self._set_icon(notify.icon())
        self._notify(NIM_MODIFY, NIF_TIP, tip=notify.summary())
        alerts = notify.since(self.last)
        if not alerts:
            return
        self.last = alerts[-1]["id"]
        # 通知は続けて出すと最後の1件しか見えないので、まとめて1件にする
        order = {"critical": 0, "warning": 1}
        top = min(alerts, key=lambda a: order.get(a.get("level"), 2))
        lines = [(a.get("body") if a is top else a.get("title")) for a in alerts]
        self._notify(NIM_MODIFY, NIF_INFO, title=str(top.get("title") or "Rinari"),
                     body="\n".join(str(x) for x in lines if x), level=top.get("level"))


def start(url, on_quit):
    """トレイのアイコンを起動して Tray を返す。Windows 以外や起動できないときは None"""
    if os.name != "nt":
        return None
    tray = Tray(url, on_quit)
    tray.thread.start()
    tray.ready.wait(10)
    return tray if tray.hwnd and tray.thread.is_alive() else None
