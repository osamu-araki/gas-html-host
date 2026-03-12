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
- `AUTHOR`: デプロイ実行者のメールアドレス（メタデータ登録用）

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

7. HTMLの内容からメモ（概要）を自動生成する:
   - `<title>` タグの内容を取得
   - HTMLタグを除去してプレーンテキストにし、先頭100文字を抜粋
   - 形式: `{title} - {先頭100文字}...`（titleがなければ先頭100文字のみ）
   - これをMEMO変数に格納する

8. Drive API で `_metadata.json` を直接更新してメモと投稿者を登録する:
   - 投稿者（AUTHOR）: デプロイ実行者のメールアドレス
   - **注意**: Workspace管理者制限により GAS Web App への外部POST不可のため、Drive API で直接更新する

```bash
AUTHOR="your-email@example.com"

# _metadata.json のファイルIDを取得
META_FILE_ID=$(curl -s "https://www.googleapis.com/drive/v3/files?q=name%3D'_metadata.json'+and+'${FOLDER_ID}'+in+parents+and+trashed%3Dfalse&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)" \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; files=json.load(sys.stdin).get('files',[]); print(files[0]['id'] if files else '')" 2>/dev/null)

if [ -n "$META_FILE_ID" ]; then
  # _metadata.json をダウンロード
  curl -s "https://www.googleapis.com/drive/v3/files/${META_FILE_ID}?alt=media&supportsAllDrives=true" \
    -H "Authorization: Bearer $TOKEN" -o /tmp/deploy-metadata.json

  # Python でメタデータを更新（upsert）
  python3 -c "
import json, sys, os
from datetime import datetime, timezone

name = '${PAGE_NAME}'
memo = '''${MEMO}'''
author = '${AUTHOR}'
html_path = sys.argv[1] if len(sys.argv) > 1 else ''

with open('/tmp/deploy-metadata.json') as f:
    metadata = json.load(f)

now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
file_size = os.path.getsize(html_path) if html_path and os.path.exists(html_path) else 0

if name not in metadata.get('pages', {}):
    if 'pages' not in metadata:
        metadata['pages'] = {}
    metadata['pages'][name] = {
        'author': author,
        'memo': memo,
        'currentVersion': 1,
        'versions': [{'version': 1, 'date': now, 'author': author, 'size': file_size}]
    }
else:
    page = metadata['pages'][name]
    new_ver = page.get('currentVersion', 0) + 1
    page['currentVersion'] = new_ver
    page['author'] = author
    if memo:
        page['memo'] = memo
    page.setdefault('versions', []).append({
        'version': new_ver, 'date': now, 'author': author, 'size': file_size
    })

with open('/tmp/deploy-metadata.json', 'w') as f:
    json.dump(metadata, f, indent=2, ensure_ascii=False)
" "デプロイ対象ファイルのパス"

  # 更新した _metadata.json をアップロード
  curl -s -X PATCH "https://www.googleapis.com/upload/drive/v3/files/${META_FILE_ID}?uploadType=media&supportsAllDrives=true" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: text/plain" \
    --data-binary @/tmp/deploy-metadata.json
fi
```

（注意: メタデータ更新は失敗してもデプロイ自体は成功扱い。次回のGAS Web App表示時に `autoRegisterNewFiles_()` で自動検出される）

9. 成功したら公開URLを表示:
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
- **502 エラー**: Google API の一時的エラー。数秒待ってリトライ（最大2回）
