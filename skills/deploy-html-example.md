---
name: deploy-html
description: HTMLファイルを社内向けGAS Web Appにデプロイし、公開リンクを返す
user_invocable: true
---

# /deploy-html スキル（設定例）

このファイルを `~/.claude/skills/deploy-html/SKILL.md` にコピーして、
環境に合わせて以下の値を書き換えてください。

## 書き換えが必要な値

- `PROJECT_DIR`: gas-html-host をクローンしたディレクトリのパス
- `FOLDER_ID`: Google Drive のフォルダ ID
- `WEB_APP_URL`: GAS Web App のデプロイ URL

## 使い方

- `/deploy-html path/to/file.html` — HTMLをデプロイして公開リンクを返す
- `/deploy-html path/to/file.html ページ名` — ページ名を指定してデプロイ
- `/deploy-html --list` — デプロイ済みページ一覧
- `/deploy-html --delete ページ名` — ページを削除

## 処理フロー

### デプロイ (`/deploy-html path/to/file.html [ページ名]`)

1. 引数からHTMLファイルパスを取得する
2. Read ツールでHTMLファイルの内容を読み取る
3. ページ名を決定（引数指定 or ファイル名から拡張子を除去。スペースはハイフンに変換）
4. トークンをリフレッシュする:

```bash
cd PROJECT_DIR && bash get-token.sh
```

5. 同名ファイルが既にあれば削除（上書き対応）:

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('PROJECT_DIR/.token.json'))['access_token'])")
FOLDER_ID="YOUR_FOLDER_ID"
PAGE_NAME="ページ名"

EXISTING=$(curl -s "https://www.googleapis.com/drive/v3/files?q=name%3D'${PAGE_NAME}.html'+and+'${FOLDER_ID}'+in+parents+and+trashed%3Dfalse&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)" \
  -H "Authorization: Bearer $TOKEN")

FILE_ID=$(echo "$EXISTING" | python3 -c "import json,sys; files=json.load(sys.stdin).get('files',[]); print(files[0]['id'] if files else '')" 2>/dev/null)
if [ -n "$FILE_ID" ]; then
  curl -s -X PATCH "https://www.googleapis.com/drive/v3/files/$FILE_ID?supportsAllDrives=true" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"trashed":true}'
fi
```

6. HTML ファイルをアップロード:

```bash
echo '{"name":"'${PAGE_NAME}'.html","mimeType":"text/html","parents":["'$FOLDER_ID'"]}' > /tmp/deploy-meta.json

curl -s -X POST "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name&supportsAllDrives=true" \
  -H "Authorization: Bearer $TOKEN" \
  -F "metadata=@/tmp/deploy-meta.json;type=application/json" \
  -F "file=@デプロイ対象ファイルのパス;type=text/html"
```

7. 成功したら公開URLを表示:
```
デプロイ完了: WEB_APP_URL?page=ページ名
ページ一覧: WEB_APP_URL
```

### 一覧表示 (`/deploy-html --list`)

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('PROJECT_DIR/.token.json'))['access_token'])")
curl -s "https://www.googleapis.com/drive/v3/files?q='FOLDER_ID'+in+parents+and+mimeType%3D'text/html'+and+trashed%3Dfalse&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(name,modifiedTime,size)&orderBy=modifiedTime+desc" \
  -H "Authorization: Bearer $TOKEN"
```

### 削除 (`/deploy-html --delete ページ名`)

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('PROJECT_DIR/.token.json'))['access_token'])")
FILE_ID=$(curl -s "https://www.googleapis.com/drive/v3/files?q=name%3D'ページ名.html'+and+'FOLDER_ID'+in+parents+and+trashed%3Dfalse&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; files=json.load(sys.stdin).get('files',[]); print(files[0]['id'] if files else '')")

curl -s -X PATCH "https://www.googleapis.com/drive/v3/files/$FILE_ID?supportsAllDrives=true" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trashed":true}'
```

## エラーハンドリング

- **トークン期限切れ (401)**: `bash get-token.sh` でリフレッシュ → リトライ
- **トークンファイルなし**: `bash get-token.sh` でブラウザ認証を案内
- **ファイルサイズ超過**: GAS HtmlService の上限は約500KB。警告を表示
