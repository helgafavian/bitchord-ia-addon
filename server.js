// BitChord addon — Internet Archive FLAC source
// Rute: GET /manifest.json, GET /search?q=..., GET /stream/:id
// Tanpa akun, tanpa API key. Hanya berkomunikasi dengan archive.org.

import express from "express";

const app = express();
const PORT = process.env.PORT || 8787;
const ITEMS_PER_SEARCH = Number(process.env.ITEMS_PER_SEARCH || 8);

const MANIFEST = {
  id: "in.santiago.ia-flac-addon",
  name: "Internet Archive FLAC",
  version: "1.0.0",
  resources: ["search", "stream"],
  allowDownloads: 1,
  checkValidLossless: 0,
};

const searchCache = new Map();
const metaCache = new Map();
const SEARCH_TTL = 5 * 60 * 1000;
const META_TTL = 30 * 60 * 1000;

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  return null;
}
function cacheSet(map, key, value) {
  map.set(key, { at: Date.now(), value });
}

// Identifier archive.org hanya boleh berisi karakter aman ini.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

async function iaAdvancedSearch(q) {
  const url = new URL("https://archive.org/advancedsearch.php");
  url.searchParams.set("q", `mediatype:(audio) AND format:(FLAC) AND (${q})`);
  url.searchParams.set("fl[]", "identifier");
  url.searchParams.append("fl[]", "title");
  url.searchParams.append("fl[]", "creator");
  url.searchParams.set("rows", String(ITEMS_PER_SEARCH));
  url.searchParams.set("page", "1");
  url.searchParams.set("output", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": "bitchord-ia-addon/1.0" },
  });
  if (!res.ok) throw new Error(`advancedsearch ${res.status}`);
  const json = await res.json();
  return json?.response?.docs ?? [];
}

async function iaMetadata(identifier) {
  const cached = cacheGet(metaCache, identifier, META_TTL);
  if (cached) return cached;

  const res = await fetch(
    `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
    { headers: { "User-Agent": "bitchord-ia-addon/1.0" } }
  );
  if (!res.ok) throw new Error(`metadata ${res.status}`);
  const json = await res.json();
  const value = { item: json?.metadata ?? {}, files: json?.files ?? [] };
  cacheSet(metaCache, identifier, value);
  return value;
}

function parseDurationSeconds(length) {
  if (!length) return undefined;
  if (/^[\d.]+$/.test(length)) return Math.round(Number(length));
  const parts = length.split(":").map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function stripExt(name) {
  return name.replace(/\.[^./]+$/, "");
}

function encodeTrackId(identifier, filename) {
  return Buffer.from(`${identifier}::${filename}`, "utf8").toString("base64url");
}
function decodeTrackId(id) {
  const raw = Buffer.from(id, "base64url").toString("utf8");
  const sep = raw.indexOf("::");
  if (sep === -1) return null;
  return { identifier: raw.slice(0, sep), filename: raw.slice(sep + 2) };
}

function artworkFor(identifier) {
  return `https://archive.org/services/img/${identifier}`;
}

function tracksFromItem(identifier, item, files) {
  const flacFiles = files.filter(
    (f) => typeof f.format === "string" && /flac/i.test(f.format)
  );
  return flacFiles.map((f) => ({
    id: encodeTrackId(identifier, f.name),
    title: f.title || stripExt(f.name),
    artist: f.artist || item.creator || "Unknown artist",
    album: f.album || item.title || identifier,
    duration: parseDurationSeconds(f.length),
    artworkURL: artworkFor(identifier),
    format: "flac",
    audioQuality: "LOSSLESS",
  }));
}

app.get("/manifest.json", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(MANIFEST);
});

app.get("/search", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ tracks: [] });

  const cached = cacheGet(searchCache, q, SEARCH_TTL);
  if (cached) return res.json({ tracks: cached });

  try {
    const docs = await iaAdvancedSearch(q);
    const results = await Promise.all(
      docs.map(async (doc) => {
        try {
          if (!SAFE_ID.test(doc.identifier)) return [];
          const { item, files } = await iaMetadata(doc.identifier);
          return tracksFromItem(doc.identifier, item, files);
        } catch {
          return [];
        }
      })
    );
    const tracks = results.flat();
    cacheSet(searchCache, q, tracks);
    res.json({ tracks });
  } catch (err) {
    console.error("search failed:", err);
    res.json({ tracks: [] });
  }
});

app.get("/stream/:id", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const decoded = decodeTrackId(req.params.id);
  if (!decoded) return res.status(404).end();

  const { identifier, filename } = decoded;
  if (!SAFE_ID.test(identifier)) return res.status(404).end();

  try {
    const { files } = await iaMetadata(identifier);
    const file = files.find((f) => f.name === filename);
    if (!file) return res.status(404).end();

    const url = `https://archive.org/download/${identifier}/${encodeURIComponent(
      filename
    )}`;

    res.json({
      url,
      format: "flac",
      quality: "Lossless · FLAC",
      codec: "flac",
      container: "flac",
      manifest: "none",
      encrypted: false,
    });
  } catch (err) {
    console.error("stream failed:", err);
    res.status(404).end();
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`bitchord-ia-addon listening on :${PORT}`);
});
