// Version: 2.0.0 | Updated: 2026-03-13
// HTML Host ナビゲーションラッパー
// 既存 HTML Host GAS の ?page=xxx を iframe で表示し、ナビバー・ドロワーを追加する

// 既存 HTML Host の Web App URL
var HOST_BASE_URL = 'https://script.google.com/a/macros/salesnow.jp/s/AKfycbz0ultsptEvUlUMNA1Z6bhLUcfMAkk7xfkk-46LNcUA5WPN25xluwFX0yI0ZPqFHT_wKg/exec';
var FOLDER_ID = '1vAwKrWHq-jpaNYBXci4NuI1FguSrPr0_';

function doGet(e) {
  try {
    var pageName = e.parameter.page;
    if (!pageName) {
      return HtmlService.createHtmlOutput(
        '<script>window.top.location.href="' + HOST_BASE_URL + '";</script>'
      );
    }
    return serveNavWrapper_(pageName);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<h1>エラー</h1><pre>' + err.message + '\n' + err.stack + '</pre>'
    );
  }
}

// ページ一覧取得（Drive の _metadata.json から）
function getPageList_() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByName('_metadata.json');
  if (!files.hasNext()) return [];

  var meta = JSON.parse(files.next().getBlob().getDataAsString());
  var pages = meta.pages || {};
  var result = [];
  for (var name in pages) {
    var p = pages[name];
    result.push({
      name: name,
      author: p.author ? p.author.split('@')[0] : '',
      memo: p.memo || '',
      date: p.versions && p.versions.length > 0
        ? p.versions[p.versions.length - 1].date.substring(0, 10)
        : ''
    });
  }
  // 日付降順ソート
  result.sort(function(a, b) { return b.date.localeCompare(a.date); });
  return result;
}

// [2026-03-13] テンプレート方式に変更（HTML文字列連結を廃止）
function serveNavWrapper_(pageName) {
  var allPages = getPageList_();
  var currentIndex = 0;
  var currentMemo = '';
  for (var i = 0; i < allPages.length; i++) {
    if (allPages[i].name === pageName) {
      currentIndex = i;
      currentMemo = allPages[i].memo || '';
      break;
    }
  }

  var template = HtmlService.createTemplateFromFile('wrapper');
  template.pageName = pageName;
  template.iframeSrc = HOST_BASE_URL + '?page=' + encodeURIComponent(pageName);
  template.hostBaseUrl = HOST_BASE_URL;
  template.currentMemo = currentMemo;
  template.pagesJson = JSON.stringify(allPages);
  template.currentIndex = currentIndex;

  return template.evaluate()
    .setTitle(pageName + ' - HTML Host')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
