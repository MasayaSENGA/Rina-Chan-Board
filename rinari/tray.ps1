# Rinari のタスクトレイアイコン。rinari/tray.py が起動する（直接は実行しない）
# - 左ダブルクリック / メニュー: ダッシュボードを開く
# - Rinari の通知（/api/alerts）を Windows の通知として出す
# - アイコンに使用率の数字を描く（いま一番効いている枠。70% から黄、90% から赤）
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

# GetHicon で作ったアイコンは自分で破棄しないと描き直すたびに漏れる
Add-Type -Namespace Rinari -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr hIcon);'

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

# 使用率の数字のアイコン。色は画面のバッジ（余裕あり／注意／上限間近）と同じ
function New-PercentIcon([int]$Percent, [string]$Level) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    switch ($Level) {
        'critical' { $bgColor = [System.Drawing.Color]::FromArgb(208, 59, 59); $fg = [System.Drawing.Color]::White }
        'warning' { $bgColor = [System.Drawing.Color]::FromArgb(250, 178, 25); $fg = [System.Drawing.Color]::FromArgb(11, 11, 11) }
        default { $bgColor = [System.Drawing.Color]::FromArgb(42, 120, 214); $fg = [System.Drawing.Color]::White }
    }
    $bg = New-Object System.Drawing.SolidBrush $bgColor
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = 10
    $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc(31 - $r, 0, $r, $r, 270, 90)
    $path.AddArc(31 - $r, 31 - $r, $r, $r, 0, 90); $path.AddArc(0, 31 - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath($bg, $path)
    $text = [string][Math]::Min(999, [Math]::Max(0, $Percent))
    # 3桁（100%）は小さい字にして収める
    $size = if ($text.Length -ge 3) { 13 } else { 19 }
    $font = New-Object System.Drawing.Font('Segoe UI', $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString($text, $font, (New-Object System.Drawing.SolidBrush $fg), (New-Object System.Drawing.RectangleF(-2, 1, 36, 32)), $fmt)
    $g.Dispose(); $font.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}

$script:iconKey = ''
function Set-TrayIcon($info) {
    $key = if ($info) { "$($info.percent)/$($info.level)" } else { '' }
    if ($key -eq $script:iconKey) { return }
    $old = $icon.Icon
    $icon.Icon = if ($info) { New-PercentIcon ([int]$info.percent) ([string]$info.level) } else { New-RinariIcon }
    $script:iconKey = $key
    if ($old) { [void][Rinari.Native]::DestroyIcon($old.Handle); $old.Dispose() }
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
    Set-TrayIcon $res.icon
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
