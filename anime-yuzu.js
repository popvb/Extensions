class AnimeYuzu extends MProvider {
  constructor() {
    super();
    this.client = new Client();

    this.baseUrl = "https://www.anime-yuzu.com";
    this.embedBaseUrl = "https://anime-yuzu.com";
    this.apiBaseUrl = "https://www.anime-yuzu.com/wp-json/dooplayer/v1/post/";

    // If Cloudflare blocks requests, set cookies here (especially `cf_clearance`).
    // Example:
    // this.cookie = "cf_clearance=...; other_cookie=...";
    this.cookie = "";
  }

  getRequestHeaders(extra = {}) {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      Accept: "*/*",
      ...extra,
    };
    if (this.cookie && this.cookie.trim().length > 0) headers.Cookie = this.cookie.trim();
    return headers;
  }

  absoluteUrl(url) {
    if (!url) return "";
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    if (url.startsWith("//")) return `https:${url}`;
    if (!url.startsWith("/")) return `${this.baseUrl}/${url}`;
    return `${this.baseUrl}${url}`;
  }

  stripHtml(text) {
    return (text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  parseAnimeCardsFromHtml(html) {
    const results = [];
    const seen = new Set();

    // Very tolerant: find links to /anime/<slug>/ and try to infer title + image.
    const linkRe = /href\s*=\s*["']([^"']*\/anime\/[^"']+?)["']/gi;
    let match;
    while ((match = linkRe.exec(html)) !== null) {
      const link = match[1];
      const abs = this.absoluteUrl(link);
      if (seen.has(abs)) continue;
      seen.add(abs);

      // Try to find a nearby image alt/title/src.
      const windowStart = Math.max(0, match.index - 800);
      const windowEnd = Math.min(html.length, match.index + 1800);
      const chunk = html.slice(windowStart, windowEnd);

      const imgSrc =
        (chunk.match(/data-lazy-src\s*=\s*["']([^"']+)["']/i) || chunk.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1] ||
        "";
      const imgAlt =
        (chunk.match(/alt\s*=\s*["']([^"']+)["']/i) || chunk.match(/title\s*=\s*["']([^"']+)["']/i) || [])[1] || "";

      const name = this.stripHtml(imgAlt) || abs.split("/").filter(Boolean).pop();
      if (!name) continue;

      results.push({
        name,
        link: abs.replace(this.baseUrl, ""), // prefer relative
        imageUrl: this.absoluteUrl(imgSrc),
      });
    }

    return results;
  }

  hasNextPageFromHtml(html) {
    return /next\s+page-numbers|class\s*=\s*["'][^"']*next[^"']*["']/i.test(html);
  }

  async getLatestUpdates(page) {
    const url = page <= 1 ? `${this.baseUrl}/` : `${this.baseUrl}/page/${page}/`;
    const res = await this.client.get(url, { headers: this.getRequestHeaders({ Referer: this.baseUrl }) });
    const list = this.parseAnimeCardsFromHtml(res.body);
    return { list, hasNextPage: this.hasNextPageFromHtml(res.body) };
  }

  async getPopular(page) {
    // Anime-Yuzu does not expose a distinct "popular" listing reliably; use latest as fallback.
    return await this.getLatestUpdates(page);
  }

  async search(query, page, filters) {
    const q = encodeURIComponent(query || "");
    const url = page <= 1 ? `${this.baseUrl}/?s=${q}` : `${this.baseUrl}/page/${page}/?s=${q}`;
    const res = await this.client.get(url, { headers: this.getRequestHeaders({ Referer: this.baseUrl }) });
    const list = this.parseAnimeCardsFromHtml(res.body);
    return { list, hasNextPage: this.hasNextPageFromHtml(res.body) };
  }

  async getDetail(url) {
    const abs = this.absoluteUrl(url);
    const res = await this.client.get(abs, { headers: this.getRequestHeaders({ Referer: this.baseUrl }) });
    const html = res.body;

    const doc = new Document(html);

    const title =
      (doc.selectFirst("h1") && doc.selectFirst("h1").text.trim()) ||
      (doc.selectFirst('meta[property="og:title"]') && doc.selectFirst('meta[property="og:title"]').attr("content")) ||
      (doc.selectFirst("title") && doc.selectFirst("title").text.split("-")[0].trim()) ||
      "";

    const description =
      (doc.selectFirst('meta[name="description"]') && doc.selectFirst('meta[name="description"]').attr("content")) ||
      (doc.selectFirst(".wp-content") && doc.selectFirst(".wp-content").text.trim()) ||
      "";

    const genre = [];
    doc.select('a[href*="/genre/"]').forEach((a) => {
      const g = a.text.trim();
      if (g && !genre.includes(g)) genre.push(g);
    });

    // Try to infer status (very heuristic)
    let status = 5;
    const titleLower = (doc.selectFirst("title") ? doc.selectFirst("title").text : "").toLowerCase();
    if (titleLower.includes("ยังไม่จบ")) status = 0;
    if (titleLower.includes("จบแล้ว") || titleLower.includes("completed")) status = 1;

    // Episodes: collect all /ep/<id>/ links found on the page.
    const epMap = new Map();
    const epRe = /href\s*=\s*["']([^"']*\/ep\/(\d+)\/?)["']/gi;
    let m;
    while ((m = epRe.exec(html)) !== null) {
      const epUrlAbs = this.absoluteUrl(m[1]);
      const epId = m[2];
      epMap.set(epId, epUrlAbs);
    }

    const episodes = Array.from(epMap.entries())
      .map(([epId, epUrlAbs]) => ({
        name: `Episode ${epId}`,
        url: epUrlAbs.replace(this.baseUrl, ""), // pass as episodeId/url
        dateUpload: "",
      }))
      .reverse();

    return {
      name: title,
      status,
      author: "",
      description,
      genre,
      episodes,
      // Keep a stable animeId for ShonenX server/video methods.
      // We use the anime slug URL as animeId.
      id: abs.replace(this.baseUrl, ""),
    };
  }

  getSupportedServers(animeId, episodeId, episodeNumber) {
    // You said there are 3 sources to choose from.
    return [
      { id: "1", name: "Source 1", isDub: false },
      { id: "2", name: "Source 2", isDub: false },
      { id: "3", name: "Source 3", isDub: false },
    ];
  }

  decodeBase64(b64) {
    if (!b64) return "";
    // atob should exist in the runtime; fallback to manual decode is omitted.
    return atob(b64);
  }

  async getVideos(animeId, episodeId, serverId, category) {
    // episodeId can be "/ep/104080/" or similar; extract numeric id
    const epStr = String(episodeId || "");
    const idMatch = epStr.match(/\/ep\/(\d+)\//) || epStr.match(/\b(\d{4,})\b/);
    if (!idMatch) return [];
    const epNumericId = idMatch[1];

    // 1) Call DooPlayer API to get embed_url
    const apiUrl = `${this.apiBaseUrl}${epNumericId}?type=tv&source=${encodeURIComponent(String(serverId || "1"))}`;
    const apiRes = await this.client.get(apiUrl, {
      headers: this.getRequestHeaders({
        Referer: this.absoluteUrl(`/ep/${epNumericId}/`),
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
      }),
    });

    let apiJson;
    try {
      apiJson = JSON.parse(apiRes.body);
    } catch (e) {
      return [];
    }

    const embedUrl = apiJson.embed_url ? this.absoluteUrl(apiJson.embed_url.replace(this.baseUrl, "")) : "";
    if (!embedUrl) return [];

    // 2) Fetch embed page (anime-yuzu.com domain) which contains /playervk/<base64>/
    const embedAbs = embedUrl.startsWith("https://anime-yuzu.com/")
      ? embedUrl
      : embedUrl.replace("https://www.anime-yuzu.com/", "https://anime-yuzu.com/");

    const embedRes = await this.client.get(embedAbs, {
      headers: this.getRequestHeaders({
        Referer: this.baseUrl + "/",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      }),
    });

    const embedHtml = embedRes.body;
    const iframeSrcMatch = embedHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!iframeSrcMatch) return [];
    const iframeSrc = iframeSrcMatch[1];

    // Example: /playervk/<base64>/
    const b64Match = iframeSrc.match(/\/playervk\/([^/]+)\//i);
    if (!b64Match) return [];
    const decoded = this.decodeBase64(b64Match[1]);
    const mediaUrl = decoded.trim();
    if (!mediaUrl.startsWith("http")) return [];

    // 3) Return final stream URL (mp4)
    // Site uses Origin/Referer checks for some hosts, so include them.
    return [
      {
        url: mediaUrl,
        quality: "Auto",
        originalUrl: mediaUrl,
        headers: {
          Referer: this.baseUrl + "/",
          Origin: this.baseUrl,
        },
      },
    ];
  }
}

