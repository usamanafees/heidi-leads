// Stage 4: extract qualifying facts from each company's crawled pages with Claude.
// Every fact must come with an exact quote + source URL. After the call, code verifies
// the quote really appears on that page - unverifiable facts are dropped (anti-hallucination).
import { z } from "zod";
import pLimit from "p-limit";
import { db } from "../lib/db.ts";
import { extract, models } from "../lib/llm.ts";

// Flat schema on purpose: deeply nested optional objects blow up the structured-output grammar.
// Facts come as a list of {field, value, quote, url}; types are converted + validated in code.
const FIELDS = ["units_managed", "buildings_managed", "employees", "founded_year", "metering_provider", "software",
  "has_portal", "mentions_heating_billing", "mentions_remote_reading", "billing_pain", "hiring", "management_types", "associations"] as const;
const NUMERIC = new Set(["units_managed", "buildings_managed", "employees", "founded_year"]);
const BOOL = new Set(["has_portal", "mentions_heating_billing", "mentions_remote_reading", "billing_pain", "hiring"]);

export const Facts = z.object({
  is_property_manager: z.boolean(),
  kind: z.enum(["independent_manager", "municipal_housing", "housing_company_or_coop", "broker_mainly", "facility_or_other"]),
  kind_reason: z.string(),
  management_types: z.array(z.enum(["weg", "mietverwaltung", "sev", "gewerbe"])),
  associations: z.array(z.enum(["VDIV", "IVD", "BVI", "Haus & Grund", "other"])),
  facts: z.array(z.object({ field: z.enum(FIELDS), value: z.string(), quote: z.string(), url: z.string() })),
  people: z.array(z.object({ name: z.string(), role: z.string(), email: z.string(), phone: z.string(), url: z.string() })),
  summary: z.string(),
});
export type FactsT = z.infer<typeof Facts>;

