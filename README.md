# HTML Host

Google Apps Script Web App + Google Drive を使った社内向け HTML ホスティング基盤。

Claude Code などの CLI ツールから HTML ファイルをデプロイし、Google Workspace 認証付きで社内メンバーに配信できます。

## アーキテクチャ

```
CLI (Claude Code)  →  Google Drive API  →  共有ドライブ  ←  GAS Web App (本体)  →  生HTML配信
                      (OAuth 2.0)          (HTML保存)        (doGet配信)
                                                           ←  GAS Web App (ナビ)  →  ナビ付き表示
                                                              (iframe ラッパー)       (navbar/drawer)
```

- **アップロード**: Drive API v3 で共有ドライブに HTML ファイルを保存
- **配信（本体GAS）**: doGet が Drive からファイルを読み取って生HTMLを返す
- **配信（ナビGAS）**: iframe で本体GASを埋め込み、ナビバー・ドロワー・ページ遷移を提供
- **認証**: 閲覧は Google Workspace SSO（組織ドメインのみ）

## セットアップ

### 前提条件

- Google Workspace アカウント
- [clasp](https://github.com/nicholaschiang/clasp) (`npm install -g @nicholaschiang/clasp`)
- Python 3
- curl

### 1. GCP プロジェクトの準備

1. [Google Cloud Console](https://console.cloud.google.com/) で新しいプロジェクトを作成（または既存を使用）
2. **APIとサービス** → **ライブラリ** で以下を有効化:
   - Google Drive API
   - Apps Script API
3. **OAuth 同意画面** を設定:
   - ユーザータイプ: **内部**（Workspace の場合）
   - スコープ: `https://www.googleapis.com/auth/drive`
4. **認証情報** → **認証情報を作成** → **OAuth クライアント ID**:
   - アプリケーションの種類: **デスクトップアプリ**
   - JSON をダウンロードして `creds.json` として配置

### 2. GAS プロジェクトのデプロイ

```bash
# リポジトリをクローン
git clone https://github.com/osamu-araki/gas-html-host.git
cd gas-html-host

# clasp でログイン
clasp login

# GAS プロジェクトを新規作成
clasp create --type standalone --title "HTML Host"

# コードをプッシュ
clasp push --force

# GAS エディタを開く
clasp open
```

GAS エディタで:
1. `authorize` 関数を実行して Drive 権限を承認
2. **デプロイ** → **新しいデプロイ** → **ウェブアプリ**
   - 実行ユーザー: **自分**
   - アクセス: 組織に応じて選択

### 3. 初期設定

Google Drive に HTML ファイル格納用のフォルダを作成し、フォルダ ID を設定:

```bash
# GAS エディタから setup 関数を実行
# または clasp run が使える場合:
clasp run setup --params '["YOUR_FOLDER_ID"]'
```

### 4. OAuth トークンの取得

```bash
# creds.json を配置した状態で実行
bash get-token.sh
```

ブラウザが開くので Google アカウントで認証してください。

## 使い方

### HTML ファイルのアップロード

```bash
# トークンリフレッシュ
bash get-token.sh

# アップロード
TOKEN=$(python3 -c "import json; print(json.load(open('.token.json'))['access_token'])")
FOLDER_ID="YOUR_FOLDER_ID"

echo '{"name":"page-name.html","mimeType":"text/html","parents":["'$FOLDER_ID'"]}' > /tmp/meta.json

curl -s -X POST "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name&supportsAllDrives=true" \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@/tmp/meta.json;type=application/json" \
  -F "file=@your-file.html;type=text/html"
```

### ページの閲覧

```
# 本体GAS（生HTML配信）
https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec          # 一覧
https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?page=xxx # 個別ページ

# ナビGAS（ナビバー・ドロワー付き表示）
https://script.google.com/macros/s/YOUR_NAV_DEPLOYMENT_ID/exec?page=xxx
```

### Claude Code スキルとの連携

`/deploy-html` スキルを設定すると、Claude Code から1コマンドでデプロイできます。
HTMLの内容から概要メモが自動生成され、投稿者情報とともに登録されます。

#### スキルのセットアップ

```bash
# 1. スキルディレクトリを作成
mkdir -p ~/.claude/skills/deploy-html

# 2. 設定例をコピー
cp skills/deploy-html-example.md ~/.claude/skills/deploy-html/SKILL.md

# 3. SKILL.md を開いて以下の値を自分の環境に合わせて書き換え
#    - PROJECT_DIR: このリポジトリのパス
#    - FOLDER_ID: Google Drive のフォルダ ID
#    - WEB_APP_URL: GAS Web App のデプロイ URL
#    - AUTHOR: 自分のメールアドレス
```

#### スキルの使い方

```bash
# HTML をデプロイ（メモ自動生成）
/deploy-html path/to/file.html

# ページ名を指定してデプロイ
/deploy-html path/to/file.html my-page

# デプロイ済みページ一覧
/deploy-html --list

# ページを削除
/deploy-html --delete my-page
```

## ファイル構成

```
gas-html-host/
├── Code.gs              # 本体GAS メインコード（doGet / doPost / 一覧・配信・バージョン管理）
├── appsscript.json      # GAS マニフェスト
├── get-token.sh         # OAuth トークン取得・リフレッシュスクリプト
├── docs/
│   └── architecture.html # 設計ドキュメント
├── skills/
│   └── deploy-html-example.md  # Claude Code スキル定義の例
├── .gitignore
└── README.md
```

ナビラッパーGAS（別プロジェクト）:
- iframe で本体GASのページを表示し、ナビバー・サイドドロワー・ページ遷移・全画面表示を提供
- 本体GASの `NAV_BASE_URL` 定数からリンク

以下は各自で用意（.gitignore 対象）:
- `creds.json` — GCP OAuth クライアント認証情報
- `.token.json` — OAuth トークン（自動生成）
- `.clasp.json` — clasp プロジェクト紐付け

## 制限事項

| 項目 | 制限 |
|------|------|
| ファイルサイズ | 約 500KB / ページ（GAS HtmlService の上限） |
| カスタムドメイン | 非対応（GAS Web App の制約） |
| 外部リソース | CDN からの CSS/JS 読み込みは可能 |

## ライセンス

MIT
