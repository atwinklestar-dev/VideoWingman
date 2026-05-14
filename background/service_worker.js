/**
 * VideoWingman Background Service Worker
 *
 * Transcript fetch — two approaches tried in order:
 *
 * 1. Extension SW fetches simple timedtext URL directly.
 *    - Extension SW is outside YouTube's own service worker scope,
 *      so YouTube's SW cannot intercept it.
 *    - We use the simple ?v=VIDEO_ID&lang=en URL (no signed params)
 *      so the server generates a fresh response.
 *    - We get videoId + lang from the page via executeScript.
 *
 * 2. DOM scraping fallback.
 *    - Click the "More" menu → click "Transcript" item.
 *    - Split into TWO separate executeScript calls to avoid
 *      Chrome's timeout on long-running injected async functions.
 *    - First call: open the menu, click Transcript.
 *    - Wait 3s in the SW (outside executeScript timeout).
 *    - Second call: scrape the now-rendered segment elements.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getTranscript") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab ID" });
      return;
    }
    fetchTranscript(tabId)
      .then((transcript) => sendResponse({ ok: true, transcript }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === "chat") {
    chatWithClaude(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function fetchTranscript(tabId) {
  // ── Approach 1: Extension SW fetches timedtext directly ──────────────────
  // Get videoId + language from the live page
  const pageInfo = await runInPage(tabId, () => {
    const player = window.ytInitialPlayerResponse;
    const videoId = player?.videoDetails?.videoId || null;
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track =
      tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ||
      tracks.find((t) => t.languageCode === "en") ||
      tracks[0] || null;
    const lang = track?.languageCode || "en";
    const kind = track?.kind || "";
    return { videoId, lang, kind };
  });

  if (pageInfo.videoId) {
    const { videoId, lang, kind } = pageInfo;

    // Try a set of simple clean URLs — no signed params, so no stale/placeholder issue.
    // Extension SW fetch is NOT intercepted by YouTube's own SW.
    const candidates = [
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&kind=asr&fmt=json3`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=xml`,
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}`,
    ];

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json, text/xml, */*",
            "Referer": `https://www.youtube.com/watch?v=${videoId}`,
          },
        });
        const text = await res.text();
        console.log(`[VideoWingman] SW fetch ${url} → ${res.status} len=${text.length} ct=${res.headers.get("content-type")}`);
        if (res.ok && text && text.trim().length > 10) {
          const segments = parseCaptions(text);
          if (segments.length > 0) return segments;
        }
      } catch (e) {
        console.log(`[VideoWingman] SW fetch error: ${e.message}`);
      }
    }
  }

  // ── Approach 2: DOM scraping ─────────────────────────────────────────────
  // Step A: click More → click Transcript (quick, no waiting inside executeScript)
  const clickResult = await runInPage(tabId, () => {
    // If transcript panel already open, report it
    const existing = document.querySelectorAll("ytd-transcript-segment-renderer");
    if (existing.length > 0) return { alreadyOpen: true };

    // Find and click the "More" button under the video
    const moreBtn = Array.from(document.querySelectorAll("button"))
      .find((el) => el.getAttribute("aria-label") === "More");
    if (!moreBtn) return { error: "More button not found" };
    moreBtn.click();
    return { clickedMore: true };
  });

  if (clickResult.error) throw new Error(clickResult.error);

  if (!clickResult.alreadyOpen) {
    // Both clicks (More → Transcript) must happen in ONE executeScript call.
    // A second call refocuses the page and dismisses the dropdown.
    // Use MutationObserver inside the injected script to wait for menu items.
    const menuResult = await runInPage(tabId, () =>
      new Promise((resolve) => {
        const moreBtn = Array.from(document.querySelectorAll("button"))
          .find((el) => el.getAttribute("aria-label") === "More");
        if (!moreBtn) { resolve({ error: "More button not found" }); return; }

        moreBtn.click();

        // Poll every 100ms for up to 3s.
        // Search ANY clickable element for "Transcript" text — not just menu items,
        // since YouTube's current layout may use different element types.
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;

          // Cast a wide net: any button, anchor, paper-item, or renderer with "Transcript"
          const all = Array.from(document.querySelectorAll(
            "button, a, tp-yt-paper-item, ytd-menu-service-item-renderer, " +
            "ytd-menu-navigation-item-renderer, yt-list-item-view-model, " +
            "ytd-compact-link-renderer, ytd-toggle-button-renderer"
          ));

          const item = all.find((el) => {
            const t = el.textContent?.trim().replace(/\s+/g, " ");
            return t === "Transcript" || t === "Show transcript";
          });

          if (item) {
            clearInterval(interval);
            item.click();
            resolve({ clickedTranscript: true });
          } else if (attempts >= 30) {
            clearInterval(interval);
            // Log a sample of what IS on the page to help diagnose
            const sample = all
              .map((el) => el.textContent?.trim().replace(/\s+/g, " ").slice(0, 60))
              .filter((t) => t && t.length > 1)
              .slice(0, 30);
            resolve({
              error: "Transcript button not found after 3s. Sampled elements: " +
                JSON.stringify(sample)
            });
          }
        }, 100);
      })
    );

    if (menuResult.error) throw new Error(menuResult.error);

    // Wait for transcript panel to render — done in SW, outside executeScript
    await sleep(5000);
  }

  // Step C: scrape the rendered segments
  const scrapeResult = await runInPage(tabId, () => {
    // Diagnostic: log what's inside the transcript panel
    const panel = document.querySelector("ytd-transcript-renderer, ytd-engagement-panel-section-list-renderer");
    if (panel) {
      const tags = Array.from(panel.querySelectorAll("*"))
        .map(el => el.tagName)
        .filter((v, i, a) => a.indexOf(v) === i) // unique
        .slice(0, 30);
      console.log("[VideoWingman] Tags inside transcript panel:", JSON.stringify(tags));
    } else {
      console.log("[VideoWingman] No transcript panel element found in DOM");
    }

    const segmentEls = document.querySelectorAll("ytd-transcript-segment-renderer");
    if (!segmentEls.length) {
      return { error: "No ytd-transcript-segment-renderer elements found after waiting" };
    }

    const segments = [];
    for (const el of segmentEls) {
      const tsEl = el.querySelector(".segment-timestamp, [class*='timestamp']");
      const txtEl = el.querySelector(".segment-text, yt-formatted-string");
      const rawTs = tsEl?.textContent?.trim() || "0:00";
      const text = txtEl?.textContent?.trim() || "";
      if (!text) continue;

      const parts = rawTs.split(":").map(Number);
      let start = 0;
      if (parts.length === 2) start = parts[0] * 60 + parts[1];
      if (parts.length === 3) start = parts[0] * 3600 + parts[1] * 60 + parts[2];
      segments.push({ start, dur: 0, text });
    }

    // Close the panel
    const closeBtn = document.querySelector(
      "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript'] #visibility-button button"
    );
    if (closeBtn) closeBtn.click();

    return { segments };
  });

  if (scrapeResult.error) throw new Error(scrapeResult.error);
  if (!scrapeResult.segments?.length) throw new Error("DOM scraping returned no segments");

  return scrapeResult.segments;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function runInPage(tabId, func) {
  return chrome.scripting
    .executeScript({ target: { tabId }, world: "MAIN", func })
    .then((results) => results?.[0]?.result ?? {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseCaptions(raw) {
  return raw.trimStart().startsWith("{") ? parseJson3(raw) : parseXml(raw);
}

function parseJson3(raw) {
  const data = JSON.parse(raw);
  const segments = [];
  for (const event of data.events || []) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (text) {
      segments.push({
        start: (event.tStartMs || 0) / 1000,
        dur: (event.dDurationMs || 0) / 1000,
        text,
      });
    }
  }
  return segments;
}

function parseXml(xml) {
  const segments = [];
  const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const attrs = m[1];
    const raw = m[2];
    const startMatch = attrs.match(/start="([\d.]+)"/);
    if (!startMatch) continue;
    const start = parseFloat(startMatch[1]);
    const durMatch = attrs.match(/dur="([\d.]+)"/);
    const dur = durMatch ? parseFloat(durMatch[1]) : 0;
    const text = decodeEntities(raw.replace(/<[^>]+>/g, " ").trim());
    if (text) segments.push({ start, dur, text });
  }
  return segments;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)));
}