const SYSTEM = `You extract facts about a Berlin property management company (Hausverwaltung) from its own website text.

Output fields:
- is_property_manager: true if the company itself manages properties for owners (Haus-/WEG-/Miet-/Sondereigentumsverwaltung). False for pure brokers, builders, facility/cleaning firms, lawyers, portals.
- kind: independent_manager | municipal_housing (degewo, Gewobag, HOWOGE, Stadt und Land, WBM, Gesobau, berlinovo) | housing_company_or_coop (owns its stock, Genossenschaft) | broker_mainly | facility_or_other. kind_reason: one short sentence.
- management_types: weg (WEG-Verwaltung) | mietverwaltung (Miethaus-/Mietverwaltung) | sev (Sondereigentumsverwaltung) | gewerbe (commercial).
- associations: memberships stated on the site (VDIV incl. VDIV Berlin-Brandenburg, IVD, BVI, Haus & Grund, other).
- facts: ONLY facts that are actually stated. One entry per field, each with a verbatim quote and the page url:
  units_managed: number of units (Wohneinheiten/Einheiten/Wohnungen) under management. value = plain integer, "über 2.000" -> "2000".
  buildings_managed: number of buildings/Objekte/Liegenschaften. integer.
  employees: staff count if stated (or count of people listed on a team page). integer.
  founded_year: year founded / "seit 1998". integer.
  metering_provider: named Messdienst/submetering company they work with (ista, Techem, Brunata, Minol, Kalo, Metrona, ...).
  software: named property-management software or portal product (Domus, Haufe PowerHaus, Aareon/Wodis, immoware24, Karthago, casavi, facilioo, Immomio, ...).
  has_portal / mentions_heating_billing / mentions_remote_reading / billing_pain / hiring: value "true" only when the site shows it:
    has_portal = online portal or app for owners/tenants; mentions_heating_billing = Heizkosten-/Betriebskostenabrechnung or Verbrauchserfassung;
    mentions_remote_reading = Funkzähler / Fernablesung / smart metering / Heizkostenverordnung 2027; billing_pain = delays, manual work or complaints about billing/metering; hiring = open job ads.
  management_types / associations: add one entry with the quote that proves them (value = comma list).
- people: all named persons with role as written (Geschäftsführer/Inhaber from the Impressum first, then Prokurist, team leads, Verwalter). Max 8. email/phone only if printed for that person, else "". url = page where the name appears.
- summary: one English sentence: who they are and what they manage.

Rules: never guess. Quotes must be copied character-for-character from the page text (max 200 chars). German numbers: "2.500" = 2500.`;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[„“"'’]/g, "").trim();

/** Check that `quote` appears on page `url` (or anywhere on the site if url is off). */
function verify(quote: string, url: string, pages: { url: string; text: string }[]): "verified" | "unverified" | "none" {
  if (!quote?.trim()) return "none";
  const q = norm(quote).slice(0, 120);
  const page = pages.find((p) => p.url === url);
  if (page && norm(page.text).includes(q)) return "verified";
  if (pages.some((p) => norm(p.text).includes(q))) return "verified";
  return "unverified";
}

async function processCompany(c: any) {
  const d = await db();
  const { rows: pages } = await d.query<any>(
    `select url, kind, text from pages where company_id=$1 order by case kind when 'home' then 0 when 'impressum' then 1
       when 'about' then 2 when 'services' then 3 when 'team' then 4 when 'references' then 5 when 'jobs' then 6 else 7 end`, [c.id]);
  if (!pages.length) return "no_pages";
  let budget = 45_000;
  const doc = pages.map((p: any) => {
    const t = p.text.slice(0, Math.max(0, Math.min(budget, 12_000))); budget -= t.length;
    return t ? `<page url="${p.url}" kind="${p.kind}">\n${t}\n</page>` : "";
  }).filter(Boolean).join("\n\n");

  const f = await extract({
    stage: "extract", companyId: c.id, model: models.extract, system: SYSTEM, schema: Facts,
    user: `Company: ${c.name} (${c.website})\n\n${doc}`,
  });

  // --- verify evidence, store facts ---
  const put = async (field: string, value: unknown, quote = "", url = "", forceConf?: string) => {
    const v = verify(quote, url, pages);
    let conf = forceConf ?? (v === "verified" ? "stated" : v === "none" ? "unknown" : "unverified");
    let val = value;
    // numbers / names without a verifiable quote are not trusted
    if (conf === "unverified" && (typeof value === "number" || typeof value === "string")) val = null;
    await d.query(`insert into facts (company_id,field,value,confidence,evidence,source_url,extractor) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (company_id,field) do update set value=excluded.value, confidence=excluded.confidence, evidence=excluded.evidence,
      source_url=excluded.source_url, extractor=excluded.extractor, updated_at=now()`,
      [c.id, field, JSON.stringify(val ?? null), conf, quote || null, url || null, models.extract]);
  };
  await put("is_property_manager", f.is_property_manager, f.kind_reason, "", "model");
  await put("kind", f.kind, f.kind_reason, "", "model");
  await put("summary", f.summary, "", "", "model");
  const byField = new Map(f.facts.map((x) => [x.field, x]));
  for (const field of FIELDS) {
    const x = byField.get(field);
    let value: unknown = null;
    if (field === "management_types") value = f.management_types;
    else if (field === "associations") value = f.associations;
    else if (BOOL.has(field)) value = x ? /^(true|ja|yes)$/i.test(x.value.trim()) : false;
    else if (NUMERIC.has(field)) {
      const n = x ? Number(x.value.replace(/[^\d]/g, "")) : NaN;
      value = Number.isFinite(n) && n > 0 && !(field === "founded_year" && (n < 1850 || n > 2026)) ? n : null;
    } else value = x?.value?.trim() || null;
    await put(field, value, x?.quote ?? "", x?.url ?? "");
  }

  for (const [i, p] of f.people.entries()) {
    if (!p.name.trim() || verify(p.name, p.url, pages) !== "verified") continue; // person must really be on the site
    await d.query(`insert into contacts (company_id,name,role,email,email_status,phone,source_url,rank)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (company_id,name) do update set role=excluded.role,
      email=coalesce(nullif(excluded.email,''),contacts.email), phone=excluded.phone, source_url=excluded.source_url`,
      [c.id, p.name.trim(), p.role, p.email || null, p.email ? "published" : null, p.phone || null, p.url, i + 1]);
  }
  await d.query("update companies set is_hv=$2, is_hv_reason=$3 where id=$1", [c.id, f.is_property_manager, f.kind_reason]);
  return "ok";
}

async function main() {
  const d = await db();
  const force = process.argv.includes("--force");
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0);
  const { rows } = await d.query<any>(
    `select c.id, c.name, c.website from companies c where c.crawl_status='ok'
     ${force ? "" : "and not exists (select 1 from facts f where f.company_id=c.id)"} order by c.id ${limitArg ? `limit ${limitArg}` : ""}`);
  console.log(`extracting ${rows.length} companies with ${models.extract}`);
  const limit = pLimit(8);
  let done = 0; const stats: Record<string, number> = {};
  await Promise.all(rows.map((c) => limit(async () => {
    const r = await processCompany(c).catch((e) => { console.error(c.name, String(e?.message ?? e).slice(0, 200)); return "error"; });
    stats[r] = (stats[r] ?? 0) + 1;
    if (++done % 20 === 0) console.log(`${done}/${rows.length}`, stats);
  })));
  const cost = await d.query<any>("select round(sum(cost_usd)::numeric,2) usd, count(*) calls from llm_calls where stage='extract'");
  console.log("done", stats, "extract cost so far:", cost.rows[0]);
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
