function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escRegExp(s) {
  return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstTruthy(...vals) {
  for (const v of vals) if (v) return v;
  return "";
}

function parseXmlItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) items.push(m[1]);
  return items;
}

function xmlTag(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function decodeXml(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function parseInfoHash(itemBlock) {
  // Nyaa RSS typically includes <nyaa:infoHash>...</nyaa:infoHash>
  const m = itemBlock.match(/<nyaa:infohash>([a-f0-9]{40})<\/nyaa:infohash>/i);
  return m ? m[1].toLowerCase() : "";
}

function parseSizeBytes(itemBlock) {
  // Try <nyaa:size>1.2 GiB</nyaa:size>
  const m = itemBlock.match(/<nyaa:size>([^<]+)<\/nyaa:size>/i);
  const raw = m ? m[1].trim() : "";
  if (!raw) return 0;

  const mm = raw.match(/([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i);
  if (!mm) return 0;
  const val = Number(mm[1]);
  if (!Number.isFinite(val)) return 0;
  const unit = mm[2].toLowerCase();
  const pow2 = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  const pow10 = { kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  if (unit in pow2) return Math.round(val * pow2[unit]);
  if (unit in pow10) return Math.round(val * pow10[unit]);
  return 0;
}

function parsePubDate(itemBlock) {
  const raw = xmlTag(itemBlock, "pubDate");
  const d = raw ? new Date(raw) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function matchThai(title) {
  const t = (title || "").toLowerCase();
  return /(\bth\b|thai|ซับไทย|พากย์ไทย|ไทย)/i.test(t);
}

async function fetchText(url, fetchFn) {
  const res = await fetchFn(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      Accept: "*/*",
    },
  });
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
  return await res.text();
}

async function getMagnetFromNyaaPage(pageUrl, fetchFn) {
  const html = await fetchText(pageUrl, fetchFn);
  const m = html.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i);
  return m ? decodeXml(m[1]) : "";
}

async function searchNyaa(query, options, fetchFn) {
  const maxResults = Math.max(1, Math.min(50, toInt(options.maxResults, 20)));
  const thaiOnly = options.thaiOnly !== false;
  const extraKeywords = String(options.extraKeywords || "").trim();
  const excludeKeywords = String(options.excludeKeywords || "").trim();

  const base = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query + (extraKeywords ? " " + extraKeywords : ""))}`;
  const xml = await fetchText(base, fetchFn);
  const items = parseXmlItems(xml);

  const results = [];
  const exclude = excludeKeywords
    ? new RegExp(`\\b(?:${excludeKeywords.split(/\s+/).map(escRegExp).join("|")})\\b`, "i")
    : null;

  for (const item of items) {
    if (results.length >= maxResults) break;

    const title = decodeXml(xmlTag(item, "title"));
    if (!title) continue;
    if (thaiOnly && !matchThai(title)) continue;
    if (exclude && exclude.test(title)) continue;

    const pageUrl = decodeXml(xmlTag(item, "link"));
    if (!pageUrl) continue;

    const hash = parseInfoHash(item);
    const size = parseSizeBytes(item);
    const date = parsePubDate(item);

    // Prefer magnet (best), fallback to infoHash if present
    let magnet = "";
    try {
      magnet = await getMagnetFromNyaaPage(pageUrl, fetchFn);
    } catch (_) {
      // ignore; we can still return infoHash if RSS had it
    }

    const link = firstTruthy(magnet, hash, pageUrl);
    if (!link) continue;

    results.push({
      title,
      link,
      seeders: 0,
      leechers: 0,
      downloads: 0,
      accuracy: thaiOnly ? "medium" : "low",
      hash: hash || "",
      size: size || 0,
      date,
    });
  }

  return results;
}

export default {
  async test() {
    return true;
  },

  async single(query, options = {}) {
    const src = String(options.source || "nyaa").toLowerCase();
    if (src !== "nyaa") throw new Error("Only 'nyaa' source is supported right now.");

    const titles = Array.isArray(query.titles) ? query.titles : [];
    const baseTitle = titles[0] || "";
    const ep = query.episode ? ` ${query.episode}` : "";
    const q = `${baseTitle}${ep}`.trim();
    if (!q) return [];

    return await searchNyaa(q, options, query.fetch);
  },

  async batch(query, options = {}) {
    const src = String(options.source || "nyaa").toLowerCase();
    if (src !== "nyaa") throw new Error("Only 'nyaa' source is supported right now.");

    const titles = Array.isArray(query.titles) ? query.titles : [];
    const q = (titles[0] || "").trim();
    if (!q) return [];

    return await searchNyaa(q, options, query.fetch);
  },

  async movie(query, options = {}) {
    const src = String(options.source || "nyaa").toLowerCase();
    if (src !== "nyaa") throw new Error("Only 'nyaa' source is supported right now.");

    const titles = Array.isArray(query.titles) ? query.titles : [];
    const q = (titles[0] || "").trim();
    if (!q) return [];

    return await searchNyaa(q, options, query.fetch);
  },
};

