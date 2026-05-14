/**
 * VideoWingman Content Script
 *
 * 1. Waits for yt-navigate-finish to ensure YouTube is fully ready
 * 2. Requests transcript from the background service worker
 * 3. Renders the sidebar with suggested questions and chat UI
 */

(function () {
  "use strict";

  let lastVideoId = null;
  let currentTranscript = [];
  let conversationHistory = [];

  // ── Suggested questions (placeholder — Claude will generate these later) ──
  const DEFAULT_SUGGESTIONS = [
    "What is this video about?",
    "What are the key points?",
    "Summarize this in 3 bullet points",
  ];

  // ── Sidebar DOM ──────────────────────────────────────────────────────────

  function buildSidebar() {
    if (document.getElementById("vw-sidebar")) return;

    // Toggle button (visible when sidebar is closed)
    const toggle = document.createElement("button");
    toggle.id = "vw-toggle";
    toggle.className = "vw-hidden";
    toggle.textContent = "Wingman";
    toggle.title = "Open VideoWingman";
    toggle.addEventListener("click", openSidebar);
    document.body.appendChild(toggle);

    // Sidebar
    const sidebar = document.createElement("div");
    sidebar.id = "vw-sidebar";
    sidebar.innerHTML = `
      <div id="vw-header">
        <h2>VideoWingman</h2>
        <button id="vw-close" title="Close">✕</button>
      </div>
      <div id="vw-status">Loading transcript…</div>
      <div id="vw-suggestions" style="display:none">
        <p>Suggested questions</p>
        <div id="vw-chips"></div>
      </div>
      <div id="vw-messages"></div>
      <div id="vw-input-area">
        <textarea id="vw-input" placeholder="Ask about this video…" rows="1"></textarea>
        <button id="vw-send" disabled>➤</button>
      </div>
    `;
    document.body.appendChild(sidebar);

    // Events
    document.getElementById("vw-close").addEventListener("click", closeSidebar);
    document.getElementById("vw-send").addEventListener("click", handleSend);
    document.getElementById("vw-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    // Auto-resize textarea
    document.getElementById("vw-input").addEventListener("input", (e) => {
      e.target.style.height = "auto";
      e.target.style.height = Math.min(e.target.scrollHeight, 100) + "px";
    });
  }

  function openSidebar() {
    document.getElementById("vw-sidebar")?.classList.add("vw-open");
    document.getElementById("vw-toggle")?.classList.add("vw-hidden");
    document.querySelector("ytd-app")?.classList.add("vw-pushed");
  }

  function closeSidebar() {
    document.getElementById("vw-sidebar")?.classList.remove("vw-open");
    document.getElementById("vw-toggle")?.classList.remove("vw-hidden");
    document.querySelector("ytd-app")?.classList.remove("vw-pushed");
  }

  function setStatus(text, ready = false) {
    const el = document.getElementById("vw-status");
    if (!el) return;
    el.textContent = text;
    el.className = ready ? "vw-ready" : "";
  }

  function showSuggestions(questions) {
    const section = document.getElementById("vw-suggestions");
    const chips = document.getElementById("vw-chips");
    if (!section || !chips) return;
    chips.innerHTML = "";
    questions.forEach((q) => {
      const chip = document.createElement("button");
      chip.className = "vw-chip";
      chip.textContent = q;
      chip.addEventListener("click", () => sendMessage(q));
      chips.appendChild(chip);
    });
    section.style.display = "block";
  }

  function addMessage(text, role) {
    const messages = document.getElementById("vw-messages");
    if (!messages) return;
    const div = document.createElement("div");
    div.className = `vw-msg vw-${role}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  // ── Markdown rendering ─────────────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseTimestamp(ts) {
    const parts = ts.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function inlineMarkdown(s) {
    // links [text](url)
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    // bold **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // italic *text*
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    // clickable timestamps (m:ss or h:mm:ss)
    s = s.replace(
      /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g,
      '<a class="vw-ts" data-ts="$1">$1</a>'
    );
    return s;
  }

  function renderMarkdown(text) {
    const lines = escapeHtml(text).split("\n");
    let html = "";
    let inList = false;
    for (const raw of lines) {
      const line = raw.trim();
      const bullet = line.match(/^[*-]\s+(.*)$/);
      if (bullet) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + inlineMarkdown(bullet[1]) + "</li>";
        continue;
      }
      if (inList) { html += "</ul>"; inList = false; }
      if (!line) continue;
      const header = line.match(/^#{1,6}\s+(.*)$/);
      if (header) {
        html += '<p class="vw-md-head">' + inlineMarkdown(header[1]) + "</p>";
      } else {
        html += "<p>" + inlineMarkdown(line) + "</p>";
      }
    }
    if (inList) html += "</ul>";
    return html;
  }

  function seekVideo(seconds) {
    const video = document.querySelector("video");
    if (video) {
      video.currentTime = seconds;
      if (typeof video.play === "function") video.play();
    }
  }

  function wireTimestamps(container) {
    container.querySelectorAll("a.vw-ts").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        const seconds = parseTimestamp(el.dataset.ts || "");
        if (seconds != null) seekVideo(seconds);
      });
    });
  }

  function renderCitations(container, citations) {
    if (!Array.isArray(citations) || citations.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "vw-sources";

    const label = document.createElement("div");
    label.className = "vw-sources-label";
    label.textContent = "Sources";
    wrap.appendChild(label);

    citations.forEach((c) => {
      const a = document.createElement("a");
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = c.title || c.url;
      wrap.appendChild(a);
    });
    container.appendChild(wrap);
  }

  function renderError(loadingMsg, error) {
    loadingMsg.className = "vw-msg vw-error";

    if (error === "no_api_key") {
      loadingMsg.textContent = "No Anthropic API key set. ";
      const btn = document.createElement("button");
      btn.className = "vw-error-btn";
      btn.textContent = "Set your API key";
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      loadingMsg.appendChild(btn);
    } else if (error === "auth_failed") {
      loadingMsg.textContent =
        "API key was rejected. Check it in the extension options.";
    } else if (error === "rate_limited") {
      loadingMsg.textContent = "Rate limited by the API. Try again in a moment.";
    } else {
      loadingMsg.textContent = "Something went wrong: " + error;
    }
  }

  function sendMessage(text) {
    if (!text.trim()) return;

    const input = document.getElementById("vw-input");
    const sendBtn = document.getElementById("vw-send");
    if (input) { input.value = ""; input.style.height = "auto"; }
    if (sendBtn) sendBtn.disabled = true;

    addMessage(text, "user");
    const loadingMsg = addMessage("Thinking…", "loading");

    const priorHistory = conversationHistory.slice();
    conversationHistory.push({ role: "user", content: text });

    chrome.runtime.sendMessage(
      {
        action: "chat",
        question: text,
        transcript: currentTranscript,
        history: priorHistory,
      },
      (response) => {
        if (sendBtn) sendBtn.disabled = false;
        if (!loadingMsg) return;

        if (chrome.runtime.lastError) {
          renderError(loadingMsg, chrome.runtime.lastError.message);
          conversationHistory.pop();
          return;
        }
        if (!response || !response.ok) {
          renderError(loadingMsg, response ? response.error : "no_response");
          conversationHistory.pop();
          return;
        }

        loadingMsg.className = "vw-msg vw-assistant";
        loadingMsg.innerHTML = renderMarkdown(response.answer);
        wireTimestamps(loadingMsg);
        renderCitations(loadingMsg, response.citations);
        conversationHistory.push({ role: "assistant", content: response.answer });

        const messages = document.getElementById("vw-messages");
        if (messages) messages.scrollTop = messages.scrollHeight;
      }
    );
  }

  function handleSend() {
    const input = document.getElementById("vw-input");
    const text = input?.value?.trim();
    if (text) sendMessage(text);
  }

  // ── Transcript loading ───────────────────────────────────────────────────

  function getVideoId() {
    return new URLSearchParams(window.location.search).get("v");
  }

  function onTranscriptReady(transcript) {
    currentTranscript = transcript;
    const fullText = transcript.map((s) => s.text).join(" ");

    console.log(`[VideoWingman] Transcript loaded — ${transcript.length} segments, ${fullText.length} chars`);
    console.log(`[VideoWingman] First 3 segments:`);
    transcript.slice(0, 3).forEach((s, i) =>
      console.log(`  [${i}] ${s.start}s — "${s.text}"`)
    );
    console.log(`[VideoWingman] Last 3 segments:`);
    transcript.slice(-3).forEach((s, i) =>
      console.log(`  [${transcript.length - 3 + i}] ${s.start}s — "${s.text}"`)
    );

    setStatus(`Transcript ready · ${transcript.length} segments`, true);
    document.getElementById("vw-send").disabled = false;
    showSuggestions(DEFAULT_SUGGESTIONS);
  }

  function requestTranscript(videoId) {
    if (!videoId || videoId === lastVideoId) return;
    lastVideoId = videoId;
    conversationHistory = [];

    // Reset UI for new video
    const messages = document.getElementById("vw-messages");
    if (messages) messages.innerHTML = "";
    const suggestions = document.getElementById("vw-suggestions");
    if (suggestions) suggestions.style.display = "none";
    const sendBtn = document.getElementById("vw-send");
    if (sendBtn) sendBtn.disabled = true;
    setStatus("Loading transcript…");

    openSidebar();

    console.log(`[VideoWingman] Video ready: ${videoId} — fetching transcript…`);

    chrome.runtime.sendMessage({ action: "getTranscript", videoId }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[VideoWingman] Message error:", chrome.runtime.lastError.message);
        setStatus("Error: " + chrome.runtime.lastError.message);
        return;
      }
      if (!response.ok) {
        console.error("[VideoWingman] Transcript error:", response.error);
        setStatus("Could not load transcript");
        return;
      }
      onTranscriptReady(response.transcript);
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  console.log("[VideoWingman] Content script running");
  buildSidebar();

  // Show toggle button immediately so user can open sidebar anytime
  document.getElementById("vw-toggle")?.classList.remove("vw-hidden");

  // YouTube SPA: fires when the page has fully loaded a video
  window.addEventListener("yt-navigate-finish", () => {
    const videoId = getVideoId();
    if (videoId) setTimeout(() => requestTranscript(videoId), 1500);
  });

  // Direct page load — document_idle often runs after 'load' has already fired,
  // so check document.readyState instead of listening for the event.
  const videoId = getVideoId();
  if (videoId) {
    if (document.readyState === "complete") {
      setTimeout(() => requestTranscript(videoId), 2000);
    } else {
      window.addEventListener("load", () => {
        setTimeout(() => requestTranscript(getVideoId()), 2000);
      });
    }
  }

})();
