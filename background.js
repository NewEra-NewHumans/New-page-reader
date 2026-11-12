// 网页朗读助手 — 后台（Service Worker）
// 职责：建右键菜单、响应快捷键、把指令转达给当前页面的内容脚本；
// v3 起还管理 offscreen 页面（内置 Piper 离线音色在那里本地合成+播放，全程不联网）。
// 权限最小化：靠 activeTab + scripting 按需注入，不申请全站常驻权限。

// ---------------- offscreen（离线语音）管理 ----------------
let creatingOffscreen = null;
let piperOwnerTabId = null;

async function ensureOffscreen() {
  if (!creatingOffscreen) {
    creatingOffscreen = (async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (contexts.length) {
        // Chrome 会在音频停止约 30 秒后回收 offscreen 文档，且上下文列表可能滞后，
        // “存在”不等于“活着”——先 ping 验证，僵死就关掉重建（真实 Chrome 实测结论）。
        const alive = await chrome.runtime.sendMessage({ type: "PIPER_PING" })
          .then((r) => !!(r && r.ok)).catch(() => false);
        if (alive) return;
        try { await chrome.offscreen.closeDocument(); } catch { /* 已被回收 */ }
      }
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "在本地合成并播放内置的 Piper 离线语音，不联网、不上传文字",
      });
    })().finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "ENSURE_OFFSCREEN") return;
  if (sender.tab && sender.tab.id) piperOwnerTabId = sender.tab.id;
  ensureOffscreen()
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
  return true;
});

// 朗读所在的标签页关掉时，停掉 offscreen 里的播放，别让声音无主地继续响
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === piperOwnerTabId) {
    piperOwnerTabId = null;
    chrome.runtime.sendMessage({ type: "PIPER_STOP" }).catch(() => {});
  }
});

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch {
      return false; // chrome:// 等特殊页面无法注入，静默放弃
    }
  }
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  if (await ensureContentScript(tab.id)) {
    const { readerSettings } = await chrome.storage.local.get("readerSettings");
    chrome.tabs.sendMessage(tab.id, { ...message, settings: readerSettings || {} }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "read-selection",
    title: "朗读选中文字",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "read-page",
    title: "朗读全文",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "stop-reading",
    title: "停止朗读",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  const map = {
    "read-selection": "READ_SELECTION",
    "read-page": "READ_PAGE",
    "stop-reading": "STOP",
  };
  const type = map[info.menuItemId];
  if (!type) return;
  (async () => {
    if (await ensureContentScript(tab.id)) {
      const { readerSettings } = await chrome.storage.local.get("readerSettings");
      chrome.tabs.sendMessage(tab.id, { type, settings: readerSettings || {} }).catch(() => {});
    }
  })();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "read-page-or-selection") sendToActiveTab({ type: "READ_SELECTION_OR_PAGE" });
  if (command === "stop-reading") sendToActiveTab({ type: "STOP" });
});
