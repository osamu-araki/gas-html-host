// Version: 3.1.0 | Updated: 2026-03-13
// [2026-03-13] v3.1.0: メタデータCacheService対応（Drive読み込み削減、保存時キャッシュ更新）
// [2026-03-13] v3.0.0: UI部分をHTMLテンプレート(index.html)に分離
// [2026-03-13] v2.8.0: ファイル単位の外部公開機能（public フラグ + ドメインチェック）
// [2026-03-13] v2.7.5: 復元時にメモを上書きしない、復元情報を履歴の備考欄に記録
// [2026-03-13] v2.7.3: ナビラッパーを別GASに分離、?page=xxxは常に生HTML配信に戻す
// [2026-03-12] v2.7.2: メモ欄にtitle属性追加（マウスオーバーで全文表示）
// [2026-03-12] v2.7.1: updatePageMetadata_ を upsert 化（ページ未登録時は自動作成）
// [2026-03-12] v2.7.0: doPost に update-metadata アクション追加（スキルからメモ・投稿者自動登録）
// HTML社内公開ホスティング基盤
// GAS Web App として動作し、Google Drive 上のHTMLファイルを配信する
// [2026-03-11] v2.0.0: 履歴管理・投稿者・メモ・Driveインポート・ページネーション・プレビュー追加
// [2026-03-11] v2.1.0: 高速化(メタデータベース一覧+キャッシュ)・Driveフォルダ読み込みボタン・ファビコン
// [2026-03-11] v2.2.0: 白画面修正・スキル化ガイド・プレビューキャッシュ
// [2026-03-11] v2.3.0: プレビューモーダルの最大化ボタン・リサイズ対応

const FOLDER_ID = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
const ITEMS_PER_PAGE = 100;
// [2026-03-13] 組織ドメイン（外部公開チェック用）
const DOMAIN = 'salesnow.jp';
// [2026-03-13] ナビラッパー GAS の Web App URL
const NAV_BASE_URL = 'https://script.google.com/a/macros/salesnow.jp/s/AKfycbw7n-hjRZvTfR0zKsKUJ_jTM5b-ZqluneGj5YyTABxEgYD3HoJgIPLIah4hrDPo3buN6g/exec';
// [2026-03-11] ファビコン base64（16x16 PNG、ティール背景に白い </> マーク）
var FAVICON_B64_ = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZElEQVR4nGNggAKt2Qv/k4IZkAGpmlEMIVcz3BBiFE05e4F0A0AAG5soA5A1wGzHZQiGAegKkZ2PzRAGfJqx+R9dDV4DsAUeXgNw+Z9oL6ArJOR/2kUjocRDlAHEYsozE6XZGQCLeGgrqauFjAAAAABJRU5ErkJggg==';

// ============================================================
// Web App エントリポイント
// ============================================================

function doGet(e) {
  const pageName = e.parameter.page;
  const version = e.parameter.v;

  // [2026-03-13] 一覧ページはドメインユーザーのみ
  if (!pageName) {
    if (!isDomainUser_()) {
      return createAccessDeniedPage_();
    }
    const pageNum = parseInt(e.parameter.p) || 1;
    return createIndexPage_(pageNum);
  }

  // [2026-03-13] 非公開ページはドメインユーザーのみ
  if (!isDomainUser_() && !isPublicPage_(pageName)) {
    return createAccessDeniedPage_();
  }

  // [2026-03-11] バージョン指定対応
  if (version) {
    return serveVersionPage_(pageName, parseInt(version));
  }

  // [2026-03-13] 常に生HTML配信（ナビラッパーは別GAS）
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
// [2026-03-13] CacheService対応（Drive読み込み削減）
var METADATA_CACHE_KEY_ = 'metadata_json';
var METADATA_CACHE_TTL_ = 600; // 10分

function getMetadata_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(METADATA_CACHE_KEY_);
  if (cached) {
    try { return JSON.parse(cached); }
    catch (e) { /* キャッシュ破損時はDriveから再取得 */ }
  }

  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFilesByName('_metadata.json');

  var metadata = { pages: {} };
  if (files.hasNext()) {
    try { metadata = JSON.parse(files.next().getBlob().getDataAsString()); }
    catch (e) { /* パース失敗時はデフォルト値 */ }
  }

  // CacheServiceの上限は100KB。超過時はキャッシュしない
  var json = JSON.stringify(metadata);
  if (json.length <= 100000) {
    cache.put(METADATA_CACHE_KEY_, json, METADATA_CACHE_TTL_);
  }
  return metadata;
}

