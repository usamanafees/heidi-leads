// Stage 1b: second + third discovery sources, merged with Google in stage 2 (dedupe by domain).
//   - Gelbe Seiten (German Yellow Pages): category listing, ~600 Berlin property managers
//   - OpenStreetMap (Overpass): office=property_management
// Usage: tsx 01b_directories.ts fetch   -> writes data/raw/*.json (no DB needed)
//        tsx 01b_directories.ts load    -> inserts into `places`
import * as cheerio from "cheerio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, loadYaml } from "../lib/env.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const RAW = path.join(ROOT, "data/raw");
const cfg = loadYaml<{ city: string; postcode_range: [number, number]; directory_terms?: string[] }>("config/search.yaml");
const TERMS = cfg.directory_terms ?? ["hausverwaltung", "immobilienverwaltung", "weg-verwaltung"];

type Entry = { id: string; name: string; address: string | null; postcode: string | null; district: string | null;
  website: string | null; phone: string | null; rating: number | null; rating_count: number | null; source: string; lat?: number; lng?: number };

const b64 = (s?: string) => { try { return s ? Buffer.from(s, "base64").toString("utf8") : null; } catch { return null; } };

function parseGs(html: string): Entry[] {
  const $ = cheerio.load(html);
  return $("article.mod-Treffer").toArray().map((el) => {
    const a = $(el);
    const addr = a.find("address").text().replace(/\s+/g, " ").trim();
    const pc = addr.match(/\b(1[0-4]\d{3})\b/)?.[1] ?? null;
    const district = addr.match(/\(([^)]+)\)/)?.[1] ?? null;
    return {
      id: "gs:" + a.attr("data-realid"), name: a.find("h2").first().text().trim(),
      address: addr.replace(/\s*\([^)]*\)\s*/, " ").replace(/\d+[,.]\d+ km.*$/, "").trim() || null, postcode: pc, district,
      website: b64(a.find("[data-webseitelink]").attr("data-webseitelink")),
      phone: b64(a.find("[data-prg]").attr("data-prg")),
      rating: Number(a.find(".mod-BewertungKompakt__number").first().text().replace(",", ".")) || null,
      rating_count: Number(a.find(".mod-BewertungKompakt__text").first().text().match(/\d+/)?.[0]) || null,
      source: "gelbeseiten",
    };
  });
}

async function fetchGs(term: string): Promise<Entry[]> {
  const first = await fetch(`https://www.gelbeseiten.de/branchen/${term}/${cfg.city.toLowerCase()}`, { headers: { "User-Agent": UA } });
  const out = parseGs(await first.text());
  let pos = out.length + 1, total = Infinity;
  while (pos <= total) {
    const r = await fetch("https://www.gelbeseiten.de/ajaxsuche", {
      method: "POST", headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ umkreis: "-1", WAS: term, WO: cfg.city.toLowerCase(), position: String(pos), anzahl: "10", sortierung: "relevanz" }),
    });
    if (!r.ok) { console.log(`  stop at ${pos}: HTTP ${r.status}`); break; }
    const j: any = await r.json();
    total = j.gesamtanzahlTreffer ?? 0;
    const batch = parseGs(j.html ?? "");
    if (!batch.length) break;
    out.push(...batch);
    pos += batch.length;
    await new Promise((s) => setTimeout(s, 700)); // be polite
  }
  console.log(`gelbeseiten "${term}": ${out.length} of ${total}`);
  return out;
}

async function fetchOsm(): Promise<Entry[]> {
  const q = `[out:json][timeout:80];area(3600062422)->.b;(nwr["office"="property_management"](area.b);nwr["name"~"[Hh]ausverwaltung|[Ii]mmobilienverwaltung"](area.b););out tags center;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "User-Agent": "heidi-leads-research/1.0" },
    body: new URLSearchParams({ data: q }) });
  const j: any = await r.json();
  const out = j.elements.map((e: any) => {
    const t = e.tags ?? {};
    const pc = t["addr:postcode"] ?? null;
    return { id: `osm:${e.type}/${e.id}`, name: t.name ?? t.operator ?? "?", postcode: pc, district: t["addr:suburb"] ?? null,
      address: [t["addr:street"] && `${t["addr:street"]} ${t["addr:housenumber"] ?? ""}`.trim(), pc && `${pc} Berlin`].filter(Boolean).join(", ") || null,
      website: t.website ?? t["contact:website"] ?? null, phone: t.phone ?? t["contact:phone"] ?? null, rating: null, rating_count: null,
      source: "osm", lat: e.center?.lat ?? e.lat, lng: e.center?.lon ?? e.lon } as Entry;
  }).filter((e: Entry) => e.name !== "?");
  console.log(`osm: ${out.length}`);
  return out;
}

async function main() {
  const mode = process.argv[2] ?? "fetch";
  await mkdir(RAW, { recursive: true });
  if (mode === "fetch") {
    const gs: Entry[] = [];
    for (const t of TERMS) gs.push(...(await fetchGs(t)));
    await writeFile(path.join(RAW, "gelbeseiten.json"), JSON.stringify(gs, null, 1));
    await writeFile(path.join(RAW, "osm.json"), JSON.stringify(await fetchOsm().catch((e) => { console.log("osm failed", e.message); return []; }), null, 1));
    return;
  }
  const { db } = await import("../lib/db.ts");
  const d = await db();
  let n = 0;
  for (const file of ["gelbeseiten.json", "osm.json"]) {
    const rows: Entry[] = JSON.parse(await readFile(path.join(RAW, file), "utf8").catch(() => "[]"));
    for (const e of rows) {
      const pc = Number(e.postcode);
      if (e.postcode && (pc < cfg.postcode_range[0] || pc > cfg.postcode_range[1])) continue;
      await d.query(`insert into places (place_id,name,address,postcode,district,lat,lng,website,phone,rating,rating_count,types,found_by_query)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (place_id) do nothing`,
        [e.id, e.name, e.address, e.postcode, e.district, e.lat ?? null, e.lng ?? null, e.website, e.phone, e.rating, e.rating_count, [e.source], [e.source]]);
      n++;
    }
  }
  console.log(`loaded ${n} directory entries into places`);
  await d.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
