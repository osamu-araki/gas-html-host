// Version: 2.7.0 | Updated: 2026-03-12
// [2026-03-12] v2.7.0: doPost に update-metadata アクション追加（スキルからメモ・投稿者自動登録）
// HTML社内公開ホスティング基盤
// GAS Web App として動作し、Google Drive 上のHTMLファイルを配信する
// [2026-03-11] v2.0.0: 履歴管理・投稿者・メモ・Driveインポート・ページネーション・プレビュー追加
// [2026-03-11] v2.1.0: 高速化(メタデータベース一覧+キャッシュ)・Driveフォルダ読み込みボタン・ファビコン
// [2026-03-11] v2.2.0: 白画面修正・スキル化ガイド・プレビューキャッシュ
// [2026-03-11] v2.3.0: プレビューモーダルの最大化ボタン・リサイズ対応

const FOLDER_ID = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
const ITEMS_PER_PAGE = 100;
// [2026-03-11] ファビコン base64（16x16 PNG、ティール背景に白い </> マーク）
var FAVICON_B64_ = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZElEQVR4nGNggAKt2Qv/k4IZkAGpmlEMIVcz3BBiFE05e4F0A0AAG5soA5A1wGzHZQiGAegKkZ2PzRAGfJqx+R9dDV4DsAUeXgNw+Z9oL6ArJOR/2kUjocRDlAHEYsozE6XZGQCLeGgrqauFjAAAAABJRU5ErkJggg==';

// ============================================================
// Web App エントリポイント
// ============================================================

function doGet(e) {
  const pageName = e.parameter.page;
  const version = e.parameter.v;

  if (!pageName) {
    const pageNum = parseInt(e.parameter.p) || 1;
    return createIndexPage_(pageNum);
  }

  // [2026-03-11] バージョン指定対応
  if (version) {
    return serveVersionPage_(pageName, parseInt(version));
  }

  return serveHtmlPage_(pageName);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    const apiKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (apiKey && data.key !== apiKey) {
      return jsonResponse_({ success: false, error: '認証エラー: 無効なAPIキー' });
    }

    switch (data.action) {
      case 'upload':
        if (!data.name || !data.content) {
          return jsonResponse_({ success: false, error: 'name と content は必須です' });
        }
        return jsonResponse_(uploadHtml(data.name, data.content, data.memo || ''));

      case 'delete':
        if (!data.name) {
          return jsonResponse_({ success: false, error: 'name は必須です' });
        }
        return jsonResponse_(deleteHtml(data.name));

      case 'list':
        return jsonResponse_(listPages());

      // [2026-03-12] スキルからメモ・投稿者の自動登録用
      case 'update-metadata':
        if (!data.name) {
          return jsonResponse_({ success: false, error: 'name は必須です' });
        }
        return jsonResponse_(updatePageMetadata_(data.name, data.memo, data.author));

      default:
        return jsonResponse_({ success: false, error: '不明なaction: ' + data.action });
    }
  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// メタデータ管理（_metadata.json）
// ============================================================

// [2026-03-11] メタデータをDriveフォルダ内のJSONファイルで管理
function getMetadata_() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFilesByName('_metadata.json');

  if (files.hasNext()) {
    try {
      return JSON.parse(files.next().getBlob().getDataAsString());
    } catch (e) {
      return { pages: {} };
    }
  }
  return { pages: {} };
}

function saveMetadata_(metadata) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFilesByName('_metadata.json');

  if (files.hasNext()) {
    files.next().setContent(JSON.stringify(metadata, null, 2));
  } else {
    folder.createFile('_metadata.json', JSON.stringify(metadata, null, 2), MimeType.PLAIN_TEXT);
  }
}

// ============================================================
// 公開関数（google.script.run / doPost から呼び出し）
// ============================================================

/**
 * HTMLファイルをDriveフォルダにアップロード（バージョン管理付き）
 * @param {string} name - ページ名（拡張子なし）
 * @param {string} content - HTMLコンテンツ
 * @param {string} memo - メモ（任意）
 * @return {Object} 結果オブジェクト
 */
function uploadHtml(name, content, memo) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const fileName = name + '.html';
  const author = Session.getActiveUser().getEmail() || '不明';
  const now = new Date().toISOString();

  // [2026-03-11] メタデータ読み込み
  const metadata = getMetadata_();
  if (!metadata.pages[name]) {
    metadata.pages[name] = { author: author, memo: memo || '', currentVersion: 0, versions: [] };
  }

  const pageMeta = metadata.pages[name];
  const newVersion = pageMeta.currentVersion + 1;

  // [2026-03-11] 既存ファイルをバージョン付きにリネーム（履歴保持）
  const existing = folder.getFilesByName(fileName);
  if (existing.hasNext()) {
    const oldFile = existing.next();
    oldFile.setName(name + '_v' + pageMeta.currentVersion + '.html');
  }

  // 新しいファイルを作成
  const newFile = folder.createFile(fileName, content, MimeType.HTML);

  // メタデータ更新
  pageMeta.currentVersion = newVersion;
  pageMeta.author = author;
  if (memo !== undefined && memo !== '') {
    pageMeta.memo = memo;
  }
  pageMeta.versions.push({
    version: newVersion,
    date: now,
    author: author,
    size: newFile.getSize()
  });

  saveMetadata_(metadata);
  invalidateCache_();

  const deploymentUrl = ScriptApp.getService().getUrl();
  return {
    success: true,
    name: name,
    version: newVersion,
    url: deploymentUrl + '?page=' + name
  };
}

/**
 * HTMLファイルを削除（全バージョン含む）
 */
function deleteHtml(name) {
  const folder = DriveApp.getFolderById(FOLDER_ID);

  // 現在のファイルを削除
  const files = folder.getFilesByName(name + '.html');
  let deleted = false;
  while (files.hasNext()) {
    files.next().setTrashed(true);
    deleted = true;
  }

  // [2026-03-11] バージョンファイルも削除
  const metadata = getMetadata_();
  if (metadata.pages[name]) {
    metadata.pages[name].versions.forEach(function(v) {
      const vFiles = folder.getFilesByName(name + '_v' + v.version + '.html');
      while (vFiles.hasNext()) {
        vFiles.next().setTrashed(true);
      }
    });
    delete metadata.pages[name];
    saveMetadata_(metadata);
    invalidateCache_();
  }

  if (deleted) {
    return { success: true, name: name };
  }
  return { success: false, error: 'ファイルが見つかりません: ' + name };
}

