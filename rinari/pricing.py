"""API 料金換算に使う単価（USD / 100万トークン）。

Anthropic の公開単価（2026-10-06 時点）を元にしている。単価が変わったらこの表を直す。
サブスクリプションの実際の請求額ではなく「同じ量を API で使ったらいくらか」の目安。
"""

# モデルIDの接頭辞 -> (入力, 出力, キャッシュ読込)
# キャッシュ作成は入力単価の 1.25倍（5分）/ 2倍（1時間）
PRICES = {
    "claude-fable-5-1": (10.0, 50.0, 0.25),
    "claude-mythos-5-1": (10.0, 50.0, 0.25),
    "claude-fable-5": (10.0, 50.0, 1.0),
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 0.50),
    "claude-opus-4-8": (5.0, 25.0, 0.50),
    "claude-opus-4-7": (5.0, 25.0, 0.50),
    "claude-opus-4-6": (5.0, 25.0, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-sonnet-4-6": (3.0, 15.0, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "claude-haiku-4-5": (1.0, 5.0, 0.10),
}
# Haiku 5.5 はプロンプトが 10万トークンを超えると単価が上がる
HAIKU_5_5_LONG = (0.50, 2.50, 0.05)
HAIKU_5_5_LONG_THRESHOLD = 100_000

WRITE_5M = 1.25
WRITE_1H = 2.0
FAST_MULTIPLIER = 2.0  # fast モードは標準の2倍


def _lookup(model):
    # 長い接頭辞から先に当てる（claude-opus-5-5 を claude-opus-5 より優先）
    for key in sorted(PRICES, key=len, reverse=True):
        if model == key or model.startswith(key + "-"):
            return key, PRICES[key]
    return None, None


def cost_usd(model, inp, out, cc5m, cc1h, cr, fast=False):
    """1応答の API 料金換算（USD）。単価が分からないモデルは None"""
    key, p = _lookup(model)
    if p is None:
        return None
    if key == "claude-haiku-5-5" and inp + cc5m + cc1h + cr > HAIKU_5_5_LONG_THRESHOLD:
        p = HAIKU_5_5_LONG
    pin, pout, pread = p
    usd = (inp * pin + out * pout + cc5m * pin * WRITE_5M + cc1h * pin * WRITE_1H + cr * pread) / 1_000_000
    return usd * FAST_MULTIPLIER if fast else usd
