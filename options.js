// options.js — manages profile + API key in chrome.storage.sync

function loadCfg() {
  chrome.storage.sync.get({ apiKey: "", profile: "Child" }, ({ apiKey, profile }) => {
    document.getElementById("apiKey").value = apiKey || "";
    document.getElementById("profile").value = profile || "Child";
  });
}

function saveCfg() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const profile = document.getElementById("profile").value.trim() || "Child";
  chrome.storage.sync.set({ apiKey, profile }, () => {
    // Inform background (optional)
    chrome.runtime.sendMessage({ type: "YTL_SET_CONFIG", apiKey, profile }, () => {});
    const el = document.getElementById("status");
    el.textContent = "Saved.";
    el.classList.add("ok");
    setTimeout(() => { el.textContent = ""; el.classList.remove("ok"); }, 1500);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadCfg();
  document.getElementById('save').addEventListener('click', saveCfg);
});