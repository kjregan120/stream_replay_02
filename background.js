// background.js — YouTube Watch Logger (MV3)
// - Receives videoId/url from content script
// - Fetches rich metadata from YouTube Data API
// - Stores entries to chrome.storage.local (watchLog)
// - Reads config (apiKey, profile) from chrome.storage.sync
// - First-run helper opens Options if API key is missing

// --------------------------- Utilities ---------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseISODurationToSeconds(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return null;
  const [, h, min, s] = m.map(x => parseInt(x || "0", 10));
  return (h || 0) * 3600 + (min || 0) * 60 + (s || 0);
}

function inferIsShorts({ url, durationSeconds }) {
  if (url && url.includes("/shorts/")) return true;
  if (typeof durationSeconds === "number" && durationSeconds <= 60) return true;
  return false;
}

// Cache for categoryId -> name
const categoryNameCache = new Map();

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ apiKey: "", profile: "Child" }, (cfg) => resolve(cfg));
  });
}

async function getCategoryName(categoryId, apiKey, regionCode = "US") {
  if (!categoryId) return null;
  const cacheKey = `${regionCode}:${categoryId}`;
  if (categoryNameCache.has(cacheKey)) return categoryNameCache.get(cacheKey);

  const url = new URL("https://www.googleapis.com/youtube/v3/videoCategories");
  url.search = new URLSearchParams({ part: "snippet", id: String(categoryId), key: apiKey, regionCode }).toString();

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const name = data?.items?.[0]?.snippet?.title || null;
  categoryNameCache.set(cacheKey, name);
  return name;
}

async function fetchVideoMetadataRich(videoId, apiKey, { maxRetries = 3 } = {}) {
  const baseUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  baseUrl.search = new URLSearchParams({
    part: ["snippet", "contentDetails", "statistics", "status", "topicDetails"].join(","),
    id: videoId,
    key: apiKey,
  }).toString();

  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(baseUrl.toString());
      if (!res.ok) throw new Error(`videos.list ${res.status} ${res.statusText}`);
      const data = await res.json();
      const v = data?.items?.[0];
      if (!v) throw new Error("Video not found");

      const { snippet = {}, contentDetails = {}, statistics = {}, status = {} } = v;
      const durationSeconds = parseISODurationToSeconds(contentDetails.duration);
      const regionRestriction = contentDetails.regionRestriction || null;
      const liveContent = snippet.liveBroadcastContent || "none"; // none | live | upcoming

      return {
        videoId: v.id,
        title: snippet.title || null,
        description: snippet.description || null,
        publishedAt: snippet.publishedAt || null,
        channelId: snippet.channelId || null,
        channelTitle: snippet.channelTitle || null,
        tags: snippet.tags || [],
        thumbnails: snippet.thumbnails || {},
        categoryId: snippet.categoryId || null,
        defaultLanguage: snippet.defaultLanguage || null,
        defaultAudioLanguage: snippet.defaultAudioLanguage || null,
        durationSeconds,
        definition: contentDetails.definition || null,
        caption: contentDetails.caption === "true",
        regionRestriction,
        contentRating: contentDetails.contentRating || null,
        liveContent,
        madeForKids: status?.madeForKids ?? null,
        viewCount: statistics.viewCount ? Number(statistics.viewCount) : null,
        likeCount: statistics.likeCount ? Number(statistics.likeCount) : null,
        commentCount: statistics.commentCount ? Number(statistics.commentCount) : null,
        topicCategories: (v.topicDetails && v.topicDetails.topicCategories) || [],
      };
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      attempt += 1;
      await sleep(300 * attempt);
    }
  }
}

async function fetchChannelBasics(channelId, apiKey) {
  if (!channelId) return null;
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.search = new URLSearchParams({ part: "snippet,statistics,brandingSettings,topicDetails", id: channelId, key: apiKey }).toString();
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const c = data?.items?.[0];
  if (!c) return null;
  const sn = c.snippet || {};
  const stats = c.statistics || {};
  const branding = c.brandingSettings || {};
  return {
    channelId: c.id,
    customUrl: sn.customUrl || null,
    channelCountry: sn.country || null,
    channelDescription: sn.description || null,
    channelCreatedAt: sn.publishedAt || null,
    banner: branding?.image?.bannerExternalUrl || null,
    subscriberCount: stats.subscriberCount ? Number(stats.subscriberCount) : null,
    videoCount: stats.videoCount ? Number(stats.videoCount) : null,
  };
}