// ── Claude chat ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "anthropicApiKey";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TRANSCRIPT_CHARS = 100000;

function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEY], (result) => {
      resolve(result && result[STORAGE_KEY] ? result[STORAGE_KEY] : null);
    });
  });
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildTranscriptText(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return "";
  }
  let text = transcript
    .map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`)
    .join("\n");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS) + "\n[transcript truncated]";
  }
  return text;
}

function buildSystemPrompt(transcript) {
  const transcriptText = buildTranscriptText(transcript);

  if (!transcriptText) {
    return (
      "You are VideoWingman, an assistant that helps a user understand the " +
      "YouTube video they are currently watching. No transcript is available " +
      "for this video, so rely on the user's questions and web search to help " +
      "them. Use the web_search tool whenever it would improve your answer. " +
      "Keep answers concise and conversational."
    );
  }

  return (
    "You are VideoWingman, an assistant that helps a user understand the " +
    "YouTube video they are currently watching. You are given the video's " +
    "transcript below.\n\n" +
    "Answer questions using the transcript when possible. Whenever you " +
    "describe, summarize, or refer to a part of the video, include its " +
    "timestamp in m:ss form (e.g. 4:12) or a range (e.g. 2:03-3:20) — every " +
    "bullet point in a summary should carry the timestamp it covers. When the " +
    "transcript does not cover something the user asks about, or they want " +
    "broader context, use the web_search tool.\n\n" +
    "Format every answer in Markdown: use **bold** for key terms, and use " +
    "bullet lists (a line starting with '- ') for any answer with more than " +
    "one point. Keep answers concise and conversational.\n\n" +
    "--- TRANSCRIPT ---\n" +
    transcriptText +
    "\n--- END TRANSCRIPT ---"
  );
}

function parseAnthropicResponse(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  let answer = "";
  const citations = [];
  const seenUrls = new Set();
  let searchUsed = false;

  for (const block of content) {
    if (block?.type === "text") {
      answer += block.text || "";
      const blockCitations = Array.isArray(block.citations)
        ? block.citations
        : [];
      for (const citation of blockCitations) {
        const url = citation?.url;
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          citations.push({ url, title: citation?.title || url });
        }
      }
    } else if (block?.type === "web_search_tool_result") {
      searchUsed = true;
    }
  }

  return { answer: answer.trim(), citations, searchUsed };
}

async function chatWithClaude({ question, transcript, history }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: "no_api_key" };
  }

  const messages = [
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: question }
  ];

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(transcript),
        messages,
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: 5 }
        ]
      })
    });
  } catch (err) {
    return { ok: false, error: `network: ${err?.message || String(err)}` };
  }

  if (res.status === 401) {
    return { ok: false, error: "auth_failed" };
  }
  if (res.status === 429) {
    return { ok: false, error: "rate_limited" };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, error: `bad_response: ${err?.message || String(err)}` };
  }

  if (!res.ok) {
    return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
  }

  const { answer, citations, searchUsed } = parseAnthropicResponse(data);
  if (!answer) {
    return { ok: false, error: "empty_answer" };
  }

  return { ok: true, answer, citations, searchUsed };
}
