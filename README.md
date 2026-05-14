# VideoWingman

A Chrome extension that lets you chat with any YouTube video. It pulls the
video's transcript and uses Claude AI to answer your questions — and can search
the web when something in the video needs outside context.

## Features

- **Transcript-grounded Q&A** — ask anything about the video you're watching;
  answers cite approximate timestamps.
- **Web search** — when the transcript doesn't cover something, Claude searches
  the web and shows its sources.
- **In-page sidebar** — a slide-in panel on the YouTube watch page, with
  suggested questions and a chat history.

## Requirements

- Google Chrome (or a Chromium-based browser)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
  (API usage is billed separately from a Claude.ai subscription)

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `videowingman` folder.
5. Confirm the **VideoWingman** card appears with no errors.

## Setup

1. On the VideoWingman card, click **Details** → **Extension options**.
2. Paste your Anthropic API key (`sk-ant-...`) and click **Save**.

The key is stored locally in your browser (`chrome.storage.sync`) and is never
sent anywhere except directly to the Anthropic API.

## Usage

1. Open any YouTube video that has captions.
2. The sidebar slides in from the right — or click the **Wingman** tab on the
   edge of the screen to open it.
3. Wait for "Transcript ready", then ask a question or pick a suggested one.

## Project structure

```
videowingman/
├── manifest.json              Extension manifest (MV3)
├── background/
│   └── service_worker.js      Transcript extraction + Claude API calls
├── content/
│   ├── main.js                Sidebar UI and chat logic
│   └── sidebar.css            Sidebar styles
├── options/
│   ├── options.html           API key settings page
│   └── options.js
├── popup/
│   └── popup.html             Toolbar popup
└── icons/
```

## How it works

1. The content script (`content/main.js`) builds the sidebar and asks the
   service worker for the current video's transcript.
2. The service worker (`background/service_worker.js`) fetches the transcript —
   first via YouTube's `timedtext` API, falling back to scraping the on-page
   transcript panel.
3. When you ask a question, the service worker sends the transcript and your
   message to the Anthropic API (with the web search tool enabled) and returns
   the answer and any sources to the sidebar.

## Status

Early development. Known limitations:

- Transcript extraction may fail on some videos (no captions, or unusual
  layouts).
- Suggested questions are currently fixed defaults.
- Responses are not streamed — answers appear all at once.
