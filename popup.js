// 网页朗读助手 — 弹窗逻辑
// 弹窗只是遥控器：真正的朗读跑在内容脚本里，关掉弹窗也不会中断。

const $ = (id) => document.getElementById(id);
const els = {
  rate: $("rate"), pitch: $("pitch"), voice: $("voice"), engine: $("engine"),
  piperVoice: $("piperVoice"),
  rateVal: $("rateVal"), pitchVal: $("pitchVal"), status: $("status"),
  follow: $("follow"), ramp: $("ramp"),
};

let activeTabId = null;

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch {
      return false;
    }
  }
}

async function send(type) {
  if (!activeTabId) return null;
  if (!(await ensureContentScript(activeTabId))) {
    els.status.textContent = "这个页面不能朗读（浏览器内部页面）";
    return null;
  }
  const settings = currentSettings();
  try {
    return await chrome.tabs.sendMessage(activeTabId, { type, settings });
  } catch {
    return null;
  }
}

function currentSettings() {
  return {
    rate: parseFloat(els.rate.value),
    pitch: parseFloat(els.pitch.value),
    voiceName: els.voice.value || "",
    engine: els.engine.value || "piper",
    piperVoice: els.piperVoice.value || "huayan",
    follow: els.follow.checked,
    ramp: els.ramp.checked,
  };
}

async function saveSettings() {
  await chrome.storage.local.set({ readerSettings: currentSettings() });
  els.rateVal.textContent = parseFloat(els.rate.value).toFixed(2).replace(/0$/, "") + "×";
  els.pitchVal.textContent = parseFloat(els.pitch.value).toFixed(1);
}

function fillVoices(selectedName) {
  const voices = speechSynthesis.getVoices();
  els.voice.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "自动（按页面语言）";
  els.voice.appendChild(auto);
  // 中文音色排前面，其余随后
  const sorted = [...voices].sort((a, b) =>
    (b.lang.startsWith("zh") ? 1 : 0) - (a.lang.startsWith("zh") ? 1 : 0));
  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v.name;
    // localService=false 的是云端音色：文字会发给厂商服务器合成，标出来让用户自己选
    opt.textContent = `${v.name}（${v.lang}）· ${v.localService ? "本地" : "云端"}`;
    els.voice.appendChild(opt);
  }
  if (selectedName && voices.some((v) => v.name === selectedName)) {
    els.voice.value = selectedName;
  }
}

function renderStatus(resp) {
  if (!resp) return;
  if (resp.ok === false && resp.reason) { els.status.textContent = resp.reason; return; }
  if (typeof resp.total === "number") {
    if (resp.speaking) {
      const eta = typeof resp.remainSec === "number"
        ? `，剩约 ${Math.floor(resp.remainSec / 60)}:${String(resp.remainSec % 60).padStart(2, "0")}` : "";
      els.status.textContent = `朗读中：第 ${Math.min(resp.index + 1, resp.total)} / ${resp.total} 段${eta}`;
    } else {
      els.status.textContent = resp.total ? "朗读完毕" : "未开始";
    }
  }
}

