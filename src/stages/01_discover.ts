// Stage 1: find every property manager in the city via Google Places Text Search (New).
// Strategy: grid over the city's bounding box; each cell is searched with each query.
// Google returns max 60 results per search, so a cell that hits the cap is split into 4
// smaller cells (adaptive quadtree) until results stop saturating.
import { db } from "../lib/db.ts";
import { loadYaml, requireEnv } from "../lib/env.ts";

type Box = { south: number; west: number; north: number; east: number };
const cfg = loadYaml<{
  city: string; bbox: Box; grid: { rows: number; cols: number }; max_split_depth: number;
  queries: string[]; postcode_range: [number, number];
}>("config/search.yaml");

const KEY = requireEnv("GOOGLE_PLACES_API_KEY");
const FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.addressComponents",
  "places.location", "places.websiteUri", "places.nationalPhoneNumber", "places.rating",
  "places.userRatingCount", "places.types", "places.primaryType", "places.businessStatus",
  "places.googleMapsUri", "nextPageToken",
].join(",");

let requests = 0;

async function search(query: string, box: Box, pageToken?: string) {
  requests++;
  const body: any = {
    textQuery: query, languageCode: "de", regionCode: "DE", pageSize: 20,
    locationRestriction: { rectangle: {
      low: { latitude: box.south, longitude: box.west },
      high: { latitude: box.north, longitude: box.east } } },
  };
  if (pageToken) body.pageToken = pageToken;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify(body),
    });
    if (r.ok) return (await r.json()) as { places?: any[]; nextPageToken?: string };
    const txt = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    throw new Error(`Places ${r.status}: ${txt.slice(0, 300)}`);
  }
  throw new Error("Places: too many retries");
}

/** All results for one query in one box (up to 3 pages = 60). */
async function searchAllPages(query: string, box: Box) {
  const out: any[] = [];
  let token: string | undefined;
  for (let page = 0; page < 3; page++) {
    const res = await search(query, box, token);
    out.push(...(res.places ?? []));
    token = res.nextPageToken;
    if (!token) break;
    await new Promise((s) => setTimeout(s, 300));
  }
  return out;
}

function split(b: Box): Box[] {
  const mLat = (b.south + b.north) / 2, mLng = (b.west + b.east) / 2;
  return [
    { south: b.south, west: b.west, north: mLat, east: mLng },
    { south: b.south, west: mLng, north: mLat, east: b.east },
    { south: mLat, west: b.west, north: b.north, east: mLng },
    { south: mLat, west: mLng, north: b.north, east: b.east },
  ];
}

function component(p: any, type: string): string | undefined {
  return p.addressComponents?.find((c: any) => c.types?.includes(type))?.longText;
}

async function save(places: any[], query: string) {
  const d = await db();
  let kept = 0;
  for (const p of places) {
    const postcode = component(p, "postal_code");
    const pc = Number(postcode);
    if (!pc || pc < cfg.postcode_range[0] || pc > cfg.postcode_range[1]) continue;
    if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
    kept++;
    await d.query(
      `insert into places (place_id,name,address,postcode,district,lat,lng,website,phone,rating,rating_count,types,primary_type,business_status,maps_url,found_by_query)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,array[$16])
       on conflict (place_id) do update set found_by_query =
         (select array(select distinct unnest(places.found_by_query || array[$16])))`,
      [p.id, p.displayName?.text ?? "?", p.formattedAddress, postcode,
       component(p, "sublocality_level_1") ?? component(p, "sublocality"),
       p.location?.latitude, p.location?.longitude, p.websiteUri ?? null, p.nationalPhoneNumber ?? null,
       p.rating ?? null, p.userRatingCount ?? null, p.types ?? [], p.primaryType ?? null,
       p.businessStatus ?? null, p.googleMapsUri ?? null, query],
    );
  }
  return kept;
}

// Resumable: every finished (query, cell) is logged, so a run stopped by the daily quota
// continues where it left off next time.
async function cell(query: string, box: Box, depth: number): Promise<void> {
  const d = await db();
  const key = `${query}|${box.south.toFixed(4)},${box.west.toFixed(4)},${box.north.toFixed(4)},${box.east.toFixed(4)}`;
  const done = await d.query<any>("select hits from search_log where key=$1", [key]);
  let hits: number;
  if (done.rows.length) hits = done.rows[0].hits;
  else {
    const res = await searchAllPages(query, box);
    const kept = await save(res, query);
    hits = res.length;
    await d.query("insert into search_log (key, hits) values ($1,$2) on conflict do nothing", [key, hits]);
    console.log(`${"  ".repeat(depth)}[${query}] d${depth} ${hits} hits, ${kept} in city${hits >= 60 ? " -> split" : ""}`);
  }
  if (hits >= 60 && depth < cfg.max_split_depth) {
    for (const sub of split(box)) await cell(query, sub, depth + 1);
  }
}

async function main() {
  const { bbox, grid } = cfg;
  const dLat = (bbox.north - bbox.south) / grid.rows, dLng = (bbox.east - bbox.west) / grid.cols;
  const cells: Box[] = [];
  for (let r = 0; r < grid.rows; r++)
    for (let c = 0; c < grid.cols; c++)
      cells.push({ south: bbox.south + r * dLat, north: bbox.south + (r + 1) * dLat,
                   west: bbox.west + c * dLng, east: bbox.west + (c + 1) * dLng });

  const onlyQuery = process.argv[2]; // optional: run a single query
  for (const q of cfg.queries.filter((q) => !onlyQuery || q === onlyQuery)) {
    for (const b of cells) await cell(q, b, 0);
    const d = await db();
    const n = await d.query<{ n: number }>("select count(*)::int n from places");
    console.log(`== after "${q}": ${n.rows[0].n} unique places, ${requests} API requests so far`);
  }
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
