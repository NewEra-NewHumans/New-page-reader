// 网页朗读助手 v3 — 内容脚本（参考 Speechify 的核心体验设计）
// 页面内悬浮播放器 / 段落高亮跟随滚动 / 悬停段落点播 / 选区气泡朗读
// 双引擎：① 内置 Piper 中文离线音色（默认）——模型打包在插件里，offscreen 页本地
// 合成播放，插件代码零联网、文字不离开本机；② 系统音色（浏览器内置语音）。
(function () {
  if (window.__pageReaderLoaded) return;
  window.__pageReaderLoaded = true;

  const synth = window.speechSynthesis;
  const $sel = "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, figcaption";
  const NOISE = "nav, header, footer, aside, script, style, noscript";

  let settings = { rate: 1, pitch: 1, voiceName: "", follow: true, ramp: false, engine: "piper", piperVoice: "huayan" };
  let piperToken = 0;        // 当前 Piper 播放令牌：停止/跳转时递增，让旧事件失效
  let piperPaused = false;
  let piperReady = false;
  let transientStatus = "";  // 播放器第三行临时状态（如“离线音色加载中…/失败原因”）
  let segments = [];       // [{text, el}] 朗读队列（已按 <=180 字分段）
  let index = 0;           // 当前段
  let playing = false;
  let session = 0;         // 播放会话号：跳转/停止时递增，让旧回调失效
  let curRate = 1;         // 实际语速（渐进加速会在此基础上爬升）
  let chunksSinceStart = 0;
  let highlightedEl = null;
  let savedStyle = null;
  let fullTextCpm = 800;   // 估算字速（字/分钟 @1x），按中英文比例混合

  // ---------------- 文本提取 ----------------
  function collectParagraphs() {
    const root =
      document.querySelector("article") || document.querySelector("main") || document.body;
    if (!root || !root.querySelectorAll) return [];
    const out = [];
    root.querySelectorAll($sel).forEach((el) => {
      if (el.closest && el.closest(NOISE)) return;
      if (el.closest && el.closest("#page-reader-player, #page-reader-bubble, #page-reader-hover")) return;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length >= 2) out.push({ el, text });
    });
    return out;
  }

  function extractMainText() {
    const paras = collectParagraphs();
    if (paras.length) return paras.map((p) => p.text).join(" ");
    const clone = (document.body || {}).cloneNode ? document.body.cloneNode(true) : null;
    if (!clone) return "";
    clone.querySelectorAll("script, style, nav, header, footer, aside, noscript")
      .forEach((el) => el.remove());
    return (clone.innerText || "").replace(/\s+/g, " ").trim();
  }

  function splitText(text) {
    const sentences = text.split(/(?<=[。！？；.!?;])\s*/).map((s) => s.trim()).filter(Boolean);
    const chunks = [];
    let buf = "";
    for (const s of sentences) {
      if (s.length > 180) {
        if (buf) { chunks.push(buf); buf = ""; }
        let rest = s;
        while (rest.length > 180) {
          let cut = Math.max(rest.lastIndexOf("，", 180), rest.lastIndexOf(",", 180));
          if (cut < 60) cut = 180;
          chunks.push(rest.slice(0, cut === 180 ? 180 : cut + 1).trim());
          rest = rest.slice(cut === 180 ? 180 : cut + 1).trim();
        }
        if (rest) buf = rest;
      } else if ((buf + s).length <= 180) buf += s;
      else { chunks.push(buf); buf = s; }
    }
    if (buf) chunks.push(buf);
    return chunks.filter(Boolean);
  }

  function buildSegmentsFromParagraphs(paras, startAt) {
    const segs = [];
    paras.forEach((p, pi) => {
      if (pi < (startAt || 0)) return;
      for (const c of splitText(p.text)) segs.push({ text: c, el: p.el });
    });
    return segs;
  }

  function estimateCpm(text) {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const ratio = text.length ? cjk / text.length : 0;
    return Math.round(ratio * 240 + (1 - ratio) * 800);
  }

  function remainingSeconds() {
    let chars = 0;
    for (let i = index; i < segments.length; i++) chars += segments[i].text.length;
    return chars / (fullTextCpm * Math.max(curRate, 0.1)) * 60;
  }

  // ---------------- 高亮跟随 ----------------
  function setHighlight(el) {
    if (highlightedEl === el) return;
    clearHighlight();
    if (!el || !el.style) return;
    savedStyle = { background: el.style.backgroundColor || "", shadow: el.style.boxShadow || "", transition: el.style.transition || "" };
    el.style.transition = "background-color .3s";
    el.style.backgroundColor = "rgba(26,115,232,0.16)";
    el.style.boxShadow = "0 0 0 2px rgba(26,115,232,0.25)";
    highlightedEl = el;
    if (settings.follow && el.scrollIntoView) {
      try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* 老浏览器参数不兼容时忽略 */ }
    }
  }
  function clearHighlight() {
    if (highlightedEl && savedStyle) {
      highlightedEl.style.backgroundColor = savedStyle.background;
      highlightedEl.style.boxShadow = savedStyle.shadow;
    }
    highlightedEl = null; savedStyle = null;
  }

  // ---------------- 播放核心 ----------------
  function isPausedNow() { return settings.engine === "piper" ? piperPaused : synth.paused; }
  function statusObj() {
    return {
      speaking: playing, paused: isPausedNow(), index,
      total: segments.length, rate: curRate, engine: settings.engine,
      remainSec: Math.round(remainingSeconds()),
    };
  }
  function broadcast() {
    updatePlayer();
    chrome.runtime.sendMessage({ type: "READER_STATUS", status: statusObj() }).catch(() => {});
  }

  // Piper 引擎：让 offscreen 页合成当前段并播放（它会顺带预合成下一段）
  let piperWatchdog = null;
  let piperRetries = 0; // 看门狗触发时的自动重启次数（Chrome 会回收闲置的合成页）
  async function piperPlay() {
    const seg = segments[index];
    setHighlight(seg.el);
    piperPaused = false;
    transientStatus = piperReady ? "" : "离线音色加载中（首次约十几秒）…";
    broadcast();
    const token = ++piperToken;
    let ensured = null;
    try { ensured = await chrome.runtime.sendMessage({ type: "ENSURE_OFFSCREEN" }); } catch { ensured = null; }
    if (token !== piperToken || !playing) return;
    if (!ensured || !ensured.ok) {
      // 启动合成页失败必须显形，不能无声无息地“不读”
      playing = false; clearHighlight();
      transientStatus = "无法启动离线合成页" + (ensured && ensured.reason ? "：" + ensured.reason : "（后台无响应）");
      updatePlayer(); broadcast();
      return;
    }
    const sent = await chrome.runtime.sendMessage({
      type: "PIPER_PLAY", token, index, voice: settings.piperVoice || "huayan",
      text: seg.text,
      nextText: segments[index + 1] ? segments[index + 1].text : "",
      rate: curRate,
    }).catch(() => null);
    if (!sent) {
      if (token === piperToken && playing) {
        playing = false; clearHighlight();
        transientStatus = "离线合成页无响应，请刷新插件后重试";
        updatePlayer(); broadcast();
      }
      return;
    }
    // 看门狗：25 秒没等到任何回音，多半是合成页被 Chrome 回收了——自动重启一次再试
    clearTimeout(piperWatchdog);
    piperWatchdog = setTimeout(() => {
      if (!playing || token !== piperToken) return;
      if (piperRetries < 1) {
        piperRetries++;
        transientStatus = "合成页无响应，正在自动重启…";
        updatePlayer();
        piperPlay();
      } else {
        transientStatus = "合成仍无响应：请把播放器这一行截图发我";
        updatePlayer();
      }
    }, 25000);
  }

  function speakCurrent() {
    if (index >= segments.length) { finishPlayback(); return; }
    if (settings.engine === "piper") { piperPlay(); return; }
    const sid = session;
    const seg = segments[index];
    setHighlight(seg.el);
    const u = new SpeechSynthesisUtterance(seg.text);
    u.rate = curRate; u.pitch = settings.pitch;
    if (settings.voiceName) {
      const v = synth.getVoices().find((x) => x.name === settings.voiceName);
      if (v) { u.voice = v; u.lang = v.lang; }
    }
    u.onend = () => { if (sid === session) { advance(); } };
    u.onerror = (e) => {
      if (sid !== session) return;
      if (e.error === "interrupted" || e.error === "canceled") return;
      advance();
    };
    synth.speak(u);
    broadcast();
  }

  function advance() {
    index += 1; chunksSinceStart += 1;
    if (settings.ramp && chunksSinceStart % 10 === 0 && curRate < 3) {
      curRate = Math.min(3, Math.round((curRate + 0.05) * 100) / 100); // 渐进加速
    }
    if (index >= segments.length) finishPlayback(); else speakCurrent();
  }

  function finishPlayback() {
    playing = false; clearHighlight(); hidePlayerSoon(); broadcast();
  }

  function begin(segs, fullText) {
    piperRetries = 0;
    stopInternal();
    segments = segs; index = 0; chunksSinceStart = 0;
    curRate = settings.rate;
    fullTextCpm = estimateCpm(fullText || segs.map((s) => s.text).join(""));
    if (!segments.length) return { ok: false, reason: "没有可朗读的文字" };
    playing = true; session += 1;
    synth.getVoices();
    showPlayer();
    speakCurrent();
    return { ok: true, total: segments.length, remainSec: Math.round(remainingSeconds()) };
  }

  function stopInternal() {
    session += 1; playing = false;
    if (synth.speaking || synth.pending) synth.cancel();
    piperToken += 1; piperPaused = false;
    chrome.runtime.sendMessage({ type: "PIPER_STOP", token: piperToken }).catch(() => {});
    clearHighlight();
  }

  function stopAll() { stopInternal(); segments = []; index = 0; hidePlayer(); broadcast(); }

  function jumpTo(i) {
    if (!segments.length) return;
    index = Math.max(0, Math.min(i, segments.length - 1));
    session += 1;
    if (settings.engine === "piper") {
      playing = true; showPlayer();
      speakCurrent(); // piperPlay 会换新令牌，offscreen 收到新段自动停掉旧段
      return;
    }
    if (synth.speaking || synth.pending) synth.cancel();
    playing = true; showPlayer();
    // cancel 可能异步触发旧 onend，已被 session 号挡住；稍延后开读避免个别浏览器吞字
    const sid = session;
    setTimeout(() => { if (sid === session && playing) speakCurrent(); }, 60);
  }

  function changeRate(delta) {
    curRate = Math.round(Math.max(0.5, Math.min(3, curRate + delta)) * 100) / 100;
    settings.rate = curRate;
    if (settings.engine === "piper") {
      // Piper 的音频已合成好，直接调播放速度即可，不用重读当前段
      chrome.runtime.sendMessage({ type: "PIPER_SET_RATE", rate: curRate }).catch(() => {});
      broadcast();
      return;
    }
    if (playing && segments.length) jumpTo(index); else broadcast();
  }

  // ---------------- 页面内悬浮播放器 ----------------
  let player = null;
  function ensurePlayer() {
    if (player) return player;
    player = document.createElement("div");
    player.id = "page-reader-player";
    player.setAttribute("style",
      "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;" +
      "background:#12212f;color:#fff;border-radius:14px;padding:10px 14px;width:340px;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.35);font:13px/1.5 system-ui,sans-serif;display:none");
    player.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<button data-act="prev" title="上一段" style="' + btnCss() + '">⏮</button>' +
      '<button data-act="toggle" style="' + btnCss(true) + '">⏸</button>' +
      '<button data-act="next" title="下一段" style="' + btnCss() + '">⏭</button>' +
      '<button data-act="slower" style="' + btnCss() + '">−</button>' +
      '<span data-role="rate" style="min-width:44px;text-align:center;font-weight:600">1.0×</span>' +
      '<button data-act="faster" style="' + btnCss() + '">＋</button>' +
      '<span data-role="eta" style="margin-left:auto;color:#9db8d2;font-size:12px"></span>' +
      '<button data-act="close" title="停止并关闭" style="' + btnCss() + '">✕</button></div>' +
      '<div style="height:4px;background:#2b4359;border-radius:2px;margin-top:8px;overflow:hidden">' +
      '<div data-role="bar" style="height:100%;width:0%;background:#4da3ff;transition:width .3s"></div></div>' +
      '<div data-role="prog" style="color:#9db8d2;font-size:11px;margin-top:5px"></div>';
    player.addEventListener("click", (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
      if (!b) return;
      const act = b.getAttribute("data-act");
      if (act === "toggle") {
        if (settings.engine === "piper") {
          if (piperPaused) { chrome.runtime.sendMessage({ type: "PIPER_RESUME" }).catch(() => {}); piperPaused = false; }
          else if (playing) { chrome.runtime.sendMessage({ type: "PIPER_PAUSE" }).catch(() => {}); piperPaused = true; }
          broadcast();
        } else { if (synth.paused) synth.resume(); else if (playing) synth.pause(); broadcast(); }
      }
      if (act === "prev") jumpTo(index - 1);
      if (act === "next") jumpTo(index + 1);
      if (act === "slower") changeRate(-0.25);
      if (act === "faster") changeRate(0.25);
      if (act === "close") stopAll();
    });
    document.body.appendChild(player);
    return player;
  }
  function btnCss(big) {
    return "background:" + (big ? "#1a73e8" : "#22384e") + ";color:#fff;border:0;border-radius:8px;" +
      "width:" + (big ? "40px" : "32px") + ";height:32px;cursor:pointer;font-size:14px";
  }
  function q(role) { return player ? player.querySelector('[data-role="' + role + '"]') : null; }
  function updatePlayer() {
    if (!player) return;
    const rate = q("rate"); if (rate) rate.textContent = curRate.toFixed(2).replace(/0$/, "") + "×";
    const eta = q("eta");
    if (eta) {
      const s = Math.round(remainingSeconds());
      eta.textContent = segments.length ? "剩约 " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : "";
    }
    const bar = q("bar"); if (bar) bar.style.width = (segments.length ? (index / segments.length) * 100 : 0) + "%";
    const prog = q("prog"); if (prog) prog.textContent = transientStatus || (segments.length ? `第 ${Math.min(index + 1, segments.length)} / ${segments.length} 段` : "");
    const toggle = player.querySelector('[data-act="toggle"]');
    if (toggle) toggle.textContent = isPausedNow() ? "▶" : "⏸";
  }
  function showPlayer() { ensurePlayer(); player.style.display = "block"; updatePlayer(); }
  function hidePlayer() { if (player) player.style.display = "none"; }
  let hideTimer = null;
  function hidePlayerSoon() { clearTimeout(hideTimer); hideTimer = setTimeout(hidePlayer, 2500); }

  // ---------------- 选区气泡 ----------------
  let bubble = null;
  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement("button");
    bubble.id = "page-reader-bubble";
    bubble.textContent = "▶ 朗读";
    bubble.setAttribute("style",
      "position:absolute;z-index:2147483647;background:#1a73e8;color:#fff;border:0;border-radius:16px;" +
      "padding:5px 12px;cursor:pointer;font:12px system-ui,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.3);display:none");
    bubble.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const text = (window.getSelection() || "").toString().trim();
      hideBubble();
      if (text) begin(splitText(text).map((t) => ({ text: t, el: null })), text);
    });
    document.body.appendChild(bubble);
    return bubble;
  }
  function hideBubble() { if (bubble) bubble.style.display = "none"; }
  document.addEventListener("mouseup", () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || !sel.rangeCount) return hideBubble();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const b = ensureBubble();
      b.style.display = "block";
      b.style.left = (rect.left + window.scrollX) + "px";
      b.style.top = (rect.top + window.scrollY - 34) + "px";
    }, 10);
  });
  document.addEventListener("mousedown", (ev) => {
    if (bubble && ev.target !== bubble) hideBubble();
    if (hoverBtn && ev.target !== hoverBtn) hideHover();
  });

  // ---------------- 悬停段落点播 ----------------
  let hoverBtn = null, hoverEl = null, hoverHideTimer = null;
  function ensureHoverBtn() {
    if (hoverBtn) return hoverBtn;
    hoverBtn = document.createElement("button");
    hoverBtn.id = "page-reader-hover";
    hoverBtn.textContent = "▶";
    hoverBtn.title = "从这一段开始朗读";
    hoverBtn.setAttribute("style",
      "position:absolute;z-index:2147483646;background:#1a73e8;color:#fff;border:0;border-radius:50%;" +
      "width:26px;height:26px;cursor:pointer;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:none");
    hoverBtn.addEventListener("click", () => {
      if (!hoverEl) return;
      const paras = collectParagraphs();
      const at = paras.findIndex((p) => p.el === hoverEl);
      hideHover();
      if (at >= 0) begin(buildSegmentsFromParagraphs(paras, at), paras.map((p) => p.text).join(" "));
    });
    hoverBtn.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
    hoverBtn.addEventListener("mouseleave", scheduleHideHover);
    document.body.appendChild(hoverBtn);
    return hoverBtn;
  }
  function scheduleHideHover() { clearTimeout(hoverHideTimer); hoverHideTimer = setTimeout(hideHover, 600); }
  function hideHover() { if (hoverBtn) hoverBtn.style.display = "none"; hoverEl = null; }
  document.addEventListener("mouseover", (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest($sel) : null;
    if (!t || t.closest(NOISE) || (t.innerText || "").trim().length < 20) { scheduleHideHover(); return; }
    clearTimeout(hoverHideTimer);
    hoverEl = t;
    const b = ensureHoverBtn();
    const r = t.getBoundingClientRect();
    b.style.display = "block";
    b.style.left = (r.left + window.scrollX - 32) + "px";
    b.style.top = (r.top + window.scrollY) + "px";
  });

  window.addEventListener("beforeunload", () => {
    if (synth) synth.cancel();
    chrome.runtime.sendMessage({ type: "PIPER_STOP" }).catch(() => {});
  });

  // ---------------- Piper（offscreen）事件 ----------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "PIPER_EVENT") return;
    if (msg.event === "init" && msg.voice && msg.voice !== (settings.piperVoice || "huayan")) return; // 别的音色的初始化状态与我无关
    if (msg.event === "init") {
      if (msg.state === "loading") { transientStatus = "离线音色加载中（首次约几秒）…"; updatePlayer(); }
      if (msg.state === "ready") { piperReady = true; if (transientStatus.startsWith("离线音色加载中")) transientStatus = ""; updatePlayer(); }
      if (msg.state === "error") {
        playing = false; clearHighlight();
        transientStatus = (msg.message || "离线音色初始化失败") + "。可在弹窗切换到系统音色。";
        updatePlayer(); broadcast();
      }
    }
    if (msg.event === "playing" && msg.token === piperToken) {
      clearTimeout(piperWatchdog);
      piperRetries = 0;
      if (transientStatus.startsWith("离线音色加载中")) transientStatus = "";
      updatePlayer();
    }
    if ((msg.event === "ended" || msg.event === "error") && msg.token === piperToken) clearTimeout(piperWatchdog);
    if (msg.event === "error" && msg.message) {
      // 合成/播放的失败原因直接显示在播放器上，别让用户干猜
      transientStatus = msg.message;
      updatePlayer();
    }
    if (msg.event === "ended" && settings.engine === "piper" && playing && msg.token === piperToken) advance();
    if (msg.event === "error" && settings.engine === "piper" && playing && msg.token === piperToken) advance(); // 单段合成失败就跳过，别卡死
  });

  // ---------------- 消息入口 ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "PING") { sendResponse({ ok: true }); return; }
    if (msg.settings) settings = { ...settings, ...msg.settings };
    switch (msg.type) {
      case "READ_SELECTION_OR_PAGE": {
        const sel = (window.getSelection() || "").toString().trim();
        if (sel) { sendResponse(begin(splitText(sel).map((t) => ({ text: t, el: null })), sel)); break; }
        // fallthrough 到全文
      }
      case "READ_PAGE": {
        const paras = collectParagraphs();
        if (paras.length) sendResponse(begin(buildSegmentsFromParagraphs(paras, 0), paras.map((p) => p.text).join(" ")));
        else { const t = extractMainText(); sendResponse(begin(splitText(t).map((x) => ({ text: x, el: null })), t)); }
        break;
      }
      case "READ_SELECTION": {
        const sel = (window.getSelection() || "").toString().trim();
        sendResponse(sel ? begin(splitText(sel).map((t) => ({ text: t, el: null })), sel)
                         : { ok: false, reason: "先选中一段文字" });
        break;
      }
      case "STOP": stopAll(); sendResponse({ ok: true }); break;
      case "PAUSE":
        if (settings.engine === "piper") { chrome.runtime.sendMessage({ type: "PIPER_PAUSE" }).catch(() => {}); piperPaused = true; }
        else synth.pause();
        broadcast(); sendResponse({ ok: true }); break;
      case "RESUME":
        if (settings.engine === "piper") { chrome.runtime.sendMessage({ type: "PIPER_RESUME" }).catch(() => {}); piperPaused = false; }
        else synth.resume();
        broadcast(); sendResponse({ ok: true }); break;
      case "GET_STATUS": sendResponse(statusObj()); break;
      default: sendResponse({ ok: false, reason: "unknown command" });
    }
  });
})();
