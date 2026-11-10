# WebLingo — URLでWebサイトを翻訳するアプリ

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/anon-3m9q8x/Weblingo-translator-)

↑ ボタンを押して Render にログイン（GitHubアカウントで可）→「Apply」で、`https://〜.onrender.com` の公開URLが発行されます（無料プラン）。

任意の **公開WebページのURL** を入力すると、ページのHTMLから主要テキストを抽出し、原文と翻訳文を左右に並べて読めるWebアプリです。スマホでは「原文 / 翻訳」の切り替え表示になります。

## 1. 起動方法

### macOS

Python 3.10以上をインストールし、このフォルダ内でターミナルを開いて次のコマンドを実行してください。

```bash
python3 -m pip install -r requirements.txt
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
```

または `start_mac.command` を実行します（初回はターミナルからの実行を推奨）。

### Windows

Python 3.10以上をインストールした後に `start_windows.bat` を実行するか、次を実行します。

```powershell
py -m pip install -r requirements.txt
py -m uvicorn app:app --host 127.0.0.1 --port 8000
```

ブラウザで **http://127.0.0.1:8000** を開きます。終了時はターミナルで `Ctrl+C`。

※ アプリは `index.html` を直接開くだけでは動作しません。URL取得・翻訳にはPythonサーバーが必要です。

## 2. 使い方

1. `https://www.example.com/article` のような公開URLを入力。
2. 翻訳元の言語を選ぶ（初期設定はページHTMLの `lang` 属性を参照）。
3. 日本語などの翻訳先を選ぶ。
4. 翻訳エンジンを「無料翻訳」または「AI翻訳」から選ぶ。
5. 「ページを翻訳」を押す。抽出した原文が先に表示され、翻訳は順番に反映されます。
6. 原文/翻訳の比較、コピー、テキスト保存、文字サイズ変更、テーマ切り替えが利用できます。

## 3. 翻訳エンジン

### 無料翻訳（初期設定）