/**
 * ページ一覧を取得（メタデータベース・高速版）
 * [2026-03-11] Drive ファイル走査を廃止し、メタデータから一覧を生成
 * [2026-03-12] キャッシュミス時にDriveフォルダの未登録ファイルを自動検出・登録
 */
function listPages() {
  // キャッシュチェック（60秒）
  var cache = CacheService.getScriptCache();
  var cached = cache.get('pageList');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  // キャッシュがない場合、未登録ファイルを自動検出して登録
  autoRegisterNewFiles_();

  var metadata = getMetadata_();
  var pages = [];

  for (var name in metadata.pages) {
    var meta = metadata.pages[name];
    var versions = meta.versions || [];
    var latest = versions.length > 0 ? versions[versions.length - 1] : null;

    pages.push({
      name: name,
      lastUpdated: latest ? latest.date : '',
      size: latest ? latest.size : 0,
      author: meta.author || '',
      memo: meta.memo || '',
      currentVersion: meta.currentVersion || 1,
      versionCount: versions.length
    });
  }

  pages.sort(function(a, b) {
    return new Date(b.lastUpdated) - new Date(a.lastUpdated);
  });

  var result = { pages: pages, total: pages.length };
  cache.put('pageList', JSON.stringify(result), 60);
  return result;
}

/**
 * [2026-03-12] Driveフォルダ内の未登録HTMLファイルを自動検出してメタデータに登録
 * listPages() のキャッシュミス時に呼ばれる（最大60秒に1回）
 */
function autoRegisterNewFiles_() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByType(MimeType.HTML);
  var metadata = getMetadata_();
  var added = false;
  var now = new Date().toISOString();

  while (files.hasNext()) {
    var file = files.next();
    var rawName = file.getName();
    if (/_v\d+\.html$/.test(rawName)) continue;
    var name = rawName.replace(/\.html$/, '');
    if (metadata.pages[name]) continue;

    var owner = '';
    try { owner = file.getOwner() ? file.getOwner().getEmail() : ''; } catch (e) { owner = ''; }

    metadata.pages[name] = {
      author: owner,
      memo: '',
      currentVersion: 1,
      versions: [{
        version: 1,
        date: now,
        author: owner,
        size: file.getSize()
      }]
    };
    added = true;
  }

  if (added) {
    saveMetadata_(metadata);
  }
}

/**
 * キャッシュを無効化（データ更新後に呼び出し）
 */
function invalidateCache_() {
  CacheService.getScriptCache().remove('pageList');
}

/**
 * ページのバージョン履歴を取得
 */
function getVersionHistory(name) {
  const metadata = getMetadata_();
  const pageMeta = metadata.pages[name];
  if (!pageMeta) {
    return { success: false, error: 'ページが見つかりません' };
  }
  return {
    success: true,
    name: name,
    currentVersion: pageMeta.currentVersion,
    versions: pageMeta.versions.slice().reverse()
  };
}

/**
 * ページのHTMLコンテンツを取得（プレビュー用・CacheService対応）
 */
function getPageContent(name) {
  // [2026-03-11] CacheServiceから取得を試みる
  var cache = CacheService.getScriptCache();
  var cacheKey = 'content_' + name;
  var cached = cache.get(cacheKey);
  if (cached) {
    return { success: true, content: cached };
  }

  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByName(name + '.html');
  if (!files.hasNext()) {
    return { success: false, error: 'ファイルが見つかりません' };
  }
  var content = files.next().getBlob().getDataAsString();

  // CacheServiceの上限は100KB/キー。超える場合はキャッシュしない
  if (content.length < 100000) {
    cache.put(cacheKey, content, 300);
  }
  return { success: true, content: content };
}

/**
 * [2026-03-11] 最新10件のコンテンツをCacheServiceにプリフェッチ
 * インデックスページ生成時に裏で読み込んでおく
 */
function prefetchContentToCache_(pages) {
  var cache = CacheService.getScriptCache();
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var count = Math.min(10, pages.length);
  var toCache = {};

  for (var i = 0; i < count; i++) {
    var cacheKey = 'content_' + pages[i].name;
    if (cache.get(cacheKey)) continue;
    try {
      var files = folder.getFilesByName(pages[i].name + '.html');
      if (files.hasNext()) {
        var content = files.next().getBlob().getDataAsString();
        if (content.length < 100000) {
          toCache[cacheKey] = content;
        }
      }
    } catch (e) { /* skip */ }
  }

  if (Object.keys(toCache).length > 0) {
    cache.putAll(toCache, 300);
  }
}

/**
 * [2026-03-11] 本文検索 — HTMLコンテンツ内をキーワードで検索し、マッチしたページ名を返す
 * タグを除去したテキストで検索するため、HTMLタグはヒットしない
 * @param {string} query - 検索キーワード
 * @return {Object} { success: true, matches: ["page1", "page2", ...] }
 */
function searchContent(query) {
  if (!query || query.length < 2) {
    return { success: true, matches: [] };
  }

  var folder = DriveApp.getFolderById(FOLDER_ID);
  var metadata = getMetadata_();
  var matches = [];
  var q = query.toLowerCase();

  for (var name in metadata.pages) {
    // まずCacheServiceから取得を試みる
    var cache = CacheService.getScriptCache();
    var cacheKey = 'content_' + name;
    var content = cache.get(cacheKey);

    if (!content) {
      try {
        var files = folder.getFilesByName(name + '.html');
        if (!files.hasNext()) continue;
        content = files.next().getBlob().getDataAsString();
        // キャッシュに保存（100KB未満のみ）
        if (content.length < 100000) {
          cache.put(cacheKey, content, 300);
        }
      } catch (e) { continue; }
    }

    // HTMLタグを除去してテキストのみで検索
    var text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    if (text.indexOf(q) >= 0) {
      matches.push(name);
    }
  }

  return { success: true, matches: matches };
}

/**
 * メモを更新
 */
function updateMemo(name, memo) {
  const metadata = getMetadata_();
  if (!metadata.pages[name]) {
    return { success: false, error: 'ページが見つかりません' };
  }
  metadata.pages[name].memo = memo;
  saveMetadata_(metadata);
  invalidateCache_();
  return { success: true, name: name };
}

