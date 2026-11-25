const https = require("https");
const dns = require("dns");
const querystring = require("querystring");
const crypto = require("crypto");
const vm = require("vm");
const { Readable } = require("stream");

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const OMDOWN_BASE = "https://www.omdown.site";
const FALLBACK_ACTION_ID = "708399a12b89c0c44316117a83426033874649eaec";
const NEXT_ROUTER_STATE_TREE =
  "%5B%22%22%2C%7B%22children%22%3A%5B%5B%22locale%22%2C%22id%22%2C%22d%22%2Cnull%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C4096%5D%7D%2Cnull%2Cnull%2C4112%5D%7D%2Cnull%2Cnull%2C4112%5D";

const PLATFORM_RULES = [
  [/(?:^|\.)shortdrama\.tiktok\.com$/i, "PineDrama"],
  [/(?:^|\.)tiktok\.com$/i, "TikTok"],
  [/(?:^|\.)(?:douyin\.com|iesdouyin\.com)$/i, "Douyin"],
  [/(?:^|\.)(?:kuaishou\.com|kwai\.com)$/i, "Kuaishou"],
  [/(?:^|\.)(?:snackvideo\.com|sck\.io)$/i, "SnackVideo"],
  [/(?:^|\.)(?:xiaohongshu\.com|rednote\.com|xhslink\.com)$/i, "RedNote"],
  [/(?:^|\.)(?:youtu\.be|youtube\.com)$/i, "YouTube"],
  [/(?:^|\.)(?:instagram\.com|instagr\.am|ig\.me)$/i, "Instagram"],
  [/(?:^|\.)(?:twitter\.com|x\.com|t\.co)$/i, "X"],
  [/(?:^|\.)(?:facebook\.com|fb\.watch|fb\.com)$/i, "Facebook"],
  [/(?:^|\.)threads\.(?:net|com)$/i, "Threads"],
  [/(?:^|\.)(?:bsky\.app|bsky\.social)$/i, "Bluesky"],
  [/(?:^|\.)(?:reddit\.com|redd\.it)$/i, "Reddit"],
  [/(?:^|\.)capcut\.com$/i, "CapCut"],
  [/(?:^|\.)snapchat\.com$/i, "Snapchat"],
  [/(?:^|\.)twitch\.tv$/i, "Twitch"],
  [/(?:^|\.)(?:bilibili\.com|bilibili\.tv|b23\.tv|bili\.im)$/i, "Bilibili"],
  [/(?:^|\.)(?:dailymotion\.com|dai\.ly)$/i, "Dailymotion"],
  [/(?:^|\.)(?:spotify\.com|spoti\.fi)$/i, "Spotify"],
  [/(?:^|\.)soundcloud\.com$/i, "SoundCloud"],
  [/(?:^|\.)(?:pinterest\.(?:com|co\.[a-z]{2}|[a-z]{2,3})|pin\.it)$/i, "Pinterest"],
  [/(?:^|\.)imgur\.com$/i, "Imgur"],
];

function detectPlatform(inputUrl) {
  try {
    const parsed = new URL(/^https?:\/\//i.test(inputUrl) ? inputUrl : `https://${inputUrl}`);
    for (const [pattern, name] of PLATFORM_RULES) {
      if (pattern.test(parsed.hostname)) return name;
    }
  } catch {}
  return "TikTok";
}

function extractVideoId(url) {
  if (url.length === 11 && /^[\w-]+$/.test(url)) return url;
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/)|youtu\.be\/)([\w-]{11})/
  );
  return match ? match[1] : null;
}

// ==========================================
// 1. OMDOWN RESOLVER (with Deployment ID)
// ==========================================
function parseFlightStream(raw) {
  const chunks = new Map();
  let pos = 0;
  while (pos < raw.length) {
    while (pos < raw.length && (raw[pos] === "\r" || raw[pos] === "\n")) pos++;
    if (pos >= raw.length) break;
    const colonIdx = raw.indexOf(":", pos);
    if (colonIdx === -1) break;
    const id = raw.slice(pos, colonIdx);
    if (raw[colonIdx + 1] === "T") {
      const commaIdx = raw.indexOf(",", colonIdx + 1);
      if (commaIdx !== -1) {
        const len = parseInt(raw.slice(colonIdx + 2, commaIdx), 16);
        chunks.set(id, raw.slice(commaIdx + 1, commaIdx + 1 + len));
        pos = commaIdx + 1 + len;
        continue;
      }
    }
    const nextNewline = raw.indexOf("\n", colonIdx + 1);
    const lineEnd = nextNewline !== -1 ? nextNewline : raw.length;
    const content = raw.slice(colonIdx + 1, lineEnd).trim();
    try {
      chunks.set(id, JSON.parse(content));
    } catch {
      chunks.set(id, content);
    }
    pos = lineEnd + 1;
  }
  return chunks;
}

