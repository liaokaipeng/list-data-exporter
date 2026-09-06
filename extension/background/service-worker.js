/**
 * 点击扩展图标 → 按需注入内容脚本（避免在所有页面常驻加载 SheetJS）
 * 注入顺序即依赖顺序：xlsx.full.min.js（全局 XLSX）→ entry（守卫+命名空间）
 * → util → detect → field（字段提取）→ format → main（主 UI）
 */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [
        'lib/xlsx.full.min.js',
        'content/entry.js',
        'content/util.js',
        'content/detect.js',
        'content/field.js',
        'content/format.js',
        'content/main.js'
      ]
    });
  } catch (e) {
    // chrome:// 等受限页面无法注入，静默失败
  }
});

/**
 * 接收内容脚本生成的导出数据（base64），经 chrome.downloads API 下载。
 * 不在内容脚本里用 blob: 链接下载的原因：页面 CSP 可能拦截，
 * 而 downloads API 属于扩展权限，不受页面策略限制。
 */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'lde-download') return;
  chrome.downloads.download(
    {
      url: 'data:' + (msg.mime || XLSX_MIME) + ';base64,' + msg.data,
      filename: msg.filename,
      saveAs: false
    },
    (downloadId) => {
      const err = chrome.runtime.lastError;
      sendResponse({ ok: !err && downloadId !== undefined, error: err ? err.message : null });
    }
  );
  return true; // 异步调用 sendResponse，需保持消息通道
});