// [2026-03-13] 保存時にキャッシュも更新
function saveMetadata_(metadata) {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFilesByName('_metadata.json');
  var json = JSON.stringify(metadata, null, 2);

  if (files.hasNext()) {
    files.next().setContent(json);
  } else {
    folder.createFile('_metadata.json', json, MimeType.PLAIN_TEXT);
  }

  // 保存直後のキャッシュ更新（次回getMetadata_()でDrive読み込み不要に）
  var compact = JSON.stringify(metadata);
  if (compact.length <= 100000) {
    CacheService.getScriptCache().put(METADATA_CACHE_KEY_, compact, METADATA_CACHE_TTL_);
  } else {
    CacheService.getScriptCache().remove(METADATA_CACHE_KEY_);
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
      versionCount: versions.length,
      public: meta.public === true
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
  var cache = CacheService.getScriptCache();
  cache.removeAll(['pageList', METADATA_CACHE_KEY_]);
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
  // [2026-03-13] 各バージョンのバックアップファイル存在チェック
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var versions = pageMeta.versions.slice().reverse().map(function(v) {
    var hasFile = true;
    if (v.version !== pageMeta.currentVersion) {
      var vFiles = folder.getFilesByName(name + '_v' + v.version + '.html');
      hasFile = vFiles.hasNext();
    }
    return {
      version: v.version,
      date: v.date,
      author: v.author,
      size: v.size,
      hasFile: hasFile,
      note: v.note || ''
    };
  });
  return {
    success: true,
    name: name,
    currentVersion: pageMeta.currentVersion,
    versions: versions
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
 * [2026-03-13] バージョン指定のコンテンツ取得（プレビュー用）
 */
function getVersionContent(name, version) {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var fileName = name + '_v' + version + '.html';
  var files = folder.getFilesByName(fileName);
  if (!files.hasNext()) {
    return { success: false, error: 'v' + version + ' のファイルが見つかりません' };
  }
  return { success: true, content: files.next().getBlob().getDataAsString() };
}

/**
 * [2026-03-11] 最新10件のコンテンツをCacheServiceにプリフェッチ
 * インデックスページ生成時に裏で読み込んでおく
 */
function prefetchContentToCache_(pages) {
  // [2026-03-13] 引数なし（クライアント側から非同期呼び出し）の場合、ページ一覧を自動取得
  if (!pages) {
    pages = listPages().pages;
  }
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
 * [2026-03-13] ページの公開/非公開を切り替え
 */
function togglePublic(name) {
  const metadata = getMetadata_();
  if (!metadata.pages[name]) {
    return { success: false, error: 'ページが見つかりません' };
  }
  var isPublic = !metadata.pages[name].public;
  metadata.pages[name].public = isPublic;
  saveMetadata_(metadata);
  invalidateCache_();
  var baseUrl = ScriptApp.getService().getUrl();
  return {
    success: true,
    name: name,
    public: isPublic,
    url: isPublic ? baseUrl + '?page=' + encodeURIComponent(name) : null
  };
}

/**
 * [2026-03-12] ページのメタデータ（メモ・投稿者）を更新（upsert）
 * ページが未登録の場合は自動作成する（スキルからのDrive API直接アップロード対応）
 */
function updatePageMetadata_(name, memo, author) {
  const metadata = getMetadata_();
  // [2026-03-12] upsert: ページ未登録なら自動作成
  if (!metadata.pages[name]) {
    var now = new Date().toISOString();
    metadata.pages[name] = {
      author: author || '',
      memo: memo || '',
      currentVersion: 1,
      versions: [{
        version: 1,
        date: now,
        author: author || '',
        size: 0
      }]
    };
    // Driveからファイルサイズを取得
    try {
      var folder = DriveApp.getFolderById(FOLDER_ID);
      var files = folder.getFilesByName(name + '.html');
      if (files.hasNext()) {
        metadata.pages[name].versions[0].size = files.next().getSize();
      }
    } catch (e) { /* サイズ不明でも続行 */ }
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

  // [2026-03-13] メモを上書きしない（空文字で渡す）、復元情報は履歴に記録
  var content = files.next().getBlob().getDataAsString();
  var result = uploadHtml(name, content, '');

  // 履歴のバージョンエントリに復元元情報を追記
  if (result.success) {
    var metadata = getMetadata_();
    var pageMeta = metadata.pages[name];
    if (pageMeta && pageMeta.versions.length > 0) {
      pageMeta.versions[pageMeta.versions.length - 1].note = 'v' + version + ' から復元';
      saveMetadata_(metadata);
    }
  }

  return result;
}

/**
 * 初回セットアップ
 */
function setup(folderId) {
  PropertiesService.getScriptProperties().setProperty('FOLDER_ID', folderId);
  return { success: true, folderId: folderId };
}

// [2026-03-13] ページ内容を取得（ナビラッパーからのページ切替用・文字列を直接返す）
function getRawPageContent(pageName) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'content_' + pageName;
  var cached = cache.get(cacheKey);
  if (cached) return cached;

  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByName(pageName + '.html');
  if (!files.hasNext()) return null;
  var content = files.next().getBlob().getDataAsString();
  if (content.length < 100000) {
    cache.put(cacheKey, content, 300);
  }
  return content;
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
// インデックスページ生成（テンプレートベース）
// ============================================================

function createIndexPage_(pageNum) {
  var result = listPages();
  var baseUrl = ScriptApp.getService().getUrl();
  var allPages = result.pages;

  var totalPages = Math.ceil(allPages.length / ITEMS_PER_PAGE) || 1;
  if (pageNum > totalPages) pageNum = totalPages;

  var startIdx = (pageNum - 1) * ITEMS_PER_PAGE;
  var endIdx = Math.min(startIdx + ITEMS_PER_PAGE, allPages.length);
  var displayPages = allPages.slice(startIdx, endIdx);

  var template = HtmlService.createTemplateFromFile('index');
  template.faviconB64 = FAVICON_B64_;
  template.navBaseUrl = NAV_BASE_URL;
  template.baseUrl = baseUrl;
  template.allPages = allPages;
  template.displayPages = displayPages;
  template.totalCount = allPages.length;
  template.pageNum = pageNum;
  template.totalPages = totalPages;
  template.folderUrl = 'https://drive.google.com/drive/folders/' + FOLDER_ID;

  return template.evaluate().setTitle('HTML Host');
}

// --- アクセス制御 ---

// [2026-03-13] ドメインユーザー判定
function isDomainUser_() {
  try {
    var email = Session.getActiveUser().getEmail();
    return email && email.endsWith('@' + DOMAIN);
  } catch (e) {
    return false;
  }
}

// [2026-03-13] ページの公開状態チェック
function isPublicPage_(pageName) {
  var metadata = getMetadata_();
  var pageMeta = metadata.pages[pageName];
  return pageMeta && pageMeta.public === true;
}

// [2026-03-13] アクセス拒否ページ
function createAccessDeniedPage_() {
  var html = '<!DOCTYPE html><html><head><meta charset="utf-8">';
  html += '<title>アクセス制限</title>';
  html += '<style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:80vh;color:#283C50;}';
  html += '.box{text-align:center;padding:40px;border:1px solid #e0e0e0;border-radius:8px;max-width:400px;}';
  html += 'h1{color:#e53935;font-size:20px;} p{color:#666;}</style></head><body>';
  html += '<div class="box"><h1>アクセス制限</h1>';
  html += '<p>このページは組織内ユーザーのみ閲覧できます。</p>';
  html += '<p style="font-size:13px;color:#999">salesnow.jp アカウントでログインしてください。</p>';
  html += '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('アクセス制限');
}

// --- ユーティリティ ---
function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
