// Version: 1.1.0 | Updated: 2026-03-11
// HTML社内公開ホスティング基盤
// GAS Web App として動作し、Google Drive 上のHTMLファイルを配信する

// [2026-03-10] Drive フォルダIDは初回セットアップ後に設定する
const FOLDER_ID = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');

/**
 * Web App エントリポイント
 * ?page=xxx でページ配信、パラメータなしで一覧表示
 */
function doGet(e) {
  const pageName = e.parameter.page;

  if (!pageName) {
    return createIndexPage_();
  }

  return serveHtmlPage_(pageName);
}

// [2026-03-11] doPost エントリポイント追加（clasp run の OAuth スコープ制限を回避）
/**
 * Web App POST エントリポイント
 * action: upload / delete / list に対応
 * 認証: スクリプトプロパティの API_KEY で簡易認証
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // [2026-03-11] API キーによる簡易認証
    const apiKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (apiKey && data.key !== apiKey) {
      return jsonResponse_({ success: false, error: '認証エラー: 無効なAPIキー' });
    }

    switch (data.action) {
      case 'upload':
        if (!data.name || !data.content) {
          return jsonResponse_({ success: false, error: 'name と content は必須です' });
        }
        return jsonResponse_(uploadHtml(data.name, data.content));

      case 'delete':
        if (!data.name) {
          return jsonResponse_({ success: false, error: 'name は必須です' });
        }
        return jsonResponse_(deleteHtml(data.name));

      case 'list':
        return jsonResponse_(listPages());

      default:
        return jsonResponse_({ success: false, error: '不明なaction: ' + data.action });
    }
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

/**
 * JSON レスポンスを返すヘルパー
 */
function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * HTMLファイルをDriveフォルダにアップロード
 * @param {string} name - ページ名（拡張子なし）
 * @param {string} content - HTMLコンテンツ
 * @return {Object} 結果オブジェクト {success, url, name}
 */
function uploadHtml(name, content) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const fileName = name + '.html';

  // [2026-03-10] 同名ファイルがあれば上書き
  const existing = folder.getFilesByName(fileName);
  if (existing.hasNext()) {
    existing.next().setTrashed(true);
  }

  folder.createFile(fileName, content, MimeType.HTML);

  const deploymentUrl = ScriptApp.getService().getUrl();
  return {
    success: true,
    name: name,
    url: deploymentUrl + '?page=' + name
  };
}

/**
 * HTMLファイルをDriveフォルダから削除（clasp run から呼び出し）
 * @param {string} name - ページ名（拡張子なし）
 * @return {Object} 結果オブジェクト {success, name}
 */
function deleteHtml(name) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const fileName = name + '.html';
  const files = folder.getFilesByName(fileName);

  if (files.hasNext()) {
    files.next().setTrashed(true);
    return { success: true, name: name };
  }

  return { success: false, error: 'ファイルが見つかりません: ' + name };
}

/**
 * デプロイ済みページ一覧を取得（clasp run から呼び出し）
 * @return {Object} ページ一覧 {pages: [{name, lastUpdated, size}]}
 */
function listPages() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFilesByType(MimeType.HTML);
  const pages = [];

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName().replace(/\.html$/, '');
    pages.push({
      name: name,
      lastUpdated: file.getLastUpdated().toISOString(),
      size: file.getSize()
    });
  }

  // [2026-03-10] 更新日時の降順でソート
  pages.sort(function(a, b) {
    return new Date(b.lastUpdated) - new Date(a.lastUpdated);
  });

  return { pages: pages };
}

/**
 * 初回セットアップ: DriveフォルダIDをスクリプトプロパティに保存
 * @param {string} folderId - Google Drive フォルダID
 */
function setup(folderId) {
  PropertiesService.getScriptProperties().setProperty('FOLDER_ID', folderId);
  return { success: true, folderId: folderId };
}

// --- プライベート関数 ---

/**
 * 指定ページのHTMLを配信
 */
function serveHtmlPage_(pageName) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const fileName = pageName + '.html';
  const files = folder.getFilesByName(fileName);

  if (!files.hasNext()) {
    return HtmlService.createHtmlOutput(
      '<h1>404 - ページが見つかりません</h1><p><a href="' + ScriptApp.getService().getUrl() + '">一覧に戻る</a></p>'
    ).setTitle('Not Found');
  }

  const content = files.next().getBlob().getDataAsString();
  return HtmlService.createHtmlOutput(content)
    .setTitle(pageName)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * インデックスページ（ページ一覧）を生成
 */
function createIndexPage_() {
  const result = listPages();
  const baseUrl = ScriptApp.getService().getUrl();

  let html = '<!DOCTYPE html><html><head><meta charset="utf-8">';
  html += '<meta name="viewport" content="width=device-width, initial-scale=1">';
  html += '<title>HTML Host - ページ一覧</title>';
  html += '<style>';
  html += 'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #283C50; }';
  html += 'h1 { color: #2A9BA1; border-bottom: 2px solid #94CDD0; padding-bottom: 12px; }';
  html += 'table { width: 100%; border-collapse: collapse; margin-top: 20px; }';
  html += 'th { background: #2A9BA1; color: white; padding: 10px 12px; text-align: left; }';
  html += 'td { padding: 10px 12px; border-bottom: 1px solid #e0e0e0; }';
  html += 'tr:hover { background: #f5fafa; }';
  html += 'a { color: #2A9BA1; text-decoration: none; }';
  html += 'a:hover { text-decoration: underline; }';
  html += '.empty { color: #939DA7; font-style: italic; margin-top: 20px; }';
  html += '</style></head><body>';
  html += '<h1>HTML Host</h1>';

  if (result.pages.length === 0) {
    html += '<p class="empty">公開ページはまだありません。</p>';
  } else {
    html += '<table><tr><th>ページ名</th><th>最終更新</th><th>サイズ</th></tr>';
    result.pages.forEach(function(page) {
      const date = new Date(page.lastUpdated);
      const dateStr = date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
      const sizeKb = (page.size / 1024).toFixed(1) + ' KB';
      html += '<tr>';
      html += '<td><a href="' + baseUrl + '?page=' + page.name + '">' + page.name + '</a></td>';
      html += '<td>' + dateStr + '</td>';
      html += '<td>' + sizeKb + '</td>';
      html += '</tr>';
    });
    html += '</table>';
  }

  html += '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('HTML Host - ページ一覧');
}