/**
 * [2026-03-12] ページのメタデータ（メモ・投稿者）を更新
 * スキルからのデプロイ時に呼ばれる
 */
function updatePageMetadata_(name, memo, author) {
  const metadata = getMetadata_();
  if (!metadata.pages[name]) {
    return { success: false, error: 'ページが見つかりません' };
  }
  var page = metadata.pages[name];
  if (memo !== undefined && memo !== null) {
    page.memo = memo;
  }
  if (author !== undefined && author !== null && author !== '') {
    page.author = author;
    // 最新バージョンの投稿者も更新
    if (page.versions && page.versions.length > 0) {
      page.versions[page.versions.length - 1].author = author;
    }
  }
  saveMetadata_(metadata);
  invalidateCache_();
  return { success: true, name: name };
}

/**
 * [2026-03-11] Driveフォルダ内の未登録HTMLファイルをスキャンして即登録
 * メタデータに登録されていないファイルを自動で読み込む
 */
function scanAndImportDriveFiles() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByType(MimeType.HTML);
  var metadata = getMetadata_();
  var imported = [];
  var now = new Date().toISOString();

  while (files.hasNext()) {
    var file = files.next();
    var rawName = file.getName();
    if (/_v\d+\.html$/.test(rawName)) continue;
    var name = rawName.replace(/\.html$/, '');
    if (metadata.pages[name]) continue;

    var owner = '';
    try { owner = file.getOwner() ? file.getOwner().getEmail() : Session.getActiveUser().getEmail(); } catch (e) { owner = Session.getActiveUser().getEmail(); }

    metadata.pages[name] = {
      author: owner,
      memo: '',
      currentVersion: 1,
      versions: [{
        version: 1,
        date: now,
        author: owner,
        size: file.getSize()
      }]
    };

    imported.push({ name: name, author: owner });
  }

  if (imported.length > 0) {
    saveMetadata_(metadata);
    invalidateCache_();
  }

  return { success: true, imported: imported, count: imported.length };
}

/**
 * 過去バージョンを復元
 */
function restoreVersion(name, version) {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var versionFileName = name + '_v' + version + '.html';
  var files = folder.getFilesByName(versionFileName);

  if (!files.hasNext()) {
    return { success: false, error: 'バージョン ' + version + ' が見つかりません' };
  }

  var content = files.next().getBlob().getDataAsString();
  return uploadHtml(name, content, 'v' + version + ' から復元');
}

/**
 * 初回セットアップ
 */
function setup(folderId) {
  PropertiesService.getScriptProperties().setProperty('FOLDER_ID', folderId);
  return { success: true, folderId: folderId };
}

// ============================================================
// プライベート関数
// ============================================================

