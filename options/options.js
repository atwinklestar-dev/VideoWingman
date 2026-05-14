const STORAGE_KEY = "anthropicApiKey";

const apiKeyInput = document.getElementById("apiKey");
const toggleBtn = document.getElementById("toggle");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind || "";
}

chrome.storage.sync.get([STORAGE_KEY], (result) => {
  if (result && result[STORAGE_KEY]) {
    apiKeyInput.value = result[STORAGE_KEY];
  }
});

toggleBtn.addEventListener("click", () => {
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleBtn.textContent = showing ? "Show" : "Hide";
});

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    setStatus("Enter an API key.", "err");
    return;
  }
  if (!key.startsWith("sk-ant-") || key.length < 20) {
    setStatus("That doesn't look like an Anthropic API key (sk-ant-...).", "err");
    return;
  }

  chrome.storage.sync.set({ [STORAGE_KEY]: key }, () => {
    if (chrome.runtime.lastError) {
      setStatus(`Could not save: ${chrome.runtime.lastError.message}`, "err");
      return;
    }
    setStatus("Saved.", "ok");
  });
});
