#!/bin/bash
# Version: 1.1.0 | Updated: 2026-03-11
# [2026-03-11] creds.json から認証情報を読み込む方式に変更
# Google OAuth トークン取得スクリプト（Drive スコープ付き）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CREDS_FILE="$SCRIPT_DIR/creds.json"
TOKEN_FILE="$SCRIPT_DIR/.token.json"

# creds.json の存在確認
if [ ! -f "$CREDS_FILE" ]; then
  echo "エラー: $CREDS_FILE が見つかりません"
  echo "GCP コンソールで OAuth クライアントを作成し、creds.json を配置してください"
  echo "参照: README.md のセットアップ手順"
  exit 1
fi

# [2026-03-11] creds.json から認証情報を読み込み
CLIENT_ID=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['installed']['client_id'])")
CLIENT_SECRET=$(python3 -c "import json; print(json.load(open('$CREDS_FILE'))['installed']['client_secret'])")
SCOPES="https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/script.external_request"
REDIRECT_URI="http://localhost:8085"

# トークンファイルが既にあればリフレッシュを試みる
if [ -f "$TOKEN_FILE" ]; then
  REFRESH_TOKEN=$(python3 -c "import json; print(json.load(open('$TOKEN_FILE'))['refresh_token'])" 2>/dev/null)
  if [ -n "$REFRESH_TOKEN" ]; then
    RESPONSE=$(curl -s -X POST https://oauth2.googleapis.com/token \
      -d "client_id=$CLIENT_ID" \
      -d "client_secret=$CLIENT_SECRET" \
      -d "refresh_token=$REFRESH_TOKEN" \
      -d "grant_type=refresh_token")

    NEW_ACCESS=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
    if [ -n "$NEW_ACCESS" ]; then
      python3 -c "
import json
with open('$TOKEN_FILE') as f:
    data = json.load(f)
data['access_token'] = '$NEW_ACCESS'
with open('$TOKEN_FILE', 'w') as f:
    json.dump(data, f, indent=2)
"
      echo "トークンをリフレッシュしました"
      exit 0
    fi
  fi
fi

# 新規認証フロー
AUTH_URL="https://accounts.google.com/o/oauth2/v2/auth?client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&response_type=code&scope=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$SCOPES'))")&access_type=offline&prompt=consent"

echo "以下のURLをブラウザで開いて認証してください:"
echo ""
echo "$AUTH_URL"
echo ""

# ローカルサーバーで認証コードを受け取る
echo "認証待ち中..."
AUTH_CODE=$(python3 -c "
import http.server, urllib.parse
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code = q.get('code', [''])[0]
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<h1>OK</h1><p>Close this tab.</p>')
        print('CODE:' + code)
    def log_message(self, *a): pass
s = http.server.HTTPServer(('localhost', 8085), H)
s.handle_request()
" 2>&1 | grep "^CODE:" | sed 's/^CODE://')

if [ -z "$AUTH_CODE" ]; then
  echo "認証コードの取得に失敗しました"
  exit 1
fi

# トークン取得
curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=$AUTH_CODE" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "redirect_uri=$REDIRECT_URI" \
  -d "grant_type=authorization_code" \
  -o "$TOKEN_FILE"

echo "トークンを保存しました: $TOKEN_FILE"