function serveHtmlPage_(pageName) {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var fileName = pageName + '.html';
  var files = folder.getFilesByName(fileName);

  if (!files.hasNext()) {
    return HtmlService.createHtmlOutput(
      '<h1>404 - ページが見つかりません</h1><p><a href="' + ScriptApp.getService().getUrl() + '">一覧に戻る</a></p>'
    ).setTitle('Not Found');
  }

  var content = files.next().getBlob().getDataAsString();
  return HtmlService.createHtmlOutput(content)
    .setTitle(pageName)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// [2026-03-11] 過去バージョンのHTML配信
function serveVersionPage_(pageName, version) {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var fileName = pageName + '_v' + version + '.html';
  var files = folder.getFilesByName(fileName);

  if (!files.hasNext()) {
    return HtmlService.createHtmlOutput(
      '<h1>404 - バージョンが見つかりません</h1><p><a href="' + ScriptApp.getService().getUrl() + '">一覧に戻る</a></p>'
    ).setTitle('Not Found');
  }

  var content = files.next().getBlob().getDataAsString();
  return HtmlService.createHtmlOutput(content)
    .setTitle(pageName + ' (v' + version + ')')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ============================================================
// インデックスページ生成
// ============================================================

function createIndexPage_(pageNum) {
  var result = listPages();
  var baseUrl = ScriptApp.getService().getUrl();
  var allPages = result.pages;

  // [2026-03-11] 最新10件をサーバー側CacheServiceにプリフェッチ
  prefetchContentToCache_(allPages);

  var totalPages = Math.ceil(allPages.length / ITEMS_PER_PAGE) || 1;
  if (pageNum > totalPages) pageNum = totalPages;

  var startIdx = (pageNum - 1) * ITEMS_PER_PAGE;
  var endIdx = Math.min(startIdx + ITEMS_PER_PAGE, allPages.length);
  var displayPages = allPages.slice(startIdx, endIdx);

  var html = '';
  html += '<!DOCTYPE html><html><head><meta charset="utf-8">';
  html += '<meta name="viewport" content="width=device-width, initial-scale=1">';
  // [2026-03-11] ファビコン（16x16 PNG、ティール背景に白い </> マーク）
  var FI = FAVICON_B64_;
  html += '<link rel="icon" type="image/png" href="data:image/png;base64,' + FI + '">';
  html += '<link rel="shortcut icon" type="image/png" href="data:image/png;base64,' + FI + '">';
  html += '<title>HTML Host</title>';
  html += '<style>';
  html += buildStyles_();
  html += '</style></head><body>';

  // ヘッダー
  html += '<h1>HTML Host</h1>';

  // 使い方・制限事項
  html += buildGuideSection_();

  // アップロード + Driveスキャン（横並び）
  html += '<div class="two-col">';
  html += '<div class="col">';
  html += buildUploadSection_();
  html += '</div>';
  html += '<div class="col">';
  html += buildDriveImportSection_();
  html += '</div>';
  html += '</div>';

  // メッセージ表示エリア
  html += '<div class="msg msg-success" id="successMsg"></div>';
  html += '<div class="msg msg-error" id="errorMsg"></div>';

  // [2026-03-11] ページ一覧 + キーワード検索
  html += '<div class="list-header">';
  html += '<h2 style="margin:0">公開ページ一覧';
  if (allPages.length > 0) {
    html += ' <span class="count" id="pageCount">(' + allPages.length + '件)</span>';
  }
  html += '</h2>';
  if (displayPages.length > 0) {
    html += '<div style="position:relative;display:inline-block">';
    html += '<input type="text" id="searchInput" class="search-input" placeholder="ページ名・投稿者・メモ・本文で検索..." oninput="filterTable()">';
    html += '<span id="searchStatus" class="search-status"></span>';
    html += '</div>';
  }
  html += '</div>';

  if (displayPages.length === 0) {
    html += '<p class="empty">公開ページはまだありません。</p>';
  } else {
    html += '<table id="pageTable"><tr><th>ページ名</th><th>投稿者</th><th>メモ</th><th>Ver</th><th>最終更新</th><th>サイズ</th><th>操作</th></tr>';
    displayPages.forEach(function(page) {
      var date = new Date(page.lastUpdated);
      // [2026-03-11] 分単位まで表示
      var dateStr = date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate() + ' ' + date.getHours() + ':' + ('0' + date.getMinutes()).slice(-2);
      var sizeKb = (page.size / 1024).toFixed(1) + ' KB';
      var safeName = page.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      var safeMemo = (page.memo || '').replace(/"/g, '&quot;').replace(/'/g, "\\'");

      html += '<tr id="row-' + page.name + '">';
      html += '<td><a href="' + baseUrl + '?page=' + encodeURIComponent(page.name) + '" target="_blank">' + escapeHtml_(page.name) + '</a></td>';
      html += '<td class="author">' + escapeHtml_(page.author ? page.author.split('@')[0] : '') + '</td>';
      html += '<td class="memo-cell">';
      html += '<span class="memo-text" id="memo-' + page.name + '">' + escapeHtml_(page.memo || '') + '</span>';
      html += '<button class="btn-icon" onclick="editMemo(\'' + safeName + '\', \'' + safeMemo + '\')" title="メモ編集">&#9998;</button>';
      html += '</td>';
      html += '<td class="ver-cell">';
      html += '<span>v' + page.currentVersion + '</span>';
      if (page.versionCount > 1) {
        html += ' <button class="btn-link" onclick="showHistory(\'' + safeName + '\')">履歴</button>';
      }
      html += '</td>';
      html += '<td>' + dateStr + '</td>';
      html += '<td>' + sizeKb + '</td>';
      html += '<td class="actions">';
      html += '<button class="btn-sm btn-preview" onclick="doPreview(\'' + safeName + '\')">プレビュー</button>';
      html += '<button class="btn-sm btn-danger" onclick="doDelete(\'' + safeName + '\')">削除</button>';
      html += '</td>';
      html += '</tr>';
    });
    html += '</table>';
  }

  // ページネーション
  if (totalPages > 1) {
    html += '<div class="pagination">';
    for (var i = 1; i <= totalPages; i++) {
      if (i === pageNum) {
        html += '<span class="page-current">' + i + '</span>';
      } else {
        html += '<a class="page-link" href="' + baseUrl + '?p=' + i + '">' + i + '</a>';
      }
    }
    html += '</div>';
  }

  // モーダル（プレビュー / 履歴）
  html += buildModals_();

  // JavaScript
  html += '<script>';
  html += buildScript_(baseUrl);
  html += '</script>';
  html += '</body></html>';

  return HtmlService.createHtmlOutput(html).setTitle('HTML Host');
}

// --- スタイル ---
function buildStyles_() {
  return [
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #283C50; }',
    'h1 { color: #2A9BA1; border-bottom: 2px solid #94CDD0; padding-bottom: 12px; }',
    'h2 { color: #283C50; font-size: 18px; margin-top: 32px; }',
    '.count { font-size: 14px; color: #939DA7; font-weight: normal; }',
    'table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 14px; }',
    'th { background: #2A9BA1; color: white; padding: 8px 10px; text-align: left; font-size: 13px; white-space: nowrap; }',
    'td { padding: 8px 10px; border-bottom: 1px solid #e0e0e0; }',
    'tr:hover { background: #f5fafa; }',
    'a { color: #2A9BA1; text-decoration: none; }',
    'a:hover { text-decoration: underline; }',
    '.empty { color: #939DA7; font-style: italic; margin-top: 16px; }',

    // 2カラムレイアウト
    '.two-col { display: flex; gap: 20px; margin-top: 8px; }',
    '.two-col .col { flex: 1; min-width: 0; }',
    '@media (max-width: 700px) { .two-col { flex-direction: column; } }',

    // アップロードエリア
    '.upload-area { background: #f8fafa; border: 2px dashed #94CDD0; border-radius: 8px; padding: 20px; margin-top: 12px; }',
    '.upload-area.dragover { background: #e0f2f2; border-color: #2A9BA1; }',
    '.form-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; flex-wrap: wrap; }',
    '#fileName { color: #939DA7; font-size: 13px; margin-top: 6px; }',

    // ボタン
    '.btn { display: inline-block; padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }',
    '.btn-primary { background: #2A9BA1; color: white; }',
    '.btn-primary:hover { background: #27878A; }',
    '.btn:disabled { opacity: 0.5; cursor: not-allowed; }',
    '.btn-sm { padding: 3px 10px; font-size: 12px; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; background: white; margin-right: 4px; }',
    '.btn-preview { color: #2A9BA1; border-color: #2A9BA1; }',
    '.btn-preview:hover { background: #f0f9fa; }',
    '.btn-danger { color: #e53935; border-color: #e53935; }',
    '.btn-danger:hover { background: #fbe9e7; }',
    '.btn-link { background: none; border: none; color: #2A9BA1; cursor: pointer; font-size: 12px; padding: 0 4px; text-decoration: underline; }',
    '.btn-icon { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 4px; color: #939DA7; }',
    '.btn-icon:hover { color: #2A9BA1; }',

    // メッセージ
    '.msg { padding: 10px 16px; border-radius: 4px; margin-top: 12px; display: none; }',
    '.msg-success { background: #d4edda; color: #155724; }',
    '.msg-error { background: #f8d7da; color: #721c24; }',

    // フォーム
    'input[type="text"] { padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }',
    '.input-wide { width: 100%; box-sizing: border-box; }',
    'textarea { padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; resize: vertical; }',

    // セル
    '.author { font-size: 13px; color: #555; white-space: nowrap; }',
    '.memo-cell { max-width: 200px; font-size: 13px; color: #666; }',
    '.memo-text { display: inline-block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }',
    '.ver-cell { white-space: nowrap; font-size: 13px; }',
    '.actions { white-space: nowrap; }',

    // Driveインポート
    '.drive-import { background: #f8f8fc; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-top: 12px; }',
    '.drive-import .form-row { margin-top: 8px; }',

    // [2026-03-11] 検索バー + 一覧ヘッダー
    '.list-header { display: flex; justify-content: space-between; align-items: center; margin-top: 32px; gap: 16px; flex-wrap: wrap; }',
    '.search-input { padding: 8px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; width: 280px; }',
    '.search-input:focus { outline: none; border-color: #2A9BA1; box-shadow: 0 0 0 2px rgba(42,155,161,0.15); }',
    '.search-status { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 12px; color: #939DA7; }',

    // ページネーション
    '.pagination { margin-top: 24px; text-align: center; }',
    '.pagination .page-link, .pagination .page-current { display: inline-block; padding: 6px 12px; margin: 0 2px; border-radius: 4px; }',
    '.page-current { background: #2A9BA1; color: white; font-weight: bold; }',
    '.page-link { border: 1px solid #ccc; color: #283C50; }',
    '.page-link:hover { background: #f0f9fa; text-decoration: none; }',

    // モーダル
    '.modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; }',
    '.modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; border-radius: 8px; width: 90%; max-width: 900px; max-height: 85vh; z-index: 1001; display: flex; flex-direction: column; }',
    // [2026-03-11] プレビューモーダルはリサイズ可能
    '.modal-preview { resize: both; overflow: hidden; min-width: 400px; min-height: 300px; }',
    '.modal-preview.maximized { top: 2%; left: 2%; width: 96% !important; height: 96% !important; max-width: none !important; max-height: none !important; transform: none !important; border-radius: 4px; }',
    '.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #eee; }',
    '.modal-header h3 { margin: 0; font-size: 16px; flex: 1; }',
    '.modal-header-btns { display: flex; align-items: center; gap: 8px; }',
    '.modal-close { background: none; border: none; font-size: 24px; cursor: pointer; color: #999; padding: 0 4px; }',
    '.modal-close:hover { color: #333; }',
    '.btn-maximize { background: none; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; color: #666; padding: 2px 8px; font-size: 16px; line-height: 1; }',
    '.btn-maximize:hover { background: #f0f9fa; border-color: #2A9BA1; color: #2A9BA1; }',
    '.modal-body { padding: 20px; overflow-y: auto; flex: 1; }',
    '.modal-body iframe { width: 100%; height: 100%; min-height: 60vh; border: 1px solid #eee; border-radius: 4px; }',
    '.maximized .modal-body iframe { min-height: 0; }',

    // 履歴テーブル
    '.history-table { width: 100%; border-collapse: collapse; font-size: 14px; }',
    '.history-table th { background: #f5f5f5; color: #283C50; padding: 8px 10px; text-align: left; }',
    '.history-table td { padding: 8px 10px; border-bottom: 1px solid #eee; }',

    // ガイド
    '.guide { background: #f8fafa; border: 1px solid #94CDD0; border-radius: 8px; padding: 16px 20px; margin-top: 12px; font-size: 14px; line-height: 1.6; }',
    '.guide summary { cursor: pointer; font-weight: bold; color: #2A9BA1; }',
    '.guide ul { margin: 8px 0; padding-left: 20px; }',
    '.guide li { margin: 4px 0; }',
    '.guide .limit { color: #939DA7; font-size: 13px; margin-top: 8px; border-top: 1px solid #ddd; padding-top: 8px; }'
  ].join('\n');
}

// --- 使い方ガイド ---
function buildGuideSection_() {
  var html = '<details class="guide"><summary>使い方・制限事項</summary>';
  html += '<ul>';
  html += '<li><b>HTMLアップロード</b>: ファイル選択またはドラッグ&ドロップでHTMLファイルをアップロードできます。</li>';
  html += '<li><b>Driveから読み込む</b>: 対象の共有Driveフォルダに直接HTMLファイルを置き、「スキャン」ボタンを押すと未登録ファイルが自動で読み込まれます。投稿者はファイル所有者が自動設定されます。</li>';
  html += '<li><b>バージョン管理</b>: 同名ファイルを再アップロードすると、旧バージョンが自動保存されます。「履歴」から過去バージョンの閲覧・復元が可能です。</li>';
  html += '<li><b>プレビュー</b>: 一覧の「プレビュー」ボタンでページ内容を確認できます。</li>';
  html += '<li><b>メモ</b>: 各ページに説明メモを追加・編集できます。</li>';
  html += '<li><b>CLI デプロイ</b>: Claude Code の <code>/deploy-html</code> スキルでコマンドラインからもデプロイ可能です。</li>';
  html += '</ul>';

  // Claude Code スキル化ガイド
  html += '<div style="margin-top:12px;padding:12px 16px;background:#f0f9fa;border-radius:6px;border-left:3px solid #2A9BA1">';
  html += '<b>Claude Code でスキル化する方法</b>';
  html += '<ol style="margin:6px 0 0;padding-left:20px;font-size:13px;line-height:1.7">';
  html += '<li>GitHub リポジトリ <code>gas-html-host</code> をクローン</li>';
  html += '<li><code>skills/deploy-html-example.md</code> をコピーして <code>~/.claude/skills/deploy-html/SKILL.md</code> に配置</li>';
  html += '<li>SKILL.md 内の <code>PROJECT_DIR</code>、<code>FOLDER_ID</code>、<code>WEB_APP_URL</code> を自分の環境に合わせて書き換え</li>';
  html += '<li>Claude Code で <code>/deploy-html</code> と入力すれば準備完了</li>';
  html += '</ol>';
  html += '<div style="margin-top:8px;font-size:13px"><b>スキル化でできること:</b></div>';
  html += '<ul style="margin:4px 0 0;padding-left:20px;font-size:13px;line-height:1.6">';
  html += '<li><code>/deploy-html file.html</code> — HTMLファイルをワンコマンドでデプロイ、公開URLを即取得</li>';
  html += '<li><code>/deploy-html --list</code> — デプロイ済みページの一覧をターミナルで確認</li>';
  html += '<li><code>/deploy-html --delete ページ名</code> — 不要なページをコマンドラインから削除</li>';
  html += '<li>Claude Code が生成したHTML（レポート・ダッシュボード等）を会話中にそのままデプロイ可能</li>';
  html += '</ul>';
  html += '</div>';

  html += '<div class="limit">';
  html += '<b>制限事項:</b> ';
  html += 'ファイルサイズ上限 約500KB/ページ ｜ ';
  html += 'カスタムドメイン非対応 ｜ ';
  html += 'CDNからのCSS/JS読み込みは可能 ｜ ';
  html += '閲覧にはGoogle Workspace認証が必要';
  html += '</div></details>';
  return html;
}

// --- アップロードフォーム ---
function buildUploadSection_() {
  var html = '<h2 style="margin-top:12px">HTML アップロード</h2>';
  html += '<div class="upload-area" id="dropZone">';
  html += '<input type="file" id="fileInput" accept=".html,.htm" style="display:none">';
  html += '<div class="form-row">';
  html += '<button class="btn btn-primary" onclick="document.getElementById(\'fileInput\').click()">ファイルを選択</button>';
  html += '<span>またはここにドラッグ&ドロップ</span>';
  html += '</div>';
  html += '<div id="fileName"></div>';
  html += '<div class="form-row">';
  html += '<label>ページ名:</label>';
  html += '<input type="text" id="pageName" placeholder="省略時はファイル名" style="width:180px">';
  html += '</div>';
  html += '<div class="form-row">';
  html += '<label>メモ:</label>';
  html += '<input type="text" id="uploadMemo" placeholder="任意" style="width:300px">';
  html += '</div>';
  html += '<div class="form-row">';
  html += '<button class="btn btn-primary" id="uploadBtn" onclick="doUpload()" disabled>アップロード</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

// [2026-03-11] Google Drive フォルダ読み込みボタン（即読み込み）
function buildDriveImportSection_() {
  var folderUrl = 'https://drive.google.com/drive/folders/' + FOLDER_ID;
  var html = '<h2 style="margin-top:12px">Google Drive から読み込む</h2>';
  html += '<div class="drive-import">';
  html += '<p style="font-size:13px;margin:0 0 10px;line-height:1.5">';
  html += '<a href="' + folderUrl + '" target="_blank">対象フォルダ</a> にHTMLファイルを置いてからスキャンしてください。';
  html += '<br>未登録ファイルを自動で読み込みます（投稿者=ファイル所有者）。';
  html += '</p>';
  html += '<button class="btn btn-primary" id="scanBtn" onclick="scanDrive()">Drive フォルダをスキャン</button>';
  html += '<div id="scanResult" style="margin-top:10px;font-size:13px"></div>';
  html += '</div>';
  return html;
}

// --- モーダル ---
function buildModals_() {
  var html = '';

  // [2026-03-11] プレビューモーダル（最大化・リサイズ対応）
  html += '<div class="modal-overlay" id="previewOverlay" onclick="closePreview()">';
  html += '<div class="modal modal-preview" id="previewModal" onclick="event.stopPropagation()">';
  html += '<div class="modal-header">';
  html += '<h3 id="previewTitle">プレビュー</h3>';
  html += '<div class="modal-header-btns">';
  html += '<button class="btn-maximize" id="maximizeBtn" onclick="toggleMaximize()" title="最大化/元に戻す">&#9634;</button>';
  html += '<button class="modal-close" onclick="closePreview()">&times;</button>';
  html += '</div></div>';
  html += '<div class="modal-body" id="previewBody"></div>';
  html += '</div></div>';

  // 履歴モーダル
  html += '<div class="modal-overlay" id="historyOverlay" onclick="closeHistory()">';
  html += '<div class="modal" onclick="event.stopPropagation()">';
  html += '<div class="modal-header">';
  html += '<h3 id="historyTitle">バージョン履歴</h3>';
  html += '<button class="modal-close" onclick="closeHistory()">&times;</button>';
  html += '</div>';
  html += '<div class="modal-body" id="historyBody"></div>';
  html += '</div></div>';

  // メモ編集モーダル
  html += '<div class="modal-overlay" id="memoOverlay" onclick="closeMemo()">';
  html += '<div class="modal" style="max-width:500px" onclick="event.stopPropagation()">';
  html += '<div class="modal-header">';
  html += '<h3>メモ編集</h3>';
  html += '<button class="modal-close" onclick="closeMemo()">&times;</button>';
  html += '</div>';
  html += '<div class="modal-body">';
  html += '<textarea id="memoInput" rows="3" style="width:100%;box-sizing:border-box"></textarea>';
  html += '<input type="hidden" id="memoPageName">';
  html += '<div style="margin-top:12px;text-align:right">';
  html += '<button class="btn btn-primary" onclick="saveMemo()">保存</button>';
  html += '</div></div></div></div>';

  return html;
}

// --- JavaScript ---
function buildScript_(baseUrl) {
  var js = '';

  // [2026-03-11] ベースURL（リダイレクト用）
  js += 'var BASE_URL = "' + baseUrl + '";';

  // [2026-03-11] GAS iframe内からのリダイレクト（target="_top"で親フレームをナビゲート）
  js += 'function goTop() {';
  js += '  var link = "<a href=\\"" + BASE_URL + "\\" target=\\"_top\\" style=\\"color:#155724;text-decoration:underline;margin-left:8px\\">トップに戻る</a>";';
  js += '  var el = document.getElementById("successMsg");';
  js += '  el.innerHTML = el.textContent + link;';
  js += '  try { window.open(BASE_URL, "_top"); } catch(e) {}';
  js += '}';

  // プレビューキャッシュ（クライアント側）
  js += 'var previewCache = {};';

  // ファイルアップロード
  js += 'var fileContent = null;';
  js += 'document.getElementById("fileInput").addEventListener("change", function(e) {';
  js += '  if (e.target.files[0]) handleFile(e.target.files[0]);';
  js += '});';
  js += 'var dz = document.getElementById("dropZone");';
  js += 'dz.addEventListener("dragover", function(e) { e.preventDefault(); dz.classList.add("dragover"); });';
  js += 'dz.addEventListener("dragleave", function() { dz.classList.remove("dragover"); });';
  js += 'dz.addEventListener("drop", function(e) { e.preventDefault(); dz.classList.remove("dragover"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });';

  js += 'function handleFile(file) {';
  js += '  document.getElementById("fileName").textContent = file.name + " (" + (file.size/1024).toFixed(1) + " KB)";';
  js += '  var ni = document.getElementById("pageName");';
  js += '  if (!ni.value) ni.value = file.name.replace(/\\.html?$/i, "");';
  js += '  var r = new FileReader();';
  js += '  r.onload = function(e) { fileContent = e.target.result; document.getElementById("uploadBtn").disabled = false; };';
  js += '  r.readAsText(file);';
  js += '}';

  // アップロード実行
  js += 'function doUpload() {';
  js += '  if (!fileContent) return;';
  js += '  var name = document.getElementById("pageName").value.trim();';
  js += '  var memo = document.getElementById("uploadMemo").value.trim();';
  js += '  if (!name) { showMsg("error", "ページ名を入力してください"); return; }';
  js += '  setUploading(true);';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    if (r.success) { showMsg("success", r.name + " v" + r.version + " をアップロードしました"); setTimeout(function() { goTop(); }, 1500); }';
  js += '    else { showMsg("error", r.error); setUploading(false); }';
  js += '  }).withFailureHandler(function(e) { showMsg("error", e.message); setUploading(false); }).uploadHtml(name, fileContent, memo);';
  js += '}';

  js += 'function setUploading(on) {';
  js += '  var b = document.getElementById("uploadBtn");';
  js += '  b.disabled = on; b.textContent = on ? "アップロード中..." : "アップロード";';
  js += '}';

  // 削除
  js += 'function doDelete(name) {';
  js += '  if (!confirm(name + " を削除しますか？（全バージョン削除されます）")) return;';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    if (r.success) { var row = document.getElementById("row-" + name); if (row) row.remove(); showMsg("success", name + " を削除しました"); }';
  js += '    else { showMsg("error", r.error); }';
  js += '  }).withFailureHandler(function(e) { showMsg("error", e.message); }).deleteHtml(name);';
  js += '}';

  // [2026-03-11] Drive フォルダスキャン（即読み込み）
  js += 'function scanDrive() {';
  js += '  var btn = document.getElementById("scanBtn");';
  js += '  var res = document.getElementById("scanResult");';
  js += '  btn.disabled = true; btn.textContent = "スキャン中...";';
  js += '  res.innerHTML = "";';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    btn.disabled = false; btn.textContent = "Drive フォルダをスキャン";';
  js += '    if (!r.success) { showMsg("error", r.error); return; }';
  js += '    if (r.count === 0) { res.innerHTML = "<span style=\\"color:#939DA7\\">未登録のHTMLファイルはありませんでした。</span>"; return; }';
  js += '    var names = r.imported.map(function(f) { return f.name; }).join(", ");';
  js += '    showMsg("success", r.count + "件を読み込みました: " + names);';
  js += '    setTimeout(function() { goTop(); }, 1500);';
  js += '  }).withFailureHandler(function(e) { btn.disabled = false; btn.textContent = "Drive フォルダをスキャン"; showMsg("error", e.message); }).scanAndImportDriveFiles();';
  js += '}';

  // [2026-03-11] プレビュー（プリフェッチ対応）
  js += 'function renderPreview(content) {';
  js += '  var iframe = document.createElement("iframe");';
  js += '  iframe.sandbox = "allow-same-origin";';
  js += '  document.getElementById("previewBody").innerHTML = "";';
  js += '  document.getElementById("previewBody").appendChild(iframe);';
  js += '  iframe.contentDocument.open(); iframe.contentDocument.write(content); iframe.contentDocument.close();';
  js += '}';
  js += 'function doPreview(name) {';
  js += '  document.getElementById("previewTitle").textContent = name + " - プレビュー";';
  js += '  document.getElementById("previewOverlay").style.display = "block";';
  js += '  if (previewCache[name]) { renderPreview(previewCache[name]); return; }';
  js += '  document.getElementById("previewBody").innerHTML = "<p>読み込み中...</p>";';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    if (r.success) { previewCache[name] = r.content; renderPreview(r.content); }';
  js += '    else { document.getElementById("previewBody").innerHTML = "<p>エラー: " + r.error + "</p>"; }';
  js += '  }).withFailureHandler(function(e) { document.getElementById("previewBody").innerHTML = "<p>エラー: " + e.message + "</p>"; }).getPageContent(name);';
  js += '}';
  js += 'function closePreview() { document.getElementById("previewOverlay").style.display = "none"; document.getElementById("previewBody").innerHTML = ""; var m = document.getElementById("previewModal"); m.classList.remove("maximized"); m.style.width = ""; m.style.height = ""; }';

  // [2026-03-11] 最大化トグル
  js += 'function toggleMaximize() {';
  js += '  var m = document.getElementById("previewModal");';
  js += '  var isMax = m.classList.toggle("maximized");';
  js += '  if (isMax) { m.style.width = ""; m.style.height = ""; }';
  js += '  document.getElementById("maximizeBtn").innerHTML = isMax ? "&#9645;" : "&#9634;";';
  js += '}';

  // 履歴
  js += 'function showHistory(name) {';
  js += '  document.getElementById("historyTitle").textContent = name + " - バージョン履歴";';
  js += '  document.getElementById("historyBody").innerHTML = "<p>読み込み中...</p>";';
  js += '  document.getElementById("historyOverlay").style.display = "block";';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    if (!r.success) { document.getElementById("historyBody").innerHTML = "<p>" + r.error + "</p>"; return; }';
  js += '    var h = "<table class=\\"history-table\\"><tr><th>Ver</th><th>日時</th><th>投稿者</th><th>サイズ</th><th>操作</th></tr>";';
  js += '    r.versions.forEach(function(v) {';
  js += '      var d = new Date(v.date);';
  js += '      var ds = d.getFullYear() + "/" + (d.getMonth()+1) + "/" + d.getDate() + " " + d.getHours() + ":" + ("0"+d.getMinutes()).slice(-2);';
  js += '      var sz = (v.size/1024).toFixed(1) + " KB";';
  js += '      var isCurrent = v.version === r.currentVersion;';
  js += '      h += "<tr><td>v" + v.version + (isCurrent ? " (現在)" : "") + "</td>";';
  js += '      h += "<td>" + ds + "</td><td>" + (v.author ? v.author.split("@")[0] : "") + "</td><td>" + sz + "</td>";';
  js += '      h += "<td>";';
  js += '      if (!isCurrent) {';
  js += '        h += "<button class=\\"btn-sm btn-preview\\" onclick=\\"restoreVer(\\x27" + name + "\\x27, " + v.version + ")\\">復元</button>";';
  js += '      }';
  js += '      h += "</td></tr>";';
  js += '    });';
  js += '    h += "</table>";';
  js += '    document.getElementById("historyBody").innerHTML = h;';
  js += '  }).withFailureHandler(function(e) { document.getElementById("historyBody").innerHTML = "<p>エラー: " + e.message + "</p>"; }).getVersionHistory(name);';
  js += '}';
  js += 'function closeHistory() { document.getElementById("historyOverlay").style.display = "none"; }';

  // バージョン復元
  js += 'function restoreVer(name, ver) {';
  js += '  if (!confirm("v" + ver + " を復元しますか？")) return;';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    if (r.success) { showMsg("success", name + " を v" + ver + " から復元しました"); closeHistory(); setTimeout(function() { goTop(); }, 1500); }';
  js += '    else { showMsg("error", r.error); }';
  js += '  }).withFailureHandler(function(e) { showMsg("error", e.message); }).restoreVersion(name, ver);';
  js += '}';

  // メモ編集
  js += 'function editMemo(name, currentMemo) {';
  js += '  document.getElementById("memoPageName").value = name;';
  js += '  document.getElementById("memoInput").value = currentMemo;';
  js += '  document.getElementById("memoOverlay").style.display = "block";';
  js += '  document.getElementById("memoInput").focus();';
  js += '}';
  js += 'function closeMemo() { document.getElementById("memoOverlay").style.display = "none"; }';
  js += 'function saveMemo() {';
  js += '  var name = document.getElementById("memoPageName").value;';
  js += '  var memo = document.getElementById("memoInput").value.trim();';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    if (r.success) {';
  js += '      var el = document.getElementById("memo-" + name);';
  js += '      if (el) el.textContent = memo;';
  js += '      closeMemo(); showMsg("success", "メモを更新しました");';
  js += '    } else { showMsg("error", r.error); }';
  js += '  }).withFailureHandler(function(e) { showMsg("error", e.message); }).updateMemo(name, memo);';
  js += '}';

  // メッセージ表示
  js += 'function showMsg(type, text) {';
  js += '  document.getElementById("successMsg").style.display = "none";';
  js += '  document.getElementById("errorMsg").style.display = "none";';
  js += '  var el = document.getElementById(type === "success" ? "successMsg" : "errorMsg");';
  js += '  el.textContent = text; el.style.display = "block";';
  js += '  setTimeout(function() { el.style.display = "none"; }, 5000);';
  js += '}';

  // [2026-03-11] キーワード検索フィルタ（ページ名・投稿者・メモ+本文）
  js += 'var searchTimer = null;';
  js += 'var contentMatches = {};';  // 本文検索の結果をキャッシュ

  // クライアント側フィルタ（即座）+ 本文検索（デバウンス）
  js += 'function filterTable() {';
  js += '  var q = document.getElementById("searchInput").value.toLowerCase();';
  js += '  applyFilter(q);';
  js += '  clearTimeout(searchTimer);';
  js += '  if (q.length >= 2) {';
  js += '    document.getElementById("searchStatus").textContent = "本文検索中...";';
  js += '    searchTimer = setTimeout(function() { doContentSearch(q); }, 500);';
  js += '  } else {';
  js += '    document.getElementById("searchStatus").textContent = "";';
  js += '    contentMatches = {};';
  js += '  }';
  js += '}';

  // テーブルフィルタ適用（名前・投稿者・メモ + contentMatches）
  js += 'function applyFilter(q) {';
  js += '  var table = document.getElementById("pageTable");';
  js += '  if (!table) return;';
  js += '  var rows = table.querySelectorAll("tr");';
  js += '  var visible = 0;';
  js += '  for (var i = 1; i < rows.length; i++) {';
  js += '    var cells = rows[i].querySelectorAll("td");';
  js += '    var name = cells[0] ? cells[0].textContent.toLowerCase() : "";';
  js += '    var author = cells[1] ? cells[1].textContent.toLowerCase() : "";';
  js += '    var memo = cells[2] ? cells[2].textContent.toLowerCase() : "";';
  js += '    var localMatch = name.indexOf(q) >= 0 || author.indexOf(q) >= 0 || memo.indexOf(q) >= 0;';
  js += '    var bodyMatch = contentMatches[cells[0] ? cells[0].textContent : ""] || false;';
  js += '    var match = !q || localMatch || bodyMatch;';
  js += '    rows[i].style.display = match ? "" : "none";';
  js += '    if (match) visible++;';
  js += '  }';
  js += '  var countEl = document.getElementById("pageCount");';
  js += '  if (countEl) countEl.textContent = "(" + visible + "件)";';
  js += '}';

  // サーバーサイド本文検索
  js += 'function doContentSearch(q) {';
  js += '  google.script.run.withSuccessHandler(function(r) {';
  js += '    document.getElementById("searchStatus").textContent = "";';
  js += '    if (!r.success) return;';
  js += '    contentMatches = {};';
  js += '    r.matches.forEach(function(name) { contentMatches[name] = true; });';
  js += '    var currentQ = document.getElementById("searchInput").value.toLowerCase();';
  js += '    applyFilter(currentQ);';
  js += '  }).withFailureHandler(function() {';
  js += '    document.getElementById("searchStatus").textContent = "";';
  js += '  }).searchContent(q);';
  js += '}';

  // ESCキーでモーダルを閉じる
  js += 'document.addEventListener("keydown", function(e) {';
  js += '  if (e.key === "Escape") { closePreview(); closeHistory(); closeMemo(); }';
  js += '});';

  // [2026-03-11] ファビコンをJSで動的にセット（GAS iframe対策）
  js += '(function(){';
  js += '  try {';
  js += '    var fi = "data:image/png;base64,' + FAVICON_B64_ + '";';
  js += '    var el = document.querySelector("link[rel*=icon]");';
  js += '    if (!el) { el = document.createElement("link"); el.rel = "icon"; document.head.appendChild(el); }';
  js += '    el.type = "image/png"; el.href = fi;';
  js += '  } catch(e) {}';
  js += '})();';

  return js;
}

// --- ユーティリティ ---
function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