[MyMemory の公開API](https://mymemory.translated.net/doc/spec.php) を利用。**APIキー不要**で始められますが、匿名利用には [1日5,000文字](https://mymemory.translated.net/doc/usagelimits.php) の上限があり、1リクエストは最大500バイトです。WebLingoでは1ページあたり最大4,000文字を翻訳対象にし、超過部分を未翻訳として表示します。複数ページや利用者で上限を共有することがあり、APIの混雑・障害時は翻訳できない場合があります。利用時にページ本文がMyMemoryのサーバーへ送信されます。

**重要：** ページが言語を宣言していない場合、翻訳元の自動検出は英語を仮定します。英語以外のページでは翻訳元を手動で指定してください。

### AI翻訳（APIキー設定時）

`.env.example` を参考に API キーを**サーバーの環境変数**に設定します（ブラウザに入力しません）。

macOS / Linux:

```bash
export OPENAI_API_KEY='sk-...'
export OPENAI_MODEL='gpt-4o-mini'
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Windows PowerShell:

```powershell
$env:OPENAI_API_KEY='sk-...'
$env:OPENAI_MODEL='gpt-4o-mini'
py -m uvicorn app:app --host 127.0.0.1 --port 8000
```

AI翻訳はOpenAI Chat Completions APIを使用してテキストを翻訳します。APIの利用料金が別途発生します。初期モデルは `gpt-4o-mini` です。ブラウザ側にAPIキーは公開しません。本文をOpenAIのAPIへ送信するため、機密情報の翻訳には利用するサービスの規約とデータの取扱いを確認してください。1ページ当たりのAI翻訳上限は30,000文字です。

## 4. 対応範囲と制約

- **できること:** 一般公開されたHTMLページの本文を取得し、見出し・段落・箇条書き・引用・画像を読みやすいレイアウトに並べて翻訳する。翻訳結果をコピー/保存する。
- **完全コピーではない:** 元サイトの見た目やCSS/JavaScriptを完全複製するのではなく、本文を再構成した「リーダー表示」です。複雑な表組み、動的なレイアウトなどは変化します。
- **取得できないもの:** ログインが必要なページ、CAPTCHA、JavaScriptのみで描画される本文、PDF、動画の字幕、画像内の文字、JavaScriptアプリなど。サイト側にアクセス制限がある場合は取得できません。
- **URLの移動:** 元サイト内のリンクを押した場合、リンク先は別タブの元サイトで開かれます（リンク先を自動翻訳する機能はありません）。
- **翻訳元の推定:** ページのHTML `lang` 属性のみ参照。言語が設定されていない場合は英語として扱うので、手動変更を推奨。
- **画像:** 公開画像がある場合は表示することがありますが、画像を提供する外部サーバーにブラウザが直接アクセスします。
- **履歴:** 最近使ったURLのみブラウザの localStorage に保存。サーバーに履歴を永続化しません。

## 5. ファイル構成

```
WebLingo_Translator/
├── app.py                 # FastAPIサーバー / API / 認証・制限
├── extractor.py           # HTML本文抽出
├── limits.py              # レート制限・1日上限（メモリ上）
├── security.py            # URL・DNSチェック、IP固定接続（SSRF対策）
├── translation.py         # MyMemory / OpenAI翻訳
├── static/
│   ├── index.html         # Web UI
│   ├── styles.css         # PC / スマホ / ダークテーマ
│   └── app.js             # UI操作・非同期翻訳
├── tests/                 # 自動テスト
├── requirements.txt
├── Dockerfile / render.yaml / Procfile   # 公開用デプロイ設定
├── .env.example           # 環境変数の一覧
├── start_mac.command
└── start_windows.bat
```

### API

- `GET /healthz` — ヘルスチェック
- `GET /api/status` — 設定状態
- `POST /api/extract` — `{ "url": "https://example.org" }`
- `POST /api/translate` — `{ "items": [{"id": "b1", "text": "Hello"}], "source_language": "en", "target_language": "ja", "provider": "free" }`

## 6. サイトとして公開する

外部データベースは不要です。Python が動くホスティング（Render / Railway / Fly.io / Docker が使える VPS など）にそのままデプロイできます。HTTPS はホスティング側で提供されるものを利用してください。

### Render（無料プランあり・おすすめ）

1. このリポジトリを GitHub に置く。
2. [Render](https://render.com) で **New → Blueprint** を選び、このリポジトリを指定（`render.yaml` が自動で読み込まれます）。
3. 必要に応じて環境変数を入力（`APP_PASSWORD`、`OPENAI_API_KEY` など）→ デプロイ。
4. 発行された `https://〜.onrender.com` を開く。

※ 無料プランは一定時間アクセスがないとスリープし、次回アクセス時の起動に数十秒かかります。

### Docker（VPS など）

```bash
docker build -t weblingo .
docker run -d -p 8000:8000 --env-file .env --restart unless-stopped weblingo
```

前段に nginx / Caddy などのリバースプロキシを置き、HTTPS 化してください（`X-Forwarded-For` を渡せば訪問者ごとのレート制限が正しく働きます）。

### Railway / Heroku 系

`Procfile` が使われます。環境変数を設定してデプロイするだけです。

### 環境変数

| 変数 | 既定値 | 内容 |
|---|---|---|
| `APP_PASSWORD` | なし | 設定するとサイト全体にパスワード（Basic認証）。ユーザー名は `APP_USERNAME`（既定 `weblingo`） |
| `OPENAI_API_KEY` | なし | AI翻訳を有効化 |
| `OPENAI_MODEL` | `gpt-4o-mini` | AI翻訳のモデル |
| `AI_DAILY_CHAR_LIMIT` | `200000` | サーバー全体の AI翻訳の1日上限文字数（費用上限。`0` で無制限） |
| `MYMEMORY_EMAIL` | なし | 無料翻訳の上限を 1日5,000→50,000文字に引き上げ |
| `RATE_LIMIT_EXTRACT` | `20` | IPごと・10分あたりのページ取得回数 |
| `RATE_LIMIT_TRANSLATE` | `200` | IPごと・10分あたりの翻訳リクエスト回数 |
| `MAX_CONCURRENT_FETCHES` | `8` | 同時に取得するページ数 |

### 公開時の安全対策（実装済み）

- **SSRF 対策：** プライベートIP・ローカルホスト・80/443以外のポートを拒否。リダイレクト先も毎回検査。DNSで確認した**IPアドレスに直接接続**し（TLS証明書は元のホスト名で検証）、DNSリバインディングを防ぎます。プロキシ環境変数は使いません。
- **乱用・費用対策：** IPごとのレート制限、同時取得数の上限、AI翻訳の1日あたり文字数上限、取得ページ2MB上限。
- **任意のパスワード保護：** `APP_PASSWORD` を設定すると全ページ・APIが認証必須に（`/healthz` を除く）。
- **ブラウザ側：** CSP、HSTS（HTTPS時）、X-Frame-Options、nosniff、Referrer-Policy、Permissions-Policy。APIキーはサーバーのみで保持。
- **ヘルスチェック：** `GET /healthz`

### 注意点

- レート制限と1日上限はサーバーのメモリ上で数えるため、**1インスタンス（1ワーカー）での運用**を前提にしています。再起動でリセットされます。
- 無料翻訳（MyMemory）の上限は**サーバーのIP単位**で共有されます。利用者が多い場合は `MYMEMORY_EMAIL` か AI翻訳を設定してください。
- AI翻訳を有効にして一般公開する場合は、`APP_PASSWORD` の設定、または OpenAI 側の利用上限設定も併用してください。

## 7. テスト

```bash
python3 -m pip install pytest
python3 -m pytest -q
```

## 参考API仕様

- [MyMemory API Technical Specifications](https://mymemory.translated.net/doc/spec.php)
- [MyMemory Usage Limits](https://mymemory.translated.net/doc/usagelimits.php)
- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
