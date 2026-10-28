# Rinari

Claude の利用上限と、モデル別の使用割合をブラウザで確認できる自分専用のダッシュボードです。
パソコンの中だけで動き、`http://127.0.0.1:8765/` で開きます。

- **利用上限**: 5時間枠・週間枠（全モデル）・モデル別の週間枠（Fable など）の使用率とリセット時刻
  - 枠ごとの推移グラフと、今のペースが続いたときの予測（リセット時の使用率、または上限に達する時刻）
- **モデル別の使用割合**: 期間（今日／7日間／30日間／全期間）と値（全トークン／出力トークン／応答数／料金換算）を切り替えて表示
  - API 料金換算の合計と1日あたり、割合バー、日別の推移、曜日×時間帯のヒートマップ、モデル別・プロジェクト別の内訳

Python 3.9 以上の標準ライブラリだけで動きます。追加のインストールは要りません。

## 使い方

1. 先に Claude Code CLI でログインしておいてください（`claude` を起動して `/login`）。Rinari はそのログイン情報を使います。
2. `start.bat` をダブルクリックするか、このフォルダで次のコマンドを実行します。

```bash
python -m rinari
```

ブラウザが自動で開きます。終了するときは、起動したウィンドウで `Ctrl+C` を押します。

| オプション | 内容 |
|---|---|
| `--port 番号` | 待ち受けるポート（既定: 8765） |
| `--no-browser` | 起動時にブラウザを開かない |

利用上限は5分ごと、使用割合は1分ごとに自動で更新します。「今すぐ更新」ですぐに取り直せます。同じポートで二重に起動しようとすると、メッセージを出して終了します。

### PC 起動時に自動で起動する

`pythonw.exe` で起動するショートカットを Windows のスタートアップフォルダに置くと、サインイン時にウィンドウを出さずに起動します。PowerShell で次を一度実行します（このフォルダで実行してください）。

```powershell
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$([Environment]::GetFolderPath('Startup'))\Rinari.lnk"); $s.TargetPath = "$env:LOCALAPPDATA\Microsoft\WindowsApps\pythonw.exe"; $s.Arguments = "-m rinari --no-browser"; $s.WorkingDirectory = (Get-Location).Path; $s.Save()
```

- ブラウザは開かないので、`http://127.0.0.1:8765/` をブックマークしておくと便利です。
- python.org 版の Python では、`TargetPath` を `pythonw.exe` の実際の場所（`(Get-Command pythonw).Source` で確認）にしてください。
- ウィンドウが無いので `Ctrl+C` では止められません。止めるときは PowerShell で次を実行します。

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8765 -State Listen).OwningProcess
```

- 自動起動をやめるときは、`Win+R` で `shell:startup` を開いて `Rinari.lnk` を削除します。

## 仕組み

- **利用上限**は Claude Code の `/usage` と同じ `https://api.anthropic.com/api/oauth/usage` から取得します。認証には Claude Code のログイン情報（`%USERPROFILE%\.claude\.credentials.json`）を使い、期限切れのときは Claude Code と同じ方法で更新して書き戻します（Claude Code はそのまま使い続けられます）。
- **モデル別の使用割合**は Claude Code の会話ログ（`%USERPROFILE%\.claude\projects\**\*.jsonl`）から集計します。同じ応答が複数行に記録されるので、メッセージIDで重複を除いています。
- 環境変数 `CLAUDE_CONFIG_DIR` を設定している場合は、`.claude` の代わりにそのフォルダを使います。
- ログは大きくなるので、ファイルごとの集計結果を `%LOCALAPPDATA%\Rinari\stats-cache.json` にキャッシュし、変わったファイルだけ読み直します。
- **推移と予測**: 利用上限 API は過去の値を返さないので、Rinari は起動している間ずっと5分ごとに使用率を取得して `%LOCALAPPDATA%\Rinari\limits-history.jsonl` に記録します（35日より古い記録は自動で削除）。予測は直近のペース（5時間枠は直近1時間、週間枠は直近24時間）を延ばしたもので、記録が足りないうちは枠の始まりからの平均ペースを使います。
- **API 料金換算**: ログのトークン数に Anthropic の公開単価（2026-10-06 時点）を掛けた目安です。キャッシュ作成は5分／1時間の区別、fast モードの2倍料金も反映します。サブスクリプションの実際の請求額ではありません。単価は [rinari/pricing.py](rinari/pricing.py) にあるので、変わったらそこを直してください。
- Microsoft Store 版の Python では、`%LOCALAPPDATA%` への書き込みが `%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.*\LocalCache\Local\Rinari` に振り替えられます。

## 安全のために

- サーバーは `127.0.0.1` だけで待ち受けます。同じネットワークの他の端末からは見えません。
- `127.0.0.1` / `localhost` 以外の Host ヘッダーの要求は拒否します（DNS リバインディング対策）。
- アクセストークンはブラウザへの応答に含めません。送信先は `api.anthropic.com`（使用状況の取得）と `platform.claude.com`（トークン更新）だけです。
- 画面は外部の CDN などを読み込みません。

## 注意

- Anthropic 非公式の個人製ツールです。Anthropic とは関係ありません。
- 使っている usage API は Anthropic の非公開エンドポイントです。仕様が変わると表示できなくなることがあります。
- 使用割合に入るのは Claude Code（デスクトップアプリの Code タブを含む）の利用だけです。claude.ai の通常チャットの利用はパソコンに記録されないため含まれません。利用上限の % は claude.ai での利用も含めた全体の値です。
- ログイン情報は Claude Code と共有しています。トークンの更新が Claude Code と同時に起きると、どちらかで再ログインが必要になる場合があります。

## ライセンス

[MIT License](LICENSE)
