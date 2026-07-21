// Built plugin entry — runs in an isolated child process.
const { definePlugin } = require('trek-plugin-sdk');

const OTM_BASE = 'https://api.opentripmap.com/0.1/en/places';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The host enforces a per-plugin RPC rate limit at the ctx.* dispatch boundary (token bucket:
// burst 60, refill 20/s) — a bulk loop that fires many ctx.* calls back-to-back for a large
// guide/trip can blow through the burst allowance in well under a second. Used as the pacing
// gap wherever a loop can't be collapsed into a single ctx.db.tx() batch (host-managed calls
// like ctx.places.create/ctx.days.create/ctx.itinerary.assign aren't the plugin's own db, so
// they can't be batched that way) — keeps steady-state throughput under the 20/s refill rate.
const RATE_LIMIT_GAP_MS = 60;

function json(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function error(status, message) {
  return json(status, { error: message });
}

function requireAdmin(req) {
  if (!req.user || !req.user.isAdmin) return error(403, 'Admin only');
  return null;
}

function parseTips(raw) {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string' && t.trim()).slice(0, 20);
  return [];
}

// Takes an already-resolved API key rather than ctx + fetching it itself — ctx.settings.get is
// itself a ctx.* call subject to the host's per-plugin RPC rate limit, and geocodePlacesViaOtm
// below can call this many times in one request; resolving the key once per request/route and
// passing it through avoids re-spending a rate-limited call on the same unchanging value.
async function otmFetch(apiKey, path) {
  if (!apiKey) throw new Error('Set your OpenTripMap API key in this plugin\'s settings first.');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${OTM_BASE}${path}${sep}apikey=${encodeURIComponent(apiKey)}`);
  if (!res.ok) throw new Error(`OpenTripMap request failed (${res.status})`);
  return res.json();
}

// Auto-fetched OpenTripMap/Wikimedia thumbnails are pulled server-side (fetch() inside the
// plugin's own child process) and never pass through the browser->host request body at all,
// so they aren't subject to the cap below — this one only bounds the plugin's own db:own size.
const MAX_PHOTO_BYTES = 1_500_000;
// Admin image UPLOADS, by contrast, arrive as a POST body from the browser through the host's
// own request-body proxy — which has its own size cap this plugin doesn't control. A real
// upload was refused with a 413 at ~105KB total; confirmed exactly (via a sibling TREK plugin
// that traced it to TREK's own source): the host's global middleware sets
// `express.json({limit:'100kb'})`, forwarded as-is by the plugin-route proxy — 102,400 bytes for
// the ENTIRE JSON request body, every field included, not just this one. MAX_UPLOAD_BYTES is
// compared against dataUriByteSize()'s return value below, which must be the base64 (wire) byte
// count, not a decoded-image-byte estimate — comparing a `base64.length * 0.75`-style decoded
// estimate against a wire-byte budget understates the real cost by ~33% and quietly eats most of
// the "margin" the number implies (a mistake a sibling plugin independently hit and fixed).
const MAX_UPLOAD_BYTES = 60_000;

async function fetchPhotoDataUri(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PHOTO_BYTES) return null;
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// The base64 payload's own character count IS the wire-byte cost (each base64 char is one ASCII
// byte in the JSON request body) — return that directly rather than converting to a decoded-image
// byte estimate (`* 3/4`), which would understate what actually crosses the wire. See the comment
// on MAX_UPLOAD_BYTES above.
function dataUriByteSize(dataUri) {
  const comma = dataUri.indexOf(',');
  const b64 = comma === -1 ? dataUri : dataUri.slice(comma + 1);
  return b64.length;
}

// ctx.collections methods don't return a guaranteed bare array on every host — probe
// the common wrapper shapes ({items:[]}, {collections:[]}, {data:[]}, {results:[]})
// before giving up. A host that hands back something genuinely unrecognized degrades to
// an empty list instead of throwing.
function toArray(maybeArray) {
  if (Array.isArray(maybeArray)) return maybeArray;
  if (!maybeArray || typeof maybeArray !== 'object') return [];
  for (const key of ['items', 'collections', 'places', 'data', 'results']) {
    if (Array.isArray(maybeArray[key])) return maybeArray[key];
  }
  return [];
}

// Same idea, specifically for pulling the place list out of whatever ctx.collections.get()
// hands back — it may be the collection object directly, or wrapped one or two levels deeper,
// under a key name we can't predict. Scan for a `.places` array at the top level or one
// level down, or fall back to a common list-wrapper key holding the places directly.
function collectionPlacesOf(collection) {
  if (!collection || typeof collection !== 'object') return [];
  if (Array.isArray(collection.places)) return collection.places;
  for (const key of Object.keys(collection)) {
    const val = collection[key];
    if (!val || typeof val !== 'object') continue;
    if (Array.isArray(val) && ['places', 'items', 'results', 'data'].includes(key)) return val;
    if (Array.isArray(val.places)) return val.places;
  }
  return [];
}

// ---- PDF import (Mindtrip-style "inspiration" exports and similar) ----
// The client extracts raw text from the PDF locally (via bundled pdf.js — plugins can't add
// npm deps at runtime, so it's vendored as a static asset) and posts just the text here.
// Title/location/overview are pulled with plain text heuristics (Mindtrip's export format is
// consistent enough for this); the actual list of places is handed to ctx.ai.extract, which
// uses the admin's own configured AI provider — the plugin never sees or holds a key.
const MAX_PDF_TEXT_CHARS = 16_000; // stay well under ai:invoke's 20,000-char cap

const PDF_PLACE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    category: { type: 'string' },
    address: { type: 'string' },
    description: { type: 'string' },
    dayNumber: { type: 'number' },
    tips: { type: 'array', items: { type: 'string' } },
  },
  required: ['name'],
};

const PDF_PLACE_PROMPT = [
  'This text was extracted from a travel guide PDF (place names, categories, addresses,',
  'descriptions, and sometimes a day-by-day itinerary). Extract every real named place,',
  'attraction, hotel, restaurant, trailhead, or point of interest as a separate item, in the',
  'order they appear. For each: name; category (e.g. Attraction, Hotel, Restaurant, Airport,',
  'Hostel); address if one is given; a short description folding in any personal tips or notes',
  'about it; dayNumber if the guide organizes places under headings like "Day 1" / "Day 2" (omit',
  'dayNumber entirely if the guide has no day structure); and a tips array for short bullet-point',
  'style advice. Do NOT extract sections about currency exchange, credit cards, visas, gas',
  'stations in general, flight booking sites, or other affiliate/referral links — only actual',
  'named places someone could visit or stay at.',
].join(' ');

function firstNonEmptyLines(text, n) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n);
}

// Best-effort title/location/overview from plain text — Mindtrip's own export layout is
// consistent enough (title line, then a short location line, then "Author | N places",
// then an "Overview" section) that simple heuristics do fine without spending an AI call on it.
function guessGuideMetaFromText(text) {
  const lines = firstNonEmptyLines(text, 8);
  const title = (lines[0] || 'Imported guide').slice(0, 200);
  let location = null;
  if (lines[1] && lines[1].length < 60 && !lines[1].includes('|') && !/^updated:/i.test(lines[1])) {
    location = lines[1].slice(0, 200);
  }
  let description = null;
  const overviewIdx = text.search(/\boverview\b/i);
  if (overviewIdx !== -1) {
    const after = text.slice(overviewIdx + 8);
    const nextHeading = after.search(/\n\s*(places and experiences|know before you go|day\s*\d+)\b/i);
    description = (nextHeading === -1 ? after : after.slice(0, nextHeading)).trim().slice(0, 2000) || null;
  }
  return { title, location, description };
}

// ---- Static (no-AI) fallback extraction ----
// Mindtrip's own export layout is consistent enough to parse deterministically: a place entry
// is a NAME line immediately followed by a line that's exactly one of a known category word —
// that two-line lookahead is specific enough to rarely false-positive on ordinary prose. Used
// whenever ctx.ai is unavailable, or ctx.ai.extract fails for any reason — an admin without an
// AI provider configured (or a host that doesn't support ai:invoke) still gets a usable import,
// just a less capable one than the AI path.
const CATEGORY_WORDS = new Set([
  'airport', 'attraction', 'hotel', 'hostel', 'restaurant', 'location', 'guesthouse',
  'guest house', 'apartment', 'apartments', 'cafe', 'café', 'bar', 'museum', 'park',
  'beach', 'trail', 'viewpoint', 'campsite', 'gas station', 'supermarket', 'shop', 'spa',
  'lighthouse', 'church', 'bakery', 'winery', 'brewery', 'landmark', 'monument', 'other',
]);

function looksLikeAddress(line) {
  return /\d/.test(line) && line.length < 120 && (line.includes(',') || /\b(street|st\.|road|rd\.|ave|avenue)\b/i.test(line));
}

function looksLikePhone(line) {
  return /^[+(]?[\d\s().+-]{7,20}$/.test(line.trim());
}

function extractPlacesStatically(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const places = [];
  let dayNumber = null;
  let i = 0;
  while (i < lines.length) {
    const dayMatch = lines[i].match(/^day\s+(\d+)\b/i);
    if (dayMatch) { dayNumber = Number(dayMatch[1]); i++; continue; }

    const nextLower = (lines[i + 1] || '').toLowerCase();
    const isPlaceStart = lines[i].length > 1 && lines[i].length < 200 && CATEGORY_WORDS.has(nextLower);
    if (isPlaceStart) {
      const name = lines[i];
      const category = lines[i + 1];
      let j = i + 2;
      let address = null;
      if (lines[j] && looksLikeAddress(lines[j])) { address = lines[j]; j++; }
      if (lines[j] && looksLikePhone(lines[j])) j++; // skip phone numbers — no field for them

      const descLines = [];
      while (j < lines.length) {
        if (/^day\s+\d+\b/i.test(lines[j])) break;
        if (lines[j].length < 200 && CATEGORY_WORDS.has((lines[j + 1] || '').toLowerCase())) break; // next place starts here
        descLines.push(lines[j]);
        j++;
        if (descLines.join(' ').length > 1500) break; // safety cap on a single runaway entry
      }
      places.push({ name, category, address, description: descLines.join(' ').trim() || null, dayNumber });
      i = j;
      if (places.length >= 300) break; // sanity cap against pathological input
      continue;
    }
    i++;
  }
  return places;
}

// Sanitizes one AI-extracted place item the same way validateBlockData('place', ...) would —
// AI output is data-only and untrusted, so every field is type-checked and length-capped before
// it's allowed anywhere near a block.
function sanitizePdfPlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.name && String(raw.name).trim().slice(0, 200);
  if (!name) return null;
  const dayNumber = Number(raw.dayNumber);
  return {
    name,
    category: raw.category ? String(raw.category).trim().slice(0, 100) : null,
    address: raw.address ? String(raw.address).trim().slice(0, 500) : null,
    description: raw.description ? String(raw.description).trim().slice(0, 2000) : null,
    tips: parseTips(raw.tips),
    dayNumber: Number.isInteger(dayNumber) && dayNumber > 0 && dayNumber <= 366 ? dayNumber : null,
  };
}

// Loose name matching between a PDF-extracted place name and an OpenTripMap POI name — good
// enough for "Blue Lagoon" vs "The Blue Lagoon Iceland", not a fuzzy/edit-distance match.
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function namesLooselyMatch(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || (na.length >= 4 && nb.includes(na)) || (nb.length >= 4 && na.includes(nb));
}

// Best-effort coordinates for PDF-imported places, which start with none at all (a Mindtrip
// export is names/addresses/photos, never lat/lon). Reuses the exact OpenTripMap calls already
// proven by the manual search-and-import flow: one /geoname to find the guide's destination
// center, one /radius sweep of everything nearby, then a local name match per place — a /xid/
// detail fetch (the same one manual import uses) gets the real point for each match. No API
// key configured, no destination match, or no nearby name match all just mean fewer (or zero)
// places end up with coordinates; the import itself never fails because of this.
const MAX_OTM_DETAIL_FETCHES_PER_CALL = 25;
async function geocodePlacesViaOtm(ctx, places, guideLocationHint) {
  if (!places.length || !guideLocationHint) return 0;
  // Resolve the key once for this whole pass — otmFetch used to pull it (a ctx.* call) on every
  // single request, which meant one extra rate-limited call per matched place on top of the
  // geoname + radius calls; a 28-place guide made this worse, not better.
  let apiKey;
  try {
    apiKey = await ctx.settings.get('opentripmap_api_key');
  } catch {
    return 0; // e.g. a transient rate-limit hiccup on this one call — geocoding is best-effort, never worth failing the whole import over
  }
  if (!apiKey) return 0;
  let center;
  try {
    const geo = await otmFetch(apiKey, `/geoname?name=${encodeURIComponent(guideLocationHint)}`);
    if (!geo || typeof geo.lat !== 'number' || typeof geo.lon !== 'number') return 0;
    center = geo;
  } catch {
    return 0;
  }
  let nearby;
  try {
    const radius = await otmFetch(apiKey, `/radius?radius=50000&lon=${center.lon}&lat=${center.lat}&rate=1&format=json&limit=500`);
    nearby = Array.isArray(radius) ? radius.filter((p) => p.name && p.xid) : [];
  } catch {
    return 0;
  }
  if (!nearby.length) return 0;
  let matched = 0;
  let detailFetches = 0;
  for (const p of places) {
    const hit = nearby.find((n) => namesLooselyMatch(n.name, p.name));
    if (!hit) continue;
    // Unlike the Nominatim pass, OTM has no mandated pacing between calls, so this loop has no
    // sleep — but with no cap at all, a chunk/guide where most places happen to name-match could
    // still fire enough sequential /xid/ fetches to approach the browser bridge's own ~8s
    // round-trip timeout (see the comment on MAX_NOMINATIM_LOOKUPS_PER_CALL). Bounding it here too
    // keeps the worst case sane; anything past the cap just stays uncoordinated, same as a miss.
    if (++detailFetches > MAX_OTM_DETAIL_FETCHES_PER_CALL) break;
    try {
      const detail = await otmFetch(apiKey, `/xid/${encodeURIComponent(hit.xid)}`);
      if (detail && detail.point && typeof detail.point.lat === 'number' && typeof detail.point.lon === 'number') {
        p.lat = detail.point.lat;
        p.lon = detail.point.lon;
        matched++;
      }
    } catch {
      // skip this one, keep going
    }
  }
  return matched;
}

// Nominatim (OpenStreetMap's free, keyless geocoder) — the fallback for a place the OTM name-
// match pass above couldn't place. /geoname resolves named toponyms (cities, landmarks), not
// arbitrary street addresses, so a PDF-imported place whose only location info is an address
// (no matching OpenTripMap POI by that exact name) never gets coordinates from geocodePlacesViaOtm
// alone — Nominatim does structured address lookups instead. Its public usage policy caps this at
// roughly one request/second and requires an identifying User-Agent (no API key, but not for bulk/
// scraping use).
//
// MAX_NOMINATIM_LOOKUPS_PER_CALL is deliberately small (not just "under the 30s route timeout")
// because of a confirmed-real constraint that's tighter and separate from that: the browser's own
// trek:invoke bridge enforces its own ~8-second round-trip timeout, independent of the server's
// 30s execution budget — confirmed against a real TREK instance by a sibling plugin (symptom:
// "timeout of 8000ms exceeded" on the client while the route was still well inside its own 30s
// allowance). At the old cap of 15, this pass alone could take 15 * NOMINATIM_MIN_GAP_MS = 16.5s
// — comfortably past that ceiling on its own, before counting AI extraction, the OTM sweep, or DB
// writes sharing the same request. Any place past the cap simply stays without coordinates for
// this call — /guide/fix-missing-coords (below) is the one place that needs to get through more
// than a handful, and it does that by looping this same small cap across several requests instead
// of raising it.
const NOMINATIM_MIN_GAP_MS = 1100;
const NOMINATIM_FETCH_TIMEOUT_MS = 3000; // a single hanging request must not consume the whole per-call budget on its own
const MAX_NOMINATIM_LOOKUPS_PER_CALL = 4;

async function nominatimGeocodeAddress(address) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOMINATIM_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`,
        { headers: { 'User-Agent': 'TREK-FeaturedGuides-plugin (self-hosted trip planner)' }, signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const results = await res.json();
    const hit = Array.isArray(results) ? results[0] : null;
    if (!hit) return null;
    const lat = Number(hit.lat), lon = Number(hit.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  } catch {
    return null;
  }
}

// Mutates `places` in place (same contract as geocodePlacesViaOtm) — only touches entries that
// still have no lat/lon and do have an address to try, so it's safe to always run right after
// the OTM pass regardless of how many places that pass already handled. Returns how many of the
// eligible places were left untouched past the per-call cap, so a caller that needs to get
// through more than that (see /guide/fix-missing-coords) knows there's another round to do.
async function geocodeMissingByAddress(places) {
  const eligible = places.filter((p) => p.address && !(typeof p.lat === 'number' && typeof p.lon === 'number'));
  const candidates = eligible.slice(0, MAX_NOMINATIM_LOOKUPS_PER_CALL);
  let matched = 0;
  for (const p of candidates) {
    const hit = await nominatimGeocodeAddress(p.address);
    if (hit) { p.lat = hit.lat; p.lon = hit.lon; matched++; }
    await sleep(NOMINATIM_MIN_GAP_MS);
  }
  return { matched, remaining: Math.max(0, eligible.length - candidates.length) };
}

// Runs the admin's AI provider (or the deterministic static fallback) over one chunk of
// extracted PDF text — shared by the initial /guide/import-pdf call and every subsequent
// /guide/import-pdf/append chunk of the same import.
async function extractPdfPlacesChunk(ctx, text) {
  let places, usedAi = false, aiFallbackReason = null;
  if (ctx.ai) {
    try {
      const extracted = await ctx.ai.extract(text, PDF_PLACE_SCHEMA, PDF_PLACE_PROMPT);
      places = toArray(extracted && extracted.results).map(sanitizePdfPlace).filter(Boolean);
      usedAi = true;
    } catch (e) {
      aiFallbackReason = String(e && e.message || e);
      ctx.log.warn('guide/import-pdf: ai.extract failed, falling back to static parsing', { message: aiFallbackReason });
    }
  } else {
    aiFallbackReason = 'This TREK instance does not support ai:invoke.';
  }
  if (!usedAi) places = extractPlacesStatically(text).map(sanitizePdfPlace).filter(Boolean);
  return { places, usedAi, aiFallbackReason };
}

// Inserts one chunk's extracted places (and the day-header blocks between them) starting at
// `startPos`, continuing from `carryDay` — the last day number seen in a previous chunk of the
// same import, or null for the first chunk — so a day's place list that happens to span a chunk
// boundary doesn't get a duplicate "Day N" block inserted partway through it. Shared by the
// initial import and every append call.
async function insertPdfPlaceBlocks(ctx, guideId, places, startPos, carryDay) {
  let pos = startPos;
  let lastDay = carryDay != null ? carryDay : undefined;
  let dayBlocksInserted = 0;
  let placesInserted = 0;
  const ops = [];
  for (const p of places) {
    if (p.dayNumber != null && p.dayNumber !== lastDay) {
      ops.push({
        sql: 'INSERT INTO guide_blocks (guide_id, type, position, data) VALUES (?, ?, ?, ?)',
        args: [guideId, 'day', pos++, JSON.stringify({ dayNumber: p.dayNumber, title: null })],
      });
      lastDay = p.dayNumber;
      dayBlocksInserted++;
    }
    const normalized = validateBlockData('place', { ...p, source: 'pdf-import' });
    if (typeof normalized === 'string') continue; // shouldn't happen — sanitizePdfPlace guarantees a name — but never abort the whole import over one bad entry
    ops.push({
      sql: 'INSERT INTO guide_blocks (guide_id, type, position, data) VALUES (?, ?, ?, ?)',
      args: [guideId, 'place', pos++, JSON.stringify(normalized)],
    });
    placesInserted++;
  }
  if (typeof ctx.db.tx === 'function') {
    for (let i = 0; i < ops.length; i += 90) { // tx caps out at 100 ops per call — chunk with margin
      await ctx.db.tx(ops.slice(i, i + 90));
    }
  } else {
    // A host old enough not to have ctx.db.tx yet: fall back to throttled individual inserts.
    for (const op of ops) {
      await ctx.db.exec(op.sql, ...op.args);
      await sleep(RATE_LIMIT_GAP_MS);
    }
  }
  return { pos, lastDay: lastDay != null ? lastDay : null, dayBlocksInserted, placesInserted };
}

// Defensively read a place-like object coming back from ctx.collections.get() — the SDK
// only guarantees `id` on these shapes, so probe the common key variants for the rest.
function collectionPlaceRow(p) {
  return {
    id: p.id,
    name: p.name || p.title || 'Untitled place',
    description: p.description || p.notes || null,
    address: p.address || null,
    category: p.category || null,
    lat: typeof p.lat === 'number' ? p.lat : (typeof p.latitude === 'number' ? p.latitude : null),
    lon: typeof p.lon === 'number' ? p.lon : (typeof p.lng === 'number' ? p.lng : (typeof p.longitude === 'number' ? p.longitude : null)),
  };
}

const TEMPLATES = ['blank', 'list', 'itinerary'];
const BLOCK_TYPES = ['day', 'heading', 'body', 'quote', 'divider', 'image', 'link', 'guide', 'activity', 'place'];
const HEADING_LEVELS = ['normal', 'medium', 'large'];

// Fixed place-category taxonomy — keep in sync with CATEGORIES/CATEGORY_COLORS in client/index.html.
// A place's category rarely arrives already matching one of these: OpenTripMap returns its own
// "kinds" tags, the PDF static parser returns whatever word the export used (hostel, guesthouse,
// gas station, ...), and even AI extraction isn't guaranteed to follow the fixed list. Bucketing
// happens once, centrally, in normalizeCategory() below, so every place — manual, OpenTripMap,
// Collections, PDF/AI, PDF/static — ends up with one of exactly these ten, and the client can
// color-code every place card without having to guess at arbitrary category strings.
const PLACE_CATEGORIES = ['Activity', 'Attraction', 'Bar/Cafe', 'Beach', 'Hotel', 'Nature', 'Other', 'Restaurant', 'Shopping', 'Transport'];
const CATEGORY_KEYWORDS = [
  ['Hotel', ['hotel', 'hostel', 'guesthouse', 'guest house', 'apartment', 'accommodation', 'accomodation', 'lodging', 'resort', 'inn']],
  ['Restaurant', ['restaurant', 'food', 'dining', 'eatery', 'bakery']],
  ['Bar/Cafe', ['bar', 'cafe', 'café', 'pub', 'winery', 'brewery', 'coffee']],
  ['Beach', ['beach', 'coast', 'shore']],
  ['Nature', ['nature', 'natural', 'park', 'trail', 'forest', 'mountain', 'waterfall', 'lake', 'hiking', 'campsite', 'national park', 'wildlife', 'garden']],
  ['Shopping', ['shop', 'shopping', 'mall', 'market', 'supermarket', 'store', 'duty free']],
  ['Transport', ['airport', 'transport', 'station', 'parking', 'bus', 'train', 'ferry', 'gas station', 'car park']],
  ['Activity', ['activity', 'spa', 'amusement', 'sport', 'tour', 'swimming', 'pool', 'entertainment']],
  ['Attraction', ['attraction', 'museum', 'church', 'landmark', 'monument', 'lighthouse', 'viewpoint', 'historic', 'architecture', 'castle', 'palace', 'tourist', 'interesting_places']],
];
function normalizeCategory(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const exact = PLACE_CATEGORIES.find((c) => c.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const low = s.toLowerCase();
  for (const [canonical, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => low.includes(k))) return canonical;
  }
  return 'Other';
}

function guideRow(row) {
  return {
    id: row.id,
    title: row.title,
    location: row.location,
    description: row.description,
    template: row.template || 'blank',
    status: row.status || 'draft',
    placeCount: row.place_count || 0,
    days: row.day_count || null,
    coverPhoto: row.cover_photo || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Resolves each 'guide' (embed) block against the CURRENT state of the guide it references,
// instead of trusting the title/location snapshot captured when the embed was created — a later
// rename of the referenced guide is then reflected everywhere it's embedded. For a non-admin
// viewer, an embed pointing at a guide that isn't published (or has since been deleted) is
// dropped entirely rather than shown with stale/leaked info — the same visibility rule GET
// /guide already enforces for the guide being viewed directly.
async function resolveGuideEmbeds(ctx, blocks, isAdmin) {
  const refIds = [...new Set(blocks.filter((b) => b.type === 'guide').map((b) => b.data.refGuideId).filter((id) => Number.isInteger(id)))];
  if (!refIds.length) return blocks;
  const placeholders = refIds.map(() => '?').join(',');
  const refs = await ctx.db.query(`SELECT id, title, location, status FROM guides WHERE id IN (${placeholders})`, ...refIds);
  const byId = {};
  for (const r of refs) byId[r.id] = r;
  const out = [];
  for (const b of blocks) {
    if (b.type !== 'guide') { out.push(b); continue; }
    const ref = byId[b.data.refGuideId];
    if (!ref || (!isAdmin && ref.status !== 'published')) continue; // nothing to leak
    out.push({ ...b, data: { ...b.data, title: ref.title, location: ref.location } });
  }
  return out;
}

function blockRow(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch { data = {}; }
  return { id: row.id, guideId: row.guide_id, type: row.type, position: row.position, data };
}

// Validates + normalizes a block's `data` payload for its `type`. Returns the normalized
// object on success, or a string error message on failure — the route decides the status code.
function validateBlockData(type, raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  switch (type) {
    case 'day': {
      const dayNumber = Number(d.dayNumber);
      if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 366) return 'dayNumber must be a whole number between 1 and 366';
      return { dayNumber, title: d.title ? String(d.title).slice(0, 200) : null };
    }
    case 'heading': {
      if (!d.text || !String(d.text).trim()) return 'text is required';
      const level = HEADING_LEVELS.includes(d.level) ? d.level : 'normal';
      return { text: String(d.text).trim().slice(0, 200), level };
    }
    case 'body':
      if (!d.text || !String(d.text).trim()) return 'text is required';
      return { text: String(d.text).trim().slice(0, 5000) };
    case 'quote':
      if (!d.text || !String(d.text).trim()) return 'text is required';
      return { text: String(d.text).trim().slice(0, 1000), attribution: d.attribution ? String(d.attribution).slice(0, 200) : null };
    case 'divider':
      return {};
    case 'image': {
      if (!d.dataUri || typeof d.dataUri !== 'string' || !d.dataUri.startsWith('data:image/')) return 'Choose an image file first.';
      if (dataUriByteSize(d.dataUri) > MAX_UPLOAD_BYTES) return `That image is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1000)}KB) — try a smaller or simpler photo.`;
      return { dataUri: d.dataUri, caption: d.caption ? String(d.caption).slice(0, 200) : null };
    }
    case 'link': {
      const url = String(d.url || '');
      if (!/^https?:\/\//i.test(url)) return 'url must start with http:// or https://';
      return { url: url.slice(0, 2000), label: d.label ? String(d.label).slice(0, 200) : null };
    }
    case 'guide': {
      const refGuideId = Number(d.refGuideId);
      if (!Number.isInteger(refGuideId)) return 'refGuideId is required';
      return { refGuideId, title: d.title || null, location: d.location || null };
    }
    case 'activity':
      if (!d.name || !String(d.name).trim()) return 'name is required';
      return {
        name: String(d.name).trim().slice(0, 200),
        description: d.description ? String(d.description).slice(0, 2000) : null,
        tips: parseTips(d.tips),
      };
    case 'place':
      if (!d.name || !String(d.name).trim()) return 'name is required';
      return {
        name: String(d.name).trim().slice(0, 200),
        category: normalizeCategory(d.category),
        description: d.description ? String(d.description).slice(0, 2000) : null,
        address: d.address ? String(d.address).slice(0, 500) : null,
        lat: typeof d.lat === 'number' ? d.lat : null,
        lon: typeof d.lon === 'number' ? d.lon : null,
        rating: Number.isInteger(d.rating) ? d.rating : null,
        tips: parseTips(d.tips),
        photoDataUri: d.photoDataUri || null,
        source: d.source || 'manual',
        xid: d.xid || null,
      };
    default:
      return `unknown block type "${type}"`;
  }
}

// Builds the ctx.places.create() input from a place/activity block's data — shared by the
// single "Add to trip" action and the bulk "Plan a trip" import.
function placeCreateInput(p) {
  const descriptionParts = [];
  if (p.description) descriptionParts.push(p.description);
  if (p.rating) descriptionParts.push(`Rating: ${p.rating}/7`);
  const input = {
    name: p.name,
    description: descriptionParts.join('\n\n') || undefined,
    address: p.address || undefined,
  };
  // ctx.places.create's real accepted field names for coordinates aren't documented (like
  // costs.create's total_price-not-amount surprise), and a zod schema silently drops any
  // key it doesn't recognize — no error, the place just saves without that coordinate. We
  // saw exactly that: latitude landed, longitude quietly vanished. Send every plausible key
  // variant for both axes; only the real ones get kept, the rest are no-ops.
  if (typeof p.lat === 'number') { input.lat = p.lat; input.latitude = p.lat; }
  if (typeof p.lon === 'number') { input.lon = p.lon; input.lng = p.lon; input.longitude = p.lon; }
  return input;
}

// Extracts a display-ready photo from a place/image block's data, for guide-list cover art.
function blockPhoto(type, data) {
  if (type === 'place' && data.photoDataUri) return data.photoDataUri;
  if (type === 'image' && data.dataUri) return data.dataUri;
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
}

function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startStr, endStr) {
  const ms = new Date(endStr + 'T00:00:00Z').getTime() - new Date(startStr + 'T00:00:00Z').getTime();
  return Math.round(ms / 86400000);
}

async function nextPosition(ctx, guideId) {
  const rows = await ctx.db.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM guide_blocks WHERE guide_id = ?', guideId);
  return rows[0] ? rows[0].next : 0;
}

async function insertBlock(ctx, guideId, type, data, position) {
  await ctx.db.exec(
    'INSERT INTO guide_blocks (guide_id, type, position, data) VALUES (?, ?, ?, ?)',
    guideId, type, position, JSON.stringify(data)
  );
  const rows = await ctx.db.query('SELECT * FROM guide_blocks WHERE id = last_insert_rowid()');
  return blockRow(rows[0]);
}

// Bulk-creates `count` day blocks (dayNumber 1..count) starting at `startPos`, batched via
// ctx.db.tx() same as insertPdfPlaceBlocks/the reorder route — used wherever a template switches
// to "itinerary" and pre-creates its day shape (guide creation, and the same transition from the
// edit view), so a 60-day itinerary doesn't turn into 60+ sequential unbatched ctx.* calls.
async function insertDayBlocks(ctx, guideId, count, startPos) {
  const ops = [];
  for (let i = 1; i <= count; i++) {
    ops.push({
      sql: 'INSERT INTO guide_blocks (guide_id, type, position, data) VALUES (?, ?, ?, ?)',
      args: [guideId, 'day', startPos + i - 1, JSON.stringify({ dayNumber: i, title: null })],
    });
  }
  if (typeof ctx.db.tx === 'function') {
    for (let i = 0; i < ops.length; i += 90) {
      await ctx.db.tx(ops.slice(i, i + 90));
    }
  } else {
    for (const op of ops) {
      await ctx.db.exec(op.sql, ...op.args);
      await sleep(RATE_LIMIT_GAP_MS);
    }
  }
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_init', `
      CREATE TABLE IF NOT EXISTS guides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        location TEXT,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS guide_places (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guide_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        category TEXT,
        description TEXT,
        address TEXT,
        lat REAL,
        lon REAL,
        rating INTEGER,
        day_number INTEGER,
        day_title TEXT,
        tips TEXT,
        xid TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    await ctx.db.migrate('002_photos', `ALTER TABLE guide_places ADD COLUMN photo_data_uri TEXT;`);
    await ctx.db.migrate('003_template', `
      ALTER TABLE guides ADD COLUMN template TEXT NOT NULL DEFAULT 'blank';
      ALTER TABLE guides ADD COLUMN day_count INTEGER;
    `);
    await ctx.db.migrate('004_blocks', `
      ALTER TABLE guides ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
      CREATE TABLE IF NOT EXISTS guide_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guide_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        position INTEGER NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // One-time data migration: fold the old flat guide_places rows into the new block
    // model, so content created before this update isn't stranded. Guarded by a plain
    // count check (not ctx.db.migrate, which only runs static SQL) — safe to leave in
    // place permanently since it's a no-op once guide_blocks has anything in it.
    const [{ blockCount }] = await ctx.db.query('SELECT COUNT(*) AS blockCount FROM guide_blocks');
    const [{ placeCount }] = await ctx.db.query('SELECT COUNT(*) AS placeCount FROM guide_places');
    if (blockCount === 0 && placeCount > 0) {
      const guides = await ctx.db.query('SELECT id FROM guides');
      for (const g of guides) {
        const places = await ctx.db.query(
          'SELECT * FROM guide_places WHERE guide_id = ? ORDER BY (day_number IS NOT NULL) ASC, day_number ASC, id ASC',
          g.id
        );
        let pos = 0;
        let lastDay = undefined;
        for (const p of places) {
          if (p.day_number != null && p.day_number !== lastDay) {
            await insertBlock(ctx, g.id, 'day', { dayNumber: p.day_number, title: p.day_title || null }, pos++);
            lastDay = p.day_number;
          }
          await insertBlock(ctx, g.id, 'place', {
            name: p.name, category: p.category, description: p.description, address: p.address,
            lat: p.lat, lon: p.lon, rating: p.rating, tips: p.tips ? JSON.parse(p.tips) : [],
            photoDataUri: p.photo_data_uri || null, source: p.source, xid: p.xid,
          }, pos++);
        }
        // Pre-existing guides were already visible to everyone — keep them that way.
        await ctx.db.exec(`UPDATE guides SET status = 'published' WHERE id = ?`, g.id);
      }
      ctx.log.info('featured-guides: migrated legacy guide_places into guide_blocks');
    }

    ctx.log.info('featured-guides loaded');
  },

  routes: [
    // ---- Browse ----
    {
      method: 'GET', path: '/guides', auth: true,
      async handler(req, ctx) {
        const isAdmin = !!(req.user && req.user.isAdmin);
        const guides = await ctx.db.query(
          isAdmin ? 'SELECT * FROM guides ORDER BY created_at DESC' : `SELECT * FROM guides WHERE status = 'published' ORDER BY created_at DESC`
        );
        if (!guides.length) return json(200, { guides: [] });
        const ids = guides.map((g) => g.id);
        const placeholders = ids.map(() => '?').join(',');
        const blocks = await ctx.db.query(
          `SELECT guide_id, type, position, data FROM guide_blocks WHERE guide_id IN (${placeholders}) AND type IN ('place','day','image') ORDER BY guide_id, position ASC`,
          ...ids
        );
        const byGuide = {};
        for (const b of blocks) {
          (byGuide[b.guide_id] = byGuide[b.guide_id] || []).push(b);
        }
        const rows = guides.map((g) => {
          const bs = byGuide[g.id] || [];
          const place_count = bs.filter((b) => b.type === 'place').length;
          const day_count = bs.filter((b) => b.type === 'day').length;
          let cover_photo = null;
          for (const b of bs) {
            const photo = blockPhoto(b.type, JSON.parse(b.data || '{}'));
            if (photo) { cover_photo = photo; break; }
          }
          return { ...g, place_count, day_count, cover_photo };
        });
        return json(200, { guides: rows.map(guideRow) });
      },
    },
    {
      method: 'GET', path: '/guide', auth: true,
      async handler(req, ctx) {
        const id = Number(req.query.id);
        if (!Number.isInteger(id)) return error(400, 'id is required');
        const rows = await ctx.db.query('SELECT * FROM guides WHERE id = ?', id);
        if (!rows.length) return error(404, 'Guide not found');
        const isAdmin = !!(req.user && req.user.isAdmin);
        if (rows[0].status !== 'published' && !isAdmin) return error(404, 'Guide not found');
        const blocks = await ctx.db.query('SELECT * FROM guide_blocks WHERE guide_id = ? ORDER BY position ASC', id);
        const mappedBlocks = await resolveGuideEmbeds(ctx, blocks.map(blockRow), isAdmin);
        const place_count = mappedBlocks.filter((b) => b.type === 'place').length;
        const day_count = mappedBlocks.filter((b) => b.type === 'day').length;
        let cover_photo = null;
        for (const b of mappedBlocks) {
          const photo = blockPhoto(b.type, b.data);
          if (photo) { cover_photo = photo; break; }
        }
        return json(200, { guide: guideRow({ ...rows[0], place_count, day_count, cover_photo }), blocks: mappedBlocks });
      },
    },

    // ---- Admin: guide CRUD ----
    {
      method: 'POST', path: '/guide', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const { title, location, description } = b;
        if (!title || typeof title !== 'string' || !title.trim()) return error(400, 'title is required');
        const template = b.template !== undefined ? b.template : 'blank';
        if (!TEMPLATES.includes(template)) return error(400, `template must be one of: ${TEMPLATES.join(', ')}`);
        let dayCount = null;
        if (template === 'itinerary') {
          dayCount = Number(b.dayCount);
          if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 60) return error(400, 'dayCount must be a whole number between 1 and 60 for the itinerary template');
        }
        await ctx.db.exec(
          'INSERT INTO guides (title, location, description, template) VALUES (?, ?, ?, ?)',
          title.trim(), location || null, description || null, template
        );
        const rows = await ctx.db.query('SELECT * FROM guides WHERE id = last_insert_rowid()');
        const guide = rows[0];
        if (template === 'itinerary' && dayCount) {
          // Same reason as insertPdfPlaceBlocks/the reorder route: a 60-day itinerary looping
          // insertBlock() one day at a time is up to 120 sequential, unbatched ctx.* calls
          // (exec + query per call) — batch via ctx.db.tx() instead.
          await insertDayBlocks(ctx, guide.id, dayCount, 0);
        }
        return json(201, { guide: guideRow(guide) });
      },
    },
    {
      method: 'PUT', path: '/guide', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const { id, title, location, description } = b;
        if (!Number.isInteger(id)) return error(400, 'id is required');
        if (!title || typeof title !== 'string' || !title.trim()) return error(400, 'title is required');
        const existing = await ctx.db.query('SELECT * FROM guides WHERE id = ?', id);
        if (!existing.length) return error(404, 'Guide not found');
        const template = b.template !== undefined ? b.template : existing[0].template;
        if (!TEMPLATES.includes(template)) return error(400, `template must be one of: ${TEMPLATES.join(', ')}`);
        await ctx.db.exec(
          `UPDATE guides SET title = ?, location = ?, description = ?, template = ?, updated_at = datetime('now') WHERE id = ?`,
          title.trim(), location || null, description || null, template, id
        );
        // Switching to the itinerary template from the edit view (unlike at creation time) never
        // created any Day blocks — an admin could pick "Itinerary", type a day count, save, and
        // get a guide silently stuck with zero days. Only pre-create days on the actual empty ->
        // itinerary transition (no day blocks yet); a guide that already has days manages them
        // through the normal block editor (+ Add item -> Day) instead of a bulk count here.
        if (template === 'itinerary' && Number.isInteger(b.dayCount) && b.dayCount > 0 && b.dayCount <= 60) {
          const existingDays = await ctx.db.query(`SELECT COUNT(*) AS n FROM guide_blocks WHERE guide_id = ? AND type = 'day'`, id);
          if (!existingDays[0].n) {
            const startPos = await nextPosition(ctx, id);
            await insertDayBlocks(ctx, id, b.dayCount, startPos);
          }
        }
        const rows = await ctx.db.query('SELECT * FROM guides WHERE id = ?', id);
        return json(200, { guide: guideRow(rows[0]) });
      },
    },
    {
      method: 'POST', path: '/guide/publish', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const id = Number(b.id);
        if (!Number.isInteger(id)) return error(400, 'id is required');
        const status = b.status === 'published' ? 'published' : 'draft';
        const existing = await ctx.db.query('SELECT id FROM guides WHERE id = ?', id);
        if (!existing.length) return error(404, 'Guide not found');
        await ctx.db.exec(`UPDATE guides SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, id);
        const rows = await ctx.db.query('SELECT * FROM guides WHERE id = ?', id);
        return json(200, { guide: guideRow(rows[0]) });
      },
    },
    {
      method: 'DELETE', path: '/guide', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const id = Number(req.query.id);
        if (!Number.isInteger(id)) return error(400, 'id is required');
        await ctx.db.exec('DELETE FROM guide_blocks WHERE guide_id = ?', id);
        await ctx.db.exec('DELETE FROM guide_places WHERE guide_id = ?', id);
        await ctx.db.exec('DELETE FROM guides WHERE id = ?', id);
        return json(200, { deleted: true });
      },
    },

    // ---- Admin: blocks CRUD ----
    {
      method: 'POST', path: '/guide/blocks', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const guideId = Number(b.guideId);
        if (!Number.isInteger(guideId)) return error(400, 'guideId is required');
        if (!BLOCK_TYPES.includes(b.type)) return error(400, `type must be one of: ${BLOCK_TYPES.join(', ')}`);
        const guideExists = await ctx.db.query('SELECT id FROM guides WHERE id = ?', guideId);
        if (!guideExists.length) return error(404, 'Guide not found');

        let data = b.data || {};
        if (b.type === 'guide') {
          const refGuideId = Number(data.refGuideId);
          if (refGuideId === guideId) return error(400, "A guide can't embed itself");
          const ref = await ctx.db.query('SELECT title, location FROM guides WHERE id = ?', refGuideId);
          if (!ref.length) return error(404, 'Referenced guide not found');
          data = { refGuideId, title: ref[0].title, location: ref[0].location };
        }
        const normalized = validateBlockData(b.type, data);
        if (typeof normalized === 'string') return error(400, normalized);

        const position = Number.isInteger(b.position) ? b.position : await nextPosition(ctx, guideId);
        const block = await insertBlock(ctx, guideId, b.type, normalized, position);
        return json(201, { block });
      },
    },
    {
      method: 'PUT', path: '/guide/blocks', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        if (!Number.isInteger(b.id)) return error(400, 'id is required');
        const existing = await ctx.db.query('SELECT * FROM guide_blocks WHERE id = ?', b.id);
        if (!existing.length) return error(404, 'Block not found');
        const cur = existing[0];
        let data = b.data || {};
        // Same existence/self-embed checks POST /guide/blocks applies when a "guide" (embed)
        // block is first created — not reachable through the shipped client today (it blocks
        // editing an embed block outright), but the route itself shouldn't silently trust
        // whatever refGuideId/title/location a direct request supplies.
        if (cur.type === 'guide') {
          const refGuideId = Number(data.refGuideId);
          if (refGuideId === cur.guide_id) return error(400, "A guide can't embed itself");
          const ref = await ctx.db.query('SELECT title, location FROM guides WHERE id = ?', refGuideId);
          if (!ref.length) return error(404, 'Referenced guide not found');
          data = { refGuideId, title: ref[0].title, location: ref[0].location };
        }
        const normalized = validateBlockData(cur.type, data);
        if (typeof normalized === 'string') return error(400, normalized);
        await ctx.db.exec(`UPDATE guide_blocks SET data = ?, updated_at = datetime('now') WHERE id = ?`, JSON.stringify(normalized), b.id);
        const rows = await ctx.db.query('SELECT * FROM guide_blocks WHERE id = ?', b.id);
        return json(200, { block: blockRow(rows[0]) });
      },
    },
    {
      method: 'DELETE', path: '/guide/blocks', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const id = Number(req.query.id);
        if (!Number.isInteger(id)) return error(400, 'id is required');
        await ctx.db.exec('DELETE FROM guide_blocks WHERE id = ?', id);
        return json(200, { deleted: true });
      },
    },
    {
      method: 'POST', path: '/guide/blocks/reorder', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const guideId = Number(b.guideId);
        const orderedIds = Array.isArray(b.orderedIds) ? b.orderedIds.map(Number) : null;
        if (!Number.isInteger(guideId)) return error(400, 'guideId is required');
        if (!orderedIds || !orderedIds.length) return error(400, 'orderedIds is required');
        const existing = await ctx.db.query('SELECT id FROM guide_blocks WHERE guide_id = ?', guideId);
        const existingIds = new Set(existing.map((r) => r.id));
        const submittedIds = new Set(orderedIds);
        if (
          orderedIds.length !== existingIds.size ||
          submittedIds.size !== orderedIds.length || // catches a duplicate id silently standing in for a missing one
          !orderedIds.every((id) => existingIds.has(id))
        ) {
          return error(400, 'orderedIds must contain exactly the guide\'s current block ids');
        }
        // Batch via ctx.db.tx() instead of one ctx.db.exec() per block, same reason as the PDF
        // import's block inserts (see insertPdfPlaceBlocks): a guide with a few dozen blocks —
        // exactly what a full-length PDF import produces — turned this into that many sequential,
        // unpaced ctx.* calls in one request, easily enough on its own to trip the host's rate
        // limit regardless of any client-side pacing between separate requests.
        const ops = orderedIds.map((id, i) => ({
          sql: 'UPDATE guide_blocks SET position = ? WHERE id = ?',
          args: [i, id],
        }));
        if (typeof ctx.db.tx === 'function') {
          for (let i = 0; i < ops.length; i += 90) { // tx caps out at 100 ops per call — chunk with margin
            await ctx.db.tx(ops.slice(i, i + 90));
          }
        } else {
          for (const op of ops) {
            await ctx.db.exec(op.sql, ...op.args);
            await sleep(RATE_LIMIT_GAP_MS);
          }
        }
        const rows = await ctx.db.query('SELECT * FROM guide_blocks WHERE guide_id = ? ORDER BY position ASC', guideId);
        return json(200, { blocks: rows.map(blockRow) });
      },
    },

    // ---- Admin: OpenTripMap search + import ----
    {
      method: 'GET', path: '/search', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!q) return error(400, 'q is required');
        try {
          const apiKey = await ctx.settings.get('opentripmap_api_key');
          const geo = await otmFetch(apiKey, `/geoname?name=${encodeURIComponent(q)}`);
          if (!geo || typeof geo.lat !== 'number') return error(404, `No location found for "${q}"`);
          const radius = await otmFetch(
            apiKey,
            `/radius?radius=20000&lon=${geo.lon}&lat=${geo.lat}&kinds=interesting_places&rate=2&format=json&limit=30`
          );
          const places = (Array.isArray(radius) ? radius : [])
            .filter((p) => p.name)
            .map((p) => ({
              xid: p.xid,
              name: p.name,
              kinds: p.kinds,
              rating: typeof p.rate === 'number' ? p.rate : null,
              dist: p.dist,
            }));
          return json(200, {
            center: { name: geo.name, country: geo.country, lat: geo.lat, lon: geo.lon },
            places,
          });
        } catch (e) {
          return error(502, e.message || 'OpenTripMap lookup failed');
        }
      },
    },
    {
      // Best-effort "is this a real place" check for a guide's Location field, backed by the
      // same OpenTripMap /geoname lookup geocodePlacesViaOtm already uses to resolve a guide's
      // destination. Always 200s with a `checked` flag rather than erroring — no API key
      // configured, or OpenTripMap being unreachable, just means the check can't run, same as
      // every other OpenTripMap-dependent feature in this plugin degrading quietly rather than
      // blocking the admin from saving.
      method: 'GET', path: '/location/verify', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!q) return error(400, 'q is required');
        try {
          const apiKey = await ctx.settings.get('opentripmap_api_key');
          const geo = await otmFetch(apiKey, `/geoname?name=${encodeURIComponent(q)}`);
          if (geo && typeof geo.lat === 'number' && typeof geo.lon === 'number') {
            return json(200, { checked: true, found: true, name: geo.name || q, country: geo.country || null });
          }
          return json(200, { checked: true, found: false });
        } catch (e) {
          return json(200, { checked: false, reason: e.message || 'Could not verify that location.' });
        }
      },
    },
    {
      // Retroactively geocodes a guide's already-imported places that still have no lat/lon —
      // for a guide imported before geocodeMissingByAddress existed, or one whose places just
      // didn't match anything in either pass at import time. Same two-pass approach (OTM name-
      // match, then Nominatim by address), same best-effort contract: whatever doesn't resolve
      // is left alone rather than erroring.
      //
      // Index-resumable: only ever geocodes MAX_NOMINATIM_LOOKUPS_PER_CALL places per request,
      // not every missing place in the guide at once — a guide with, say, 30 uncoordinated places
      // would otherwise chain 30 Nominatim lookups at NOMINATIM_MIN_GAP_MS apart (33+ seconds),
      // which blows well past the browser bridge's own ~8s round-trip timeout (see the comment on
      // MAX_NOMINATIM_LOOKUPS_PER_CALL above — confirmed independently on a real TREK instance,
      // tighter than this route's own 30s server-side execution budget).
      //
      // A place that gets ATTEMPTED but doesn't resolve (common — plenty of real places just
      // aren't in either OTM or Nominatim) still has no lat/lon afterward, so it's still "missing"
      // by that test alone — picking the next batch by re-filtering for "missing" every call would
      // hand back the exact same stuck, unfixable places forever and never converge. The client
      // instead accumulates `triedIds` across rounds and sends them back each call so this route
      // can skip anything already attempted THIS run (whether it resolved or not), guaranteeing
      // `remaining` strictly decreases and the loop actually finishes.
      method: 'POST', path: '/guide/fix-missing-coords', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const guideId = Number(b.guideId);
        if (!Number.isInteger(guideId)) return error(400, 'guideId is required');
        const alreadyTriedIds = new Set(Array.isArray(b.alreadyTriedIds) ? b.alreadyTriedIds.map(Number) : []);
        const guideRows = await ctx.db.query('SELECT * FROM guides WHERE id = ?', guideId);
        if (!guideRows.length) return error(404, 'Guide not found');
        const guide = guideRows[0];

        const blockRows = await ctx.db.query(`SELECT * FROM guide_blocks WHERE guide_id = ? AND type = 'place' ORDER BY position ASC`, guideId);
        const blocks = blockRows.map(blockRow);
        const missing = blocks.filter((bl) => !(typeof bl.data.lat === 'number' && typeof bl.data.lon === 'number') && !alreadyTriedIds.has(bl.id));
        if (!missing.length) return json(200, { fixed: 0, checked: 0, remaining: 0, triedIds: [] });

        const batch = missing.slice(0, MAX_NOMINATIM_LOOKUPS_PER_CALL);
        const asPlaces = batch.map((bl) => ({ name: bl.data.name, address: bl.data.address, lat: null, lon: null }));
        await geocodePlacesViaOtm(ctx, asPlaces, guide.location || guide.title);
        await geocodeMissingByAddress(asPlaces);

        const ops = [];
        batch.forEach((bl, i) => {
          const p = asPlaces[i];
          if (typeof p.lat === 'number' && typeof p.lon === 'number') {
            ops.push({
              sql: 'UPDATE guide_blocks SET data = ? WHERE id = ?',
              args: [JSON.stringify({ ...bl.data, lat: p.lat, lon: p.lon }), bl.id],
            });
          }
        });
        if (ops.length) {
          if (typeof ctx.db.tx === 'function') {
            for (let i = 0; i < ops.length; i += 90) await ctx.db.tx(ops.slice(i, i + 90));
          } else {
            for (const op of ops) { await ctx.db.exec(op.sql, ...op.args); await sleep(RATE_LIMIT_GAP_MS); }
          }
        }
        return json(200, {
          fixed: ops.length,
          checked: batch.length,
          remaining: missing.length - batch.length,
          triedIds: batch.map((bl) => bl.id),
        });
      },
    },
    {
      method: 'POST', path: '/guide/blocks/from-opentripmap', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const guideId = Number(b.guideId);
        if (!Number.isInteger(guideId)) return error(400, 'guideId is required');
        if (!b.xid || typeof b.xid !== 'string') return error(400, 'xid is required');
        const guideExists = await ctx.db.query('SELECT id FROM guides WHERE id = ?', guideId);
        if (!guideExists.length) return error(404, 'Guide not found');
        try {
          const apiKey = await ctx.settings.get('opentripmap_api_key');
          const detail = await otmFetch(apiKey, `/xid/${encodeURIComponent(b.xid)}`);
          const addressParts = detail.address
            ? [detail.address.road, detail.address.city, detail.address.state, detail.address.country].filter(Boolean)
            : [];
          const description = detail.wikipedia_extracts && detail.wikipedia_extracts.text
            ? detail.wikipedia_extracts.text
            : (detail.kinds ? `A notable spot tagged: ${detail.kinds.replace(/,/g, ', ')}.` : null);
          const photoUrl = (detail.preview && detail.preview.source) || detail.image || null;
          const photoDataUri = await fetchPhotoDataUri(photoUrl);
          const data = validateBlockData('place', {
            name: detail.name || 'Untitled place',
            category: detail.kinds ? detail.kinds.split(',')[0] : null,
            description, address: addressParts.join(', ') || null,
            lat: detail.point ? detail.point.lat : null, lon: detail.point ? detail.point.lon : null,
            rating: typeof detail.rate === 'number' ? detail.rate : null,
            photoDataUri, source: 'opentripmap', xid: detail.xid || b.xid,
          });
          const position = Number.isInteger(b.position) ? b.position : await nextPosition(ctx, guideId);
          const block = await insertBlock(ctx, guideId, 'place', data, position);
          return json(201, { block });
        } catch (e) {
          return error(502, e.message || 'OpenTripMap import failed');
        }
      },
    },

    // ---- Admin: import from a Collection ----
    {
      method: 'GET', path: '/collections', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        if (!ctx.collections) return error(400, "This TREK instance doesn't support Collections yet — try updating TREK.");
        try {
          const collections = toArray(await ctx.collections.listMine());
          return json(200, {
            collections: collections.map((c) => ({ id: c.id, name: c.name || c.title || 'Untitled collection' })),
          });
        } catch (e) {
          ctx.log.error('collections.listMine failed', { message: e && e.message });
          const message = String(e && e.message || e);
          if (message.startsWith('RESOURCE_FORBIDDEN')) return error(400, 'The Collections addon is not enabled on this TREK instance.');
          if (message.startsWith('PERMISSION_DENIED')) return error(400, 'This plugin needs the "db:read:collections" permission re-approved — reinstall or update the plugin in Admin → Plugins to grant it.');
          return error(502, 'Could not load your collections: ' + message);
        }
      },
    },
    {
      method: 'GET', path: '/collections/places', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        if (!ctx.collections) return error(400, "This TREK instance doesn't support Collections yet — try updating TREK.");
        const id = Number(req.query.id);
        if (!Number.isInteger(id)) return error(400, 'id is required');
        try {
          const collection = await ctx.collections.get(id);
          if (!collection) return error(404, 'Collection not found');
          const places = collectionPlacesOf(collection);
          return json(200, { places: places.map(collectionPlaceRow) });
        } catch (e) {
          ctx.log.error('collections.get failed', { message: e && e.message });
          const message = String(e && e.message || e);
          if (message.startsWith('RESOURCE_FORBIDDEN')) return error(400, 'The Collections addon is not enabled, or you do not have access to that collection.');
          if (message.startsWith('PERMISSION_DENIED')) return error(400, 'This plugin needs the "db:read:collections" permission re-approved — reinstall or update the plugin in Admin → Plugins to grant it.');
          return error(502, 'Could not load places from that collection: ' + message);
        }
      },
    },
    {
      method: 'POST', path: '/guide/blocks/from-collection', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const guideId = Number(b.guideId);
        const collectionId = Number(b.collectionId);
        const placeId = b.placeId;
        if (!Number.isInteger(guideId)) return error(400, 'guideId is required');
        if (!Number.isInteger(collectionId)) return error(400, 'collectionId is required');
        if (placeId == null) return error(400, 'placeId is required');
        if (!ctx.collections) return error(400, "This TREK instance doesn't support Collections yet — try updating TREK.");
        const guideExists = await ctx.db.query('SELECT id FROM guides WHERE id = ?', guideId);
        if (!guideExists.length) return error(404, 'Guide not found');
        try {
          const collection = await ctx.collections.get(collectionId);
          const places = collectionPlacesOf(collection);
          const found = places.find((p) => String(p.id) === String(placeId));
          if (!found) return error(404, 'Place not found in that collection');
          const p = collectionPlaceRow(found);
          const data = validateBlockData('place', { ...p, source: 'collection' });
          const position = Number.isInteger(b.position) ? b.position : await nextPosition(ctx, guideId);
          const block = await insertBlock(ctx, guideId, 'place', data, position);
          return json(201, { block });
        } catch (e) {
          ctx.log.error('guide/blocks/from-collection failed', { message: e && e.message });
          const message = String(e && e.message || e);
          if (message.startsWith('RESOURCE_FORBIDDEN')) return error(400, 'The Collections addon is not enabled, or you do not have access to that collection.');
          if (message.startsWith('PERMISSION_DENIED')) return error(400, 'This plugin needs the "db:read:collections" permission re-approved — reinstall or update the plugin in Admin → Plugins to grant it.');
          return error(502, 'Could not import that place: ' + message);
        }
      },
    },

    // ---- Trips ----
    {
      method: 'GET', path: '/trips', auth: true,
      async handler(req, ctx) {
        try {
          const trips = toArray(await ctx.trips.listMine());
          return json(200, {
            trips: trips.map((t) => ({ id: t.id, title: t.title, startDate: t.start_date, endDate: t.end_date })),
          });
        } catch (e) {
          return error(502, 'Could not load your trips: ' + (e && e.message || e));
        }
      },
    },
    {
      method: 'POST', path: '/guide/blocks/add-to-trip', auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const tripId = Number(b.tripId);
        const blockId = Number(b.blockId);
        if (!Number.isInteger(tripId) || !Number.isInteger(blockId)) return error(400, 'tripId and blockId are required');
        const rows = await ctx.db.query('SELECT * FROM guide_blocks WHERE id = ?', blockId);
        if (!rows.length) return error(404, 'Block not found');
        const block = blockRow(rows[0]);
        if (block.type !== 'place' && block.type !== 'activity') return error(400, 'Only a place or activity can be added to a trip');
        // Block ids are sequential across every guide, so a non-admin could otherwise guess/probe
        // one belonging to an unpublished draft — enforce the same draft-visibility rule
        // /guide/plan-trip already does, instead of only gating on the block's own type.
        const guideRows = await ctx.db.query('SELECT status FROM guides WHERE id = ?', block.guideId);
        const isAdmin = !!(req.user && req.user.isAdmin);
        if (!guideRows.length || (guideRows[0].status !== 'published' && !isAdmin)) return error(404, 'Block not found');
        try {
          const created = await ctx.places.create(tripId, placeCreateInput(block.data));
          return json(201, { added: true, place: created });
        } catch (e) {
          const message = String(e && e.message || e);
          if (message.startsWith('RESOURCE_FORBIDDEN')) return error(403, "You don't have permission to add places to that trip.");
          if (message.startsWith('PERMISSION_DENIED')) return error(403, 'Permission denied.');
          if (message.startsWith('BAD_PARAMS')) return error(400, 'That place could not be added as-is.');
          return error(502, 'Could not add the place to the trip.');
        }
      },
    },
    {
      method: 'POST', path: '/guide/plan-trip', auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const guideId = Number(b.guideId);
        if (!Number.isInteger(guideId)) return error(400, 'guideId is required');
        if (!isValidDateStr(b.startDate) || !isValidDateStr(b.endDate)) return error(400, 'startDate and endDate must be YYYY-MM-DD');
        const span = daysBetween(b.startDate, b.endDate);
        if (span < 0) return error(400, 'endDate must be on or after startDate');
        if (span > 365) return error(400, 'That date range is too long (max 366 days)');

        const guideRows = await ctx.db.query('SELECT * FROM guides WHERE id = ?', guideId);
        if (!guideRows.length) return error(404, 'Guide not found');
        const isAdmin = !!(req.user && req.user.isAdmin);
        if (guideRows[0].status !== 'published' && !isAdmin) return error(404, 'Guide not found');

        const title = (b.title && String(b.title).trim()) || guideRows[0].title;

        let trip;
        try {
          trip = await ctx.trips.create({ title: title.slice(0, 200), start_date: b.startDate, end_date: b.endDate });
        } catch (e) {
          const message = String(e && e.message || e);
          if (message.startsWith('RESOURCE_FORBIDDEN')) return error(403, "You don't have permission to create a new trip.");
          if (message.startsWith('PERMISSION_DENIED')) return error(403, 'Permission denied.');
          if (message.startsWith('BAD_PARAMS')) return error(400, 'Could not create a trip with that title or date range.');
          return error(502, 'Could not create the trip.');
        }

        const blocks = (await ctx.db.query('SELECT * FROM guide_blocks WHERE guide_id = ? ORDER BY position ASC', guideId)).map(blockRow);

        // Map calendar date -> day id, seeding it lazily only for days we actually need
        // (the trip may already have day rows from its own creation, or may not). Wrapped like
        // every other host call in this loop below — the trip already exists at this point, so a
        // transient failure here should degrade to "nothing pre-seeded, create days as needed"
        // rather than aborting the request and leaving that trip orphaned with zero places.
        const dayIdByDate = {};
        try {
          for (const d of await ctx.trips.getDays(trip.id)) { if (d.date) dayIdByDate[d.date] = d.id; }
        } catch (e) {
          ctx.log.error('plan-trip: getDays failed (continuing with none pre-seeded)', { message: e && e.message });
        }
        async function dayIdFor(dateStr) {
          if (dayIdByDate[dateStr]) return dayIdByDate[dateStr];
          const created = await ctx.days.create(trip.id, { date: dateStr });
          dayIdByDate[dateStr] = created.id;
          await sleep(RATE_LIMIT_GAP_MS);
          return created.id;
        }

        // Up to 3 ctx.* calls per place (places.create, days.create, itinerary.assign) — unlike
        // the PDF import's own-db block inserts above, these are host-managed entities (not the
        // plugin's own db:own tables), so they can't be collapsed into a ctx.db.tx() batch. A
        // large guide's places would otherwise fire that many calls back-to-back and trip the
        // same per-plugin RPC rate limit; pace every ctx.* call with a fixed gap instead.
        let currentDayNumber = null;
        let scheduled = 0, unscheduled = 0, failed = 0;
        for (const block of blocks) {
          if (block.type === 'day') { currentDayNumber = block.data.dayNumber; continue; }
          if (block.type !== 'place' && block.type !== 'activity') continue;
          let placeId;
          try {
            const created = await ctx.places.create(trip.id, placeCreateInput(block.data));
            placeId = created.id;
          } catch (e) {
            ctx.log.error('plan-trip: place create failed', { message: e && e.message });
            failed++;
            continue;
          }
          await sleep(RATE_LIMIT_GAP_MS);
          const targetDate = currentDayNumber != null ? addDaysISO(b.startDate, currentDayNumber - 1) : null;
          if (targetDate && targetDate <= b.endDate && placeId != null) {
            try {
              const dayId = await dayIdFor(targetDate);
              await ctx.itinerary.assign(trip.id, dayId, placeId);
              scheduled++;
              await sleep(RATE_LIMIT_GAP_MS);
              continue;
            } catch (e) {
              ctx.log.error('plan-trip: day assign failed', { message: e && e.message });
              // fall through — the place still exists in the pool even if scheduling failed
            }
          }
          unscheduled++;
        }

        return json(201, {
          trip: { id: trip.id, title: trip.title, startDate: b.startDate, endDate: b.endDate },
          scheduled, unscheduled, failed,
        });
      },
    },

    // ---- Admin: import a guide from PDF text (extracted client-side) ----
    // A big/text-heavy PDF is sent in multiple chunks (see PDF_TEXT_UPLOAD_CHARS client-side,
    // which must stay in sync with MAX_PDF_TEXT_CHARS below) rather than one giant request — the
    // host's own request-body proxy rejects an oversized POST with a 413 well before this route
    // ever runs. This call handles chunk 1, creating the guide; every following chunk goes
    // through the /guide/import-pdf/append route below, onto that same guide.
    {
      method: 'POST', path: '/guide/import-pdf', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const rawText = typeof b.text === 'string' ? b.text.trim() : '';
        if (!rawText) return error(400, 'text is required (nothing readable was extracted from that PDF)');
        const truncated = rawText.length > MAX_PDF_TEXT_CHARS;
        const text = truncated ? rawText.slice(0, MAX_PDF_TEXT_CHARS) : rawText;

        const meta = guessGuideMetaFromText(text);
        const { places, usedAi, aiFallbackReason } = await extractPdfPlacesChunk(ctx, text);
        // Two passes: OTM name-match first (cheap, one sweep covers every place at once), then
        // Nominatim address lookup for whatever's still uncoordinated afterward.
        const otmMatched = await geocodePlacesViaOtm(ctx, places, meta.location || meta.title);
        const addrGeocode = await geocodeMissingByAddress(places);
        const geocodedCount = otmMatched + addrGeocode.matched;
        const hasDays = places.some((p) => p.dayNumber != null);

        await ctx.db.exec(
          'INSERT INTO guides (title, location, description, template) VALUES (?, ?, ?, ?)',
          meta.title, meta.location, meta.description, hasDays ? 'itinerary' : 'blank'
        );
        const guideRows = await ctx.db.query('SELECT * FROM guides WHERE id = last_insert_rowid()');
        const guide = guideRows[0];

        const result = await insertPdfPlaceBlocks(ctx, guide.id, places, 0, null);

        return json(201, {
          guide: guideRow(guide),
          placeCount: result.placesInserted,
          dayCount: result.dayBlocksInserted,
          lastDay: result.lastDay,
          truncated,
          usedAi,
          aiFallbackReason: usedAi ? null : aiFallbackReason,
          geocodedCount,
        });
      },
    },
    {
      // Continues a chunked PDF import onto the guide the /guide/import-pdf call above already
      // created — same per-chunk extraction (AI or static fallback), appended after the guide's
      // existing blocks instead of starting a new guide. carryDay (the previous chunk's last day
      // number, from that call's response) keeps a day's place list that spans a chunk boundary
      // from getting a duplicate "Day N" header inserted partway through it. Only ever creates
      // more guide_blocks rows on an existing guide — never a second guide.
      method: 'POST', path: '/guide/import-pdf/append', auth: true,
      async handler(req, ctx) {
        const denied = requireAdmin(req); if (denied) return denied;
        const b = req.body || {};
        const guideId = Number(b.guideId);
        if (!Number.isInteger(guideId)) return error(400, 'guideId is required');
        const rawText = typeof b.text === 'string' ? b.text.trim() : '';
        if (!rawText) return error(400, 'text is required');
        const truncated = rawText.length > MAX_PDF_TEXT_CHARS;
        const text = truncated ? rawText.slice(0, MAX_PDF_TEXT_CHARS) : rawText;
        const carryDay = Number.isInteger(b.carryDay) ? b.carryDay : null;

        const existing = await ctx.db.query('SELECT id, title, location FROM guides WHERE id = ?', guideId);
        if (!existing.length) return error(404, 'Guide not found');

        const { places, usedAi, aiFallbackReason } = await extractPdfPlacesChunk(ctx, text);
        const otmMatched = await geocodePlacesViaOtm(ctx, places, existing[0].location || existing[0].title);
        const addrGeocode = await geocodeMissingByAddress(places);
        const geocodedCount = otmMatched + addrGeocode.matched;
        const startPos = await nextPosition(ctx, guideId);
        const result = await insertPdfPlaceBlocks(ctx, guideId, places, startPos, carryDay);

        return json(200, {
          placeCount: result.placesInserted,
          dayCount: result.dayBlocksInserted,
          lastDay: result.lastDay,
          truncated,
          usedAi,
          aiFallbackReason: usedAi ? null : aiFallbackReason,
          geocodedCount,
        });
      },
    },
  ],
});
