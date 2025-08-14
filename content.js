// content.js — detects current video ID/URL changes and informs background
(function () {
  if (location.hostname !== "www.youtube.com") return;

  function getCurrentVideo() {
    const url = location.href;
    let videoId = null;
    try {
      if (url.includes("/watch")) {
        const u = new URL(url);
        videoId = u.searchParams.get("v");
      } else if (url.includes("/shorts/")) {
        const m = url.match(/\/shorts\/([a-zA-Z0-9_-]{6,})/);
        if (m) videoId = m[1];
      }
    } catch {}
    return { videoId, url };
  }

  let lastSent = { videoId: null, url: null };

  function maybeSend() {
    const { videoId, url } = getCurrentVideo();
    if (!videoId) return;
    if (videoId === lastSent.videoId) return;
    lastSent = { videoId, url };
    chrome.runtime.sendMessage({ type: "YTL_VIDEO", videoId, url }, () => {});
  }

  // Initial
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(maybeSend, 800);
  });

  // Watch for SPA route changes
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  function wrap(fn) {
    return function () {
      const r = fn.apply(this, arguments);
      setTimeout(maybeSend, 800);
      return r;
    };
  }
  history.pushState = wrap(origPush);
  history.replaceState = wrap(origReplace);
  window.addEventListener("popstate", () => setTimeout(maybeSend, 800));

  // DOM mutations can indicate internal navigation
  const mo = new MutationObserver(() => setTimeout(maybeSend, 800));
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();