function resolveReferences(value, chunks) {
  if (value === "$undefined") return null;
  if (typeof value === "string" && value.startsWith("$")) {
    const refId = value.slice(1);
    if (chunks.has(refId)) return resolveReferences(chunks.get(refId), chunks);
  }
  if (Array.isArray(value)) return value.map((v) => resolveReferences(v, chunks));
  if (value !== null && typeof value === "object") {
    const resolved = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveReferences(v, chunks);
    }
    return resolved;
  }
  return value;
}

async function resolveOmdown(mediaUrl, baseApiUrl) {
  const platform = detectPlatform(mediaUrl);
  const locale = "id";

  const initRes = await fetch(`${OMDOWN_BASE}/${locale}`, {
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  if (!initRes.ok) throw new Error(`OmDown init failed (${initRes.status})`);

  const setCookieHeaders = initRes.headers.getSetCookie
    ? initRes.headers.getSetCookie()
    : initRes.headers.get("set-cookie")
    ? initRes.headers.get("set-cookie").split(",")
    : [];

  const cookieMap = new Map();
  for (const header of setCookieHeaders) {
    const match = header.match(/^\s*([a-zA-Z0-9_-]+)=([^;]+)/);
    if (match && !["Path", "Expires", "Max-Age", "Domain", "SameSite"].includes(match[1])) {
      cookieMap.set(match[1], match[2]);
    }
  }
  const cookies = Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const html = await initRes.text();
  let actionId = null;

  const dplMatch = html.match(/[?&]dpl=(dpl_[a-zA-Z0-9]+)/);
  const deploymentId = dplMatch ? dplMatch[1] : null;

  const scriptMatches = [...html.matchAll(/src=["'](\/_next\/static\/chunks\/[^"']+\.js[^"']*)["']/g)];
  for (const m of scriptMatches) {
    try {
      const sRes = await fetch(`${OMDOWN_BASE}${m[1]}`, { headers: { "User-Agent": DEFAULT_UA } });
      if (sRes.ok) {
        const js = await sRes.text();
        if (js.includes("resolveMediaAction")) {
          const found =
            js.match(/createServerReference\)?\(["']([a-f0-9]{32,64})["'][^)]*["']resolveMediaAction["']/i) ||
            js.match(/["']([a-f0-9]{32,64})["'][^"']{0,60}resolveMediaAction/i);
          if (found) {
            actionId = found[1];
            break;
          }
        }
      }
    } catch {}
  }

  actionId = actionId || FALLBACK_ACTION_ID;

  const actionHeaders = {
    "User-Agent": DEFAULT_UA,
    Accept: "text/x-component",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Content-Type": "text/plain;charset=UTF-8",
    "Next-Action": actionId,
    "Next-Router-State-Tree": NEXT_ROUTER_STATE_TREE,
    Origin: OMDOWN_BASE,
    Referer: `${OMDOWN_BASE}/${locale}`,
    Cookie: cookies,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  if (deploymentId) {
    actionHeaders["x-deployment-id"] = deploymentId;
  }

  const actionRes = await fetch(`${OMDOWN_BASE}/${locale}`, {
    method: "POST",
    headers: actionHeaders,
    body: JSON.stringify([mediaUrl.trim(), platform, locale]),
  });

  if (!actionRes.ok) throw new Error(`OmDown action HTTP ${actionRes.status}`);

  const raw = await actionRes.text();
  const chunks = parseFlightStream(raw);
  const mainPayload = chunks.get("1");

  if (!mainPayload || mainPayload.success === false) {
    throw new Error(mainPayload?.error || "OmDown rejected resolution");
  }

  const data = resolveReferences(mainPayload.data, chunks);
  const makeAbs = (u) => {
    if (!u || typeof u !== "string") return u;
    return u.startsWith("http") ? u : `${OMDOWN_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
  };

  const medias = [];
  if (Array.isArray(data.formats)) {
    for (const fmt of data.formats) {
      let dl = fmt.downloadUrl;
      if (!dl || dl === "all-playlist" || dl === "all-slides") continue;
      dl = makeAbs(dl);
      if (!dl.includes("download=1")) dl += (dl.includes("?") ? "&" : "?") + "download=1";

      const proxiedUrl = `${baseApiUrl}?proxy=1&url=${encodeURIComponent(dl)}&ck=${encodeURIComponent(cookies)}`;
      const ext = (fmt.ext || "").toLowerCase();
      const isAudio = /audio/.test(fmt.kind || "") || ["mp3", "m4a", "opus", "wav"].includes(ext);
      const isImage = /image|photo|thumb/.test(fmt.kind || "") || ["jpg", "jpeg", "png", "webp"].includes(ext);

      medias.push({
        url: proxiedUrl,
        quality: fmt.quality || fmt.label || "HD",
        extension: ext || (isAudio ? "mp3" : isImage ? "jpg" : "mp4"),
        type: isAudio ? "audio" : isImage ? "image" : "video",
        label: fmt.label || fmt.quality || "Download",
      });
    }
  }

  if (Array.isArray(data.slides)) {
    data.slides.forEach((slide, idx) => {
      const imgUrl = makeAbs(slide.downloadUrl || slide.imageUrl);
      if (imgUrl) {
        medias.push({
          url: imgUrl,
          quality: `Slide ${idx + 1}`,
          extension: "jpg",
          type: "image",
          label: `Slide ${idx + 1}`,
        });
      }
    });
  }

  return {
    source: "omdown",
    platform: data.platform || platform,
    title: data.title || "Media Download",
    thumbnail: makeAbs(data.thumbnailUrl) || "",
    medias,
  };
}

// ==========================================
// 2. SAVEFROM RESOLVER (Fallback)
// ==========================================
async function resolveSaveFrom(targetUrl) {
  const SALT = "b7944d7a59c9cb654228624880e7de59a53842c2d912b449fdf11febcf81cb21";
  const ts = Date.now();
  const hash = crypto
    .createHash("sha256")
    .update(targetUrl + ts + SALT)
    .digest("hex");

  const form = new URLSearchParams({
    sf_url: targetUrl,
    sf_submit: "",
    new: "2",
    lang: "en",
    app: "",
    country: "en",
    os: "Windows",
    browser: "Chrome",
    channel: "main",
    "sf-nomad": "1",
    url: targetUrl,
    ts: String(ts),
    _ts: "1720433117117",
    _tsc: "0",
    _s: hash,
    _x: "1",
  });

  const response = await fetch("https://worker.savefrom.net/savefrom.php", {
    method: "POST",
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://en.savefrom.net",
      referer: "https://en.savefrom.net/",
      "user-agent": DEFAULT_UA,
    },
    body: form.toString(),
  });

  if (!response.ok) throw new Error(`SaveFrom HTTP ${response.status}`);
  const jsResponse = await response.text();

  let resultData = null;
  let errorMessage = null;

  const sfMock = {
    videoResult: {
      show: (res) => { resultData = res; },
      showRows: (res) => { resultData = res; },
    },
    finishRequest: () => {},
    enableElement: () => {},
    result: {
      show: (res) => {
        if (res && res.success === false) errorMessage = res.html || "No links";
        else resultData = res;
      },
      showEmptyResult: (res) => {
        errorMessage = (res && res.html) || "Empty result";
      },
    },
  };

  const context = {
    window: null,
    location: { hostname: "en.savefrom.net" },
    frameElement: {},
    atob: (b64) => Buffer.from(b64, "base64").toString(),
    _decodeURIComponent: (uri) => decodeURIComponent(uri),
  };
  context.window = context;
  context.parent = {
    sf: sfMock,
    document: {
      location: { hostname: "en.savefrom.net" },
      getElementById: () => ({ innerHTML: "mock" }),
      body: { firstChild: null, removeChild: () => {} },
    },
  };
  context.document = context.parent.document;

  vm.createContext(context);
  new vm.Script(`decodeURIComponent=_decodeURIComponent;${jsResponse}`).runInContext(context);

  if (errorMessage) throw new Error(errorMessage.replace(/<[^>]*>/g, ""));
  if (!resultData) throw new Error("SaveFrom parse failed");

  const medias = [];
  if (Array.isArray(resultData.url)) {
    resultData.url.forEach((item) => {
      if (item.url) {
        const q = item.quality ? `${item.quality}p` : item.subname || "SD";
        const ext = item.ext || item.type || "mp4";
        medias.push({
          url: item.url,
          quality: q,
          extension: ext,
          type: ext === "mp3" || ext === "m4a" ? "audio" : "video",
          label: `${q} (${ext.toUpperCase()})`,
        });
      }
    });
  }

  if (medias.length === 0) throw new Error("SaveFrom returned 0 links");

  return {
    source: "savefrom",
    platform: resultData.hosting || "Media",
    title: resultData.meta?.title || "Media Download",
    thumbnail: resultData.thumb || "",
    medias,
  };
}

// ==========================================
// 3. Y2MATE RESOLVER (YouTube)
// ==========================================
function makeHttpsRequest(urlStr, method, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function resolveY2mate(videoId) {
  let title = "YouTube Video";
  try {
    const metaRes = await makeHttpsRequest(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      "GET"
    );
    if (metaRes.statusCode === 200) {
      const meta = JSON.parse(metaRes.body);
      if (meta.title) title = meta.title;
    }
  } catch {}

  const keyRes = await makeHttpsRequest("https://cnv.cx/v2/sanity/key", "GET", {
    "Content-Type": "application/json",
    Origin: "https://frame.y2meta-uk.com",
    Referer: `https://frame.y2meta-uk.com/wwwindex.php?videoId=${videoId}`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
  });
  if (keyRes.statusCode !== 200) {
    throw new Error(`Y2mate key HTTP ${keyRes.statusCode}`);
  }

  const sanityKey = JSON.parse(keyRes.body).key;
  if (!sanityKey) throw new Error("Y2mate sanity key missing");

  const presets = [
    { format: "mp4", videoQuality: "720", audioBitrate: "128", label: "720p HD" },
    { format: "mp4", videoQuality: "360", audioBitrate: "128", label: "360p SD" },
    { format: "mp3", videoQuality: "720", audioBitrate: "320", label: "320kbps MP3" },
  ];

  const results = await Promise.allSettled(
    presets.map(async (p) => {
      const body = querystring.stringify({
        link: `https://youtu.be/${videoId}`,
        format: p.format,
        audioBitrate: p.audioBitrate,
        videoQuality: p.videoQuality,
        filenameStyle: "pretty",
        vCodec: "h264",
      });

      const res = await makeHttpsRequest(
        "https://cnv.cx/v2/converter",
        "POST",
        {
          "Content-Type": "application/x-www-form-urlencoded",
          key: sanityKey,
          "Content-Length": Buffer.byteLength(body),
          Origin: "https://frame.y2meta-uk.com",
          Referer: `https://frame.y2meta-uk.com/wwwindex.php?videoId=${videoId}`,
        },
        body
      );

      if (res.statusCode !== 200) return null;
      const data = JSON.parse(res.body);
      if (!data || !data.url) return null;

      return {
        url: data.url,
        quality: p.label,
        extension: p.format,
        type: p.format === "mp3" ? "audio" : "video",
        label: `${p.label} (${p.format.toUpperCase()})`,
      };
    })
  );

  const medias = results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);

  if (medias.length === 0) throw new Error("Y2mate returned no streams");

  return {
    source: "y2mate",
    platform: "YouTube",
    title,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    medias,
  };
}

// ==========================================
// 4. VERCEL SERVERLESS HANDLER
// ==========================================
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  const baseApiUrl = `${proto}://${host}/api/download`;

  // Streaming Proxy for OmDown session-locked files (bypasses 4.5MB buffer limit)
  if (req.query.proxy === "1") {
    const target = req.query.url;
    const ck = req.query.ck || "";
    if (!target) return res.status(400).json({ error: "Missing target url" });

    try {
      const upstream = await fetch(target, {
        headers: {
          "User-Agent": DEFAULT_UA,
          Referer: `${OMDOWN_BASE}/id`,
          Cookie: ck,
          Accept: "*/*",
        },
      });
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type");
      const cd = upstream.headers.get("content-disposition");
      const cl = upstream.headers.get("content-length");
      if (ct) res.setHeader("Content-Type", ct);
      if (cd) res.setHeader("Content-Disposition", cd);
      if (cl) res.setHeader("Content-Length", cl);

      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const targetUrl = req.query.url || (req.body && req.body.url);
  if (!targetUrl) {
    return res.status(200).json({
      status: "online",
      usage: `${baseApiUrl}?url=VIDEO_URL`,
    });
  }

  const errors = [];
  const ytId = extractVideoId(targetUrl);

  // 1. Try OmDown first
  try {
    const omData = await resolveOmdown(targetUrl, baseApiUrl);
    if (omData.medias && omData.medias.length > 0) {
      return res.status(200).json(omData);
    }
  } catch (err) {
    errors.push(`OmDown: ${err.message}`);
  }

  // 2. Try Y2mate for YouTube
  if (ytId) {
    try {
      const ytData = await resolveY2mate(ytId);
      return res.status(200).json(ytData);
    } catch (err) {
      errors.push(`Y2mate: ${err.message}`);
    }
  }

  // 3. Try SaveFrom fallback
  try {
    const sfData = await resolveSaveFrom(targetUrl);
    return res.status(200).json(sfData);
  } catch (err) {
    errors.push(`SaveFrom: ${err.message}`);
  }

  return res.status(500).json({ error: errors.join(" | ") });
};