// Dedup helper: avoid logging the same video too often per profile
function recentlyLogged(profile, videoId, ttlMinutes = 120) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ lastLogged: {} }, ({ lastLogged }) => {
      const key = `${profile}:${videoId}`;
      const last = lastLogged[key];
      if (!last) return resolve(false);
      const ageMin = (Date.now() - new Date(last).getTime()) / 60000;
      resolve(ageMin < ttlMinutes);
    });
  });
}

function markLogged(profile, videoId) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ lastLogged: {} }, ({ lastLogged }) => {
      const key = `${profile}:${videoId}`;
      lastLogged[key] = new Date().toISOString();
      chrome.storage.local.set({ lastLogged }, resolve);
    });
  });
}

function setLogEntry(entry, maxEntries = 5000) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ watchLog: [] }, ({ watchLog }) => {
      const list = Array.isArray(watchLog) ? watchLog : [];
      list.push(entry);
      // Trim oldest if beyond cap
      if (list.length > maxEntries) list.splice(0, list.length - maxEntries);
      chrome.storage.local.set({ watchLog: list }, () => resolve());
    });
  });
}

// --------------------------- Core logging ---------------------------
async function logYouTubeWatch({ videoId, url }) {
  try {
    const { apiKey, profile } = await getConfig();

    // Dedup within TTL window
    if (await recentlyLogged(profile, videoId)) {
      return;
    }

    const meta = apiKey ? await fetchVideoMetadataRich(videoId, apiKey) : {
      // Fallback minimal meta if no API key is set
      videoId,
      title: null,
      description: null,
      durationSeconds: null,
      channelId: null,
      channelTitle: null,
      publishedAt: null,
      categoryId: null,
      thumbnails: {},
      tags: [],
      defaultLanguage: null,
      defaultAudioLanguage: null,
      liveContent: "none",
      caption: null,
      madeForKids: null,
      regionRestriction: null,
      contentRating: null,
      topicCategories: []
    };

    const categoryName = apiKey ? await getCategoryName(meta.categoryId, apiKey, "US") : null;
    const channelExtra = apiKey && meta.channelId ? await fetchChannelBasics(meta.channelId, apiKey) : null;

    const entry = {
      // identifiers
      videoId,
      url,
      profile,

      // core video fields
      title: meta.title,
      description: meta.description,
      channelId: meta.channelId,
      channelTitle: meta.channelTitle,
      publishedAt: meta.publishedAt,

      // durations & type
      durationSeconds: meta.durationSeconds,
      isShorts: inferIsShorts({ url, durationSeconds: meta.durationSeconds }),
      liveContent: meta.liveContent,

      // categorization
      categoryId: meta.categoryId,
      categoryName,
      tags: meta.tags,
      topicCategories: meta.topicCategories,

      // locale & captions
      defaultLanguage: meta.defaultLanguage,
      defaultAudioLanguage: meta.defaultAudioLanguage,
      caption: meta.caption,
      madeForKids: meta.madeForKids,

      // restrictions / rating
      regionRestriction: meta.regionRestriction,
      contentRating: meta.contentRating,

      // optics
      thumbnails: meta.thumbnails,

      // public-ish stats
      viewCount: meta.viewCount,
      likeCount: meta.likeCount,
      commentCount: meta.commentCount,

      // context
      watchedAt: new Date().toISOString(),

      // optional channel enrichment
      ...(channelExtra ? { channelExtra } : {}),
    };

    await setLogEntry(entry);
    await markLogged(profile, videoId);
    // Notify popup (if open)
    chrome.runtime.sendMessage({ type: "YTL_LOGGED", entry });
  } catch (err) {
    console.error("[YTL] Failed to log video:", err);
  }
}

// --------------------------- Message handling ---------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "YTL_VIDEO") {
    // { videoId, url }
    logYouTubeWatch({ videoId: msg.videoId, url: msg.url });
    sendResponse({ ok: true });
    return true; // keep port open for async
  }
  if (msg?.type === "YTL_SET_CONFIG") {
    // { apiKey, profile }
    chrome.storage.sync.set({ apiKey: msg.apiKey || "", profile: msg.profile || "Child" }, () => sendResponse({ ok: true }));
    return true;
  }
});

// --------------------------- First-run helpers ---------------------------
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get({ apiKey: "" }, ({ apiKey }) => {
    if (!apiKey) {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
    }
  });
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.sync.get({ apiKey: "" }, ({ apiKey }) => {
    if (apiKey) return;
    chrome.storage.local.get({ settingsNaggedOnce: false }, ({ settingsNaggedOnce }) => {
      if (!settingsNaggedOnce) {
        if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
        else chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
        chrome.storage.local.set({ settingsNaggedOnce: true });
      }
    });
  });
});