let piperEventSeen = false; // 试听自愈重试用：有没有等到合成页的任何回音
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PIPER_EVENT") piperEventSeen = true;
  if (msg.type === "READER_STATUS") renderStatus({ ...msg.status, speaking: msg.status.speaking });
  if (msg.type === "PIPER_EVENT" && msg.event === "init") {
    if (msg.state === "loading") els.status.textContent = "离线音色加载中（首次约 10 秒）…";
    if (msg.state === "ready") els.status.textContent = "离线音色已就绪";
    if (msg.state === "error") els.status.textContent = msg.message || "离线音色初始化失败";
  }
  if (msg.type === "PIPER_EVENT" && msg.event === "error") {
    els.status.textContent = "合成失败：" + (msg.message || "未知错误");
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab && tab.id;

  const { readerSettings } = await chrome.storage.local.get("readerSettings");
  if (readerSettings) {
    els.rate.value = readerSettings.rate ?? 1;
    els.pitch.value = readerSettings.pitch ?? 1;
    els.engine.value = readerSettings.engine || "piper";
    els.piperVoice.value = readerSettings.piperVoice || "huayan";
    els.follow.checked = readerSettings.follow !== false;
    els.ramp.checked = !!readerSettings.ramp;
  }
  els.rateVal.textContent = parseFloat(els.rate.value).toFixed(2).replace(/0$/, "") + "×";
  els.pitchVal.textContent = parseFloat(els.pitch.value).toFixed(1);

  fillVoices(readerSettings && readerSettings.voiceName);
  speechSynthesis.onvoiceschanged = () => fillVoices(currentSettings().voiceName);

  if (activeTabId && (await ensureContentScript(activeTabId))) {
    const st = await chrome.tabs.sendMessage(activeTabId, { type: "GET_STATUS" }).catch(() => null);
    if (st) renderStatus(st);
  }
}

$("btnReadPage").addEventListener("click", async () => renderStatus(await send("READ_PAGE")));
$("btnReadSel").addEventListener("click", async () => renderStatus(await send("READ_SELECTION")));
$("btnStop").addEventListener("click", async () => { await send("STOP"); els.status.textContent = "已停止"; });
$("btnPause").addEventListener("click", () => send("PAUSE"));
$("btnResume").addEventListener("click", () => send("RESUME"));
$("btnPreview").addEventListener("click", async () => {
  const s = currentSettings();
  if (s.engine === "piper") {
    els.status.textContent = "离线音色试听合成中（首次要先加载模型，约 10 秒）…";
    const ensured = await chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" }).catch(() => null);
    if (!ensured || !ensured.ok) {
      els.status.textContent = "无法启动离线合成页" + (ensured && ensured.reason ? "：" + ensured.reason : "（后台无响应）");
      return;
    }
    const previews = {
      huayan: "你好，我是华燕。网页上的文字，我读给你听。",
      chaowen: "你好，我是超文。网页上的文字，现在可以用男声读给你听了。",
      xiaoya: "你好，我是小雅。让我用温柔的声音，陪你慢慢读完这一页。",
    };
    const sendPreview = () => chrome.runtime.sendMessage({
      type: "PIPER_PREVIEW", rate: s.rate, voice: s.piperVoice,
      text: previews[s.piperVoice] || previews.huayan,
    }).catch(() => {});
    piperEventSeen = false;
    await sendPreview();
    // 自愈：20 秒没等到合成页任何回音（多半是页面被 Chrome 回收/僵死），自动重启合成页重试一次
    setTimeout(async () => {
      if (piperEventSeen) return;
      els.status.textContent = "合成页无响应，正在自动重启重试…";
      const re = await chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" }).catch(() => null);
      if (re && re.ok) { piperEventSeen = false; await sendPreview(); }
    }, 20000);
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance("你好，这是当前的音色和语速，网页上的文字会这样读给你听。");
  u.rate = s.rate; u.pitch = s.pitch;
  const v = speechSynthesis.getVoices().find((x) => x.name === s.voiceName);
  if (v) { u.voice = v; u.lang = v.lang; }
  speechSynthesis.speak(u);
});
// 情感语录模式：没有情感引擎，就用“小雅温柔女声 + 0.85× 慢速”这组预设营造氛围
$("btnEmotion").addEventListener("click", async () => {
  els.engine.value = "piper";
  els.piperVoice.value = "xiaoya";
  els.rate.value = 0.85;
  await saveSettings();
  els.status.textContent = "已切到情感语录模式：小雅 · 温柔女声 · 0.85× 慢速，重新开始朗读后生效";
});

for (const el of [els.rate, els.pitch, els.voice, els.engine, els.piperVoice, els.follow, els.ramp]) el.addEventListener("change", saveSettings);
for (const el of [els.rate, els.pitch]) el.addEventListener("input", saveSettings);

init();
