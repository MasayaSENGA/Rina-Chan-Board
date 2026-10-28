# Rinari のタスクトレイアイコン。rinari/tray.py が起動する（直接は実行しない）
# - 左ダブルクリック / メニュー: ダッシュボードを開く
# - Rinari の通知（/api/alerts）を Windows の通知として出す
# - Rinari が終了したら自分も終了する
param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$ParentPid,
    [Parameter(Mandatory = $true)][string]$Token
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$base = "http://127.0.0.1:$Port"

function Invoke-Rinari([string]$Path, [string]$Method = 'GET') {
    $wc = New-Object System.Net.WebClient
    $wc.Encoding = [System.Text.Encoding]::UTF8
    $wc.Headers.Add('X-Rinari-Token', $Token)
    try {
        if ($Method -eq 'POST') { return $wc.UploadString("$base$Path", 'POST', '') }
        return ($wc.DownloadString("$base$Path") | ConvertFrom-Json)
    } finally { $wc.Dispose() }
}

# アイコン（favicon.svg と同じ図柄を描く）
function New-RinariIcon {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(42, 120, 214))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 14
    $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc(31 - $r, 0, $r, $r, 270, 90)
    $path.AddArc(31 - $r, 31 - $r, $r, $r, 0, 90); $path.AddArc(0, 31 - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath($bg, $path)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 3.5
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($pen, 7, 13, 18, 18, 180, 180)
    $g.DrawLine($pen, 16, 22, 21, 15)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

function Open-Dashboard { Start-Process "$base/" }

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = New-RinariIcon
$icon.Text = 'Rinari'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('ダッシュボードを開く')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Open-Dashboard })
$test = $menu.Items.Add('通知をテスト')
$test.add_Click({ $icon.ShowBalloonTip(5000, 'Rinari', '通知はこのように表示されます', [System.Windows.Forms.ToolTipIcon]::Info) })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Rinari を終了')
$quit.add_Click({
    try { [void](Invoke-Rinari '/api/shutdown' 'POST') } catch { Stop-Process -Id $ParentPid -ErrorAction SilentlyContinue }
    $icon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu
$icon.add_MouseDoubleClick({ Open-Dashboard })
$icon.add_BalloonTipClicked({ Open-Dashboard })

$script:last = 0
$check = {
    # 親（Rinari）が終わっていたら自分も終わる
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        $icon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
        return
    }
    try {
        $res = Invoke-Rinari "/api/alerts?after=$($script:last)"
    } catch { return }
    $tip = [string]$res.summary
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 62) + '…' }
    $icon.Text = $tip
    $alerts = @($res.alerts | Where-Object { $null -ne $_ })
    if ($alerts.Count -eq 0) { return }
    # 通知は続けて出すと最後の1件しか見えないので、まとめて1件にする
    $top = $alerts | Sort-Object { switch ($_.level) { 'critical' { 0 } 'warning' { 1 } default { 2 } } } | Select-Object -First 1
    $kind = switch ($top.level) { 'critical' { 'Error' } 'warning' { 'Warning' } default { 'Info' } }
    $lines = foreach ($a in $alerts) { if ($a -eq $top) { [string]$a.body } else { [string]$a.title } }
    $body = (($lines | Where-Object { $_ }) -join "`n")
    if (-not $body) { $body = ' ' }
    $icon.ShowBalloonTip(10000, [string]$top.title, $body, [System.Windows.Forms.ToolTipIcon]::$kind)
    $script:last = [int]$res.last
}
$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 30000
$poll.add_Tick($check)
$poll.Start()
# 起動直後にも一度見ておく
$first = New-Object System.Windows.Forms.Timer
$first.Interval = 3000
$first.add_Tick({ $first.Stop(); & $check })
$first.Start()

[System.Windows.Forms.Application]::Run()
$icon.Dispose()
