// Stage 2: turn raw places into companies. One company = one website domain.
// Branches of the same firm (same domain) are merged and counted as `locations`.
import { db } from "../lib/db.ts";

// Not real company websites: social profiles, portals, link pages.
const NOT_A_SITE = /(facebook|instagram|linkedin|xing|google|linktr\.ee|immobilienscout24|immowelt|yelp|gelbeseiten|wix\.com\/|jimdo|business\.site|t-online|ebay)/i;

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\d?\./, "");
    return NOT_A_SITE.test(h) ? null : h;
  } catch { return null; }
}

async function main() {
  const d = await db();
  const { rows } = await d.query<any>("select * from places order by rating_count desc nulls last");
  // stale placeholder rows from earlier runs (never crawled, no facts) are rebuilt below
  await d.query(`delete from companies c where domain like 'nosite:%' and not exists (select 1 from facts f where f.company_id=c.id)
                 and not exists (select 1 from contacts x where x.company_id=c.id)`);
  const groups = new Map<string, any[]>();
  const add = (k: string, p: any) => (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  // Same firm across sources: match by phone (last 8 digits) or normalised name.
  const phoneKey = (s: string | null) => { const x = (s ?? "").replace(/\D/g, ""); return x.length >= 7 ? x.slice(-8) : null; };
  const nameKey = (s: string) => s.toLowerCase().replace(/gmbh|& co\.? kg|ug|mbh|e\.k\.|ohg|kg|\bgbr\b|[^a-z0-9äöüß]/g, "");
  const byPhone = new Map<string, string>(), byName = new Map<string, string>();
  const withSite = rows.filter((p) => domainOf(p.website)), noSite = rows.filter((p) => !domainOf(p.website));
  for (const p of withSite) {
    const k = domainOf(p.website)!; add(k, p);
    const ph = phoneKey(p.phone); if (ph) byPhone.set(ph, k);
    byName.set(nameKey(p.name), k);
  }
  for (const p of noSite) {
    const k = (phoneKey(p.phone) && byPhone.get(phoneKey(p.phone)!)) || byName.get(nameKey(p.name)) || `nosite:${nameKey(p.name) || p.place_id}`;
    add(k, p);
    if (k.startsWith("nosite:")) { const ph = phoneKey(p.phone); if (ph) byPhone.set(ph, k); byName.set(nameKey(p.name), k); }
  }
  let n = 0;
  for (const [key, ps] of groups) {
    const main = ps[0]; // most-reviewed location = main office
    const hasSite = !key.startsWith("nosite:");
    await d.query(
      `insert into companies (domain,name,place_ids,address,postcode,district,phone,website,rating,rating_count,maps_url,locations,crawl_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (domain) do update set place_ids=excluded.place_ids, locations=excluded.locations,
         rating=excluded.rating, rating_count=excluded.rating_count`,
      [key, main.name, ps.map((p) => p.place_id), main.address, main.postcode, main.district, main.phone,
       hasSite ? main.website : null, main.rating, ps.reduce((s, p) => s + (p.rating_count ?? 0), 0) || null,
       main.maps_url, ps.length, hasSite ? null : "no_website"],
    );
    n++;
  }
  const s = await d.query<any>(`select count(*)::int total, count(*) filter (where crawl_status='no_website')::int nosite,
    count(*) filter (where locations>1)::int multi from companies`);
  console.log(`places: ${rows.length} -> companies: ${n}`, s.rows[0]);
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
