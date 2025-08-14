// popup.js — UI to view, filter, and export logs; opens separate Options page for settings

// ---------- Helpers ----------
function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(+d) ? "" : d.toLocaleString();
}

function fmtDur(sec) {
  if (sec == null) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m || h) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function toCsv(rows) {
  const header = [
    "watchedAt","profile","videoId","title","channelTitle","durationSeconds","url","description",
    "isShorts","liveContent","publishedAt","categoryId","categoryName","tags",
    "defaultLanguage","defaultAudioLanguage","caption","madeForKids",
    "viewCount","likeCount","commentCount","referrer","pageTitle"
  ];
  const esc = (s) => '"' + String(s ?? "").replaceAll('"', '""') + '"';
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.watchedAt, r.profile, r.videoId, r.title, r.channelTitle, r.durationSeconds ?? "", r.url, r.description,
      r.isShorts ?? "", r.liveContent ?? "", r.publishedAt ?? "", r.categoryId ?? "", r.categoryName ?? "",
      Array.isArray(r.tags) ? r.tags.join("|") : "",
      r.defaultLanguage ?? "", r.defaultAudioLanguage ?? "", r.caption ?? "", r.madeForKids ?? "",
      r.viewCount ?? "", r.likeCount ?? "", r.commentCount ?? "", r.referrer ?? "", r.pageTitle ?? ""
    ].map(esc).join(","));
  }
  return lines.join("\n");
}

function groupByDay(rows) {
  const by = {};
  for (const r of rows) {
    const d = new Date(r.watchedAt);
    const day = isNaN(+d) ? "unknown" : d.toISOString().slice(0,10);
    (by[day] ||= []).push(r);
  }
  return by;
}

function downloadBlob(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function uniquePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

function applyFilters(rows) {
  const q = document.getElementById("q")?.value?.trim().toLowerCase() || "";
  const onlyShorts = document.getElementById("fShorts")?.checked;
  const onlyKids = document.getElementById("fKids")?.checked;

  let out = [...rows].sort((a,b) => new Date(b.watchedAt) - new Date(a.watchedAt));
  if (q) out = out.filter(r => (r.title||"").toLowerCase().includes(q) || (r.channelTitle||"").toLowerCase().includes(q));
  if (onlyShorts) out = out.filter(r => r.isShorts === true);
  if (onlyKids) out = out.filter(r => r.madeForKids === true);
  return out;
}

function render(list) {
  const root = document.getElementById("list");
  if (!root) return;
  root.innerHTML = "";

  const rows = applyFilters(list);
  if (!rows.length) {
    root.innerHTML = '<div class="empty">No items logged yet.</div>';
    return;
  }

  for (const r of rows) {
    const div = document.createElement("div");
    div.className = "entry";
    const thumb = r.thumbnails?.medium?.url || r.thumbnails?.default?.url || "";
    const pills = [];
    if (r.isShorts) pills.push('<span class="pill pill-blue">Shorts</span>');
    if (r.liveContent && r.liveContent !== "none") pills.push(`<span class="pill pill-red">${r.liveContent}</span>`);
    if (r.madeForKids) pills.push('<span class="pill pill-green">Made for Kids</span>');
    if (r.categoryName) pills.push(`<span class="pill">${r.categoryName}</span>`);

    div.innerHTML = `
      <div class="row">
        ${thumb ? `<a class="thumb" href="${r.url}" target="_blank" rel="noopener"><img src="${thumb}" alt=""/></a>` : ""}
        <div class="col">
          <a class="title wrap" href="${r.url}" target="_blank" rel="noopener noreferrer">${r.title || r.videoId}</a>
          <div class="meta">
            <span>${r.channelTitle || ""}</span>
            · <span class="muted">${fmtDur(r.durationSeconds)}</span>
            · <span class="muted">${fmtDate(r.watchedAt)}</span>
          </div>
          <div class="pills">${pills.join(" ")}</div>
        </div>
        <span class="pill">${r.profile}</span>
      </div>
    `;
    root.appendChild(div);
  }
}

function loadAndRender() {
  chrome.storage.local.get({ watchLog: [] }, ({ watchLog }) => {
    render(watchLog || []);
  });
}

function rememberPlaylistLink(playlistUrl, count) {
  chrome.storage.local.get({ playlistLinks: [] }, ({ playlistLinks }) => {
    const updated = Array.isArray(playlistLinks) ? playlistLinks : [];
    updated.push({ url: playlistUrl, count, createdAt: new Date().toISOString() });
    chrome.storage.local.set({ playlistLinks: updated });
  });
}

// ---------- Bind events ----------
document.addEventListener('DOMContentLoaded', () => {
  // Friendly hint if API key is missing
  chrome.storage.sync.get({ apiKey: "" }, ({ apiKey }) => {
    if (!apiKey) {
      const root = document.getElementById("list");
      if (root) {
        const warn = document.createElement("div");
        warn.className = "empty";
        warn.textContent = "No YouTube Data API key configured. Click Settings to add one.";
        root.prepend(warn);
      }
    }
  });

  document.getElementById("q")?.addEventListener("input", loadAndRender);
  document.getElementById("fShorts")?.addEventListener("change", loadAndRender);
  document.getElementById("fKids")?.addEventListener("change", loadAndRender);

  document.getElementById("openSettings")?.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  });

  document.getElementById("exportCsv")?.addEventListener("click", () => {
    chrome.storage.local.get({ watchLog: [] }, ({ watchLog }) => {
      const rows = applyFilters(watchLog || []);
      const csv = toCsv(rows);
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g,"").slice(0,12);
      downloadBlob(`youtube_watch_log_${stamp}.csv`, "text/csv;charset=utf-8", csv);
    });
  });

  document.getElementById("exportJson")?.addEventListener("click", () => {
    chrome.storage.local.get({ watchLog: [], playlistLinks: [] }, ({ watchLog, playlistLinks }) => {
      const rows = applyFilters(watchLog || []);
      const dailyLogs = groupByDay(rows);
      const payload = {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        profiles: uniquePreserveOrder(rows.map(r => r.profile)),
        dailyLogs,
        playlistLinks: Array.isArray(playlistLinks) ? playlistLinks : []
      };
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g,"").slice(0,12);
      downloadBlob(`youtube_watch_log_by_day_${stamp}.json`, "application/json;charset=utf-8", JSON.stringify(payload, null, 2));
    });
  });

  document.getElementById("generatePlaylist")?.addEventListener("click", () => {
    chrome.storage.local.get({ watchLog: [] }, ({ watchLog }) => {
      const ids = (watchLog || []).map(e => e.videoId).filter(Boolean);
      if (!ids.length) return;
      const first50 = ids.slice(0, 50);
      const playlistUrl = `https://www.youtube.com/watch_videos?video_ids=${first50.join(',')}`;
      rememberPlaylistLink(playlistUrl, first50.length);
      window.open(playlistUrl, '_blank');
    });
  });

  document.getElementById("clear")?.addEventListener("click", () => {
    if (!confirm("Clear all logged items?")) return;
    chrome.storage.local.set({ watchLog: [], playlistLinks: [] }, loadAndRender);
  });

  loadAndRender();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.watchLog) loadAndRender();
  });
});