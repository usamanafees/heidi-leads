// Stage 5: turn named people into reachable contacts.
// Email confidence ladder:
//   published       - the address is printed on the company website
//   company_format  - built from the company's own address format, learned from a colleague's real address
//   standard_format - standard German business format (vorname.nachname@) on a domain with a live mail server;
//                     production: confirmed by a verification service (e.g. ZeroBounce) before outreach
import { promises as dns } from "node:dns";
import { db } from "../lib/db.ts";
import { splitName, apply, detect, roleRank, type Pattern } from "../lib/names.ts";

const GENERIC = /^(info|kontakt|contact|office|mail|post|service|verwaltung|hausverwaltung|hv|team|empfang|zentrale|buero|büro|bewerbung|jobs|karriere|datenschutz|technik|vermietung|abrechnung|buchhaltung|weg|miete|mietverwaltung|immobilien|anfrage|hallo|hello|kundenservice|support|notdienst|rechnung|invoice|admin|webmaster|presse|marketing|sekretariat|objektbetreuung|hausmeister|noreply|no-reply)\b/i;
const mxCache = new Map<string, boolean>();
async function hasMx(domain: string) {
  if (!mxCache.has(domain)) mxCache.set(domain, await dns.resolveMx(domain).then((r) => r.length > 0).catch(() => false));
  return mxCache.get(domain)!;
}

async function main() {
  const d = await db();
  const { rows: companies } = await d.query<any>(`select id, domain from companies where crawl_status='ok'`);
  const stats: Record<string, number> = {};
  for (const c of companies) {
    const { rows: em } = await d.query<{ e: string }>(`select distinct unnest(emails) e from pages where company_id=$1`, [c.id]);
    const siteEmails = em.map((r) => r.e).filter((e) => e.endsWith("@" + c.domain) || e.split("@")[1]?.endsWith("." + c.domain));
    const personal = siteEmails.filter((e) => !GENERIC.test(e.split("@")[0]));
    const generic = siteEmails.filter((e) => GENERIC.test(e.split("@")[0]));
    const { rows: people } = await d.query<any>(`select id, name, role, email, email_status from contacts where company_id=$1`, [c.id]);

    // 1) learn the company's pattern from any personal address that matches a known name
    let pattern: Pattern | null = null;
    const allNames = people.map((p: any) => splitName(p.name)).filter(Boolean) as { first: string; last: string }[];
    for (const e of personal) {
      const local = e.split("@")[0];
      for (const n of allNames) { const p = detect(local, n); if (p) { pattern = p; break; } }
      if (pattern) break;
    }
    // weaker: a personal address shaped like x.y implies first.last
    if (!pattern && personal.some((e) => /^[a-z]{2,}\.[a-z]{2,}$/.test(e.split("@")[0]))) pattern = "first.last";
    if (!pattern && personal.some((e) => /^[a-z]\.[a-z]{2,}$/.test(e.split("@")[0]))) pattern = "f.last";

    const mx = await hasMx(c.domain);
    for (const p of people) {
      const n = splitName(p.name);
      let email = p.email as string | null, status = p.email_status as string | null;
      // 2) address printed on the site that matches this person
      if (n && !email) {
        const hit = personal.find((e) => detect(e.split("@")[0], n));
        if (hit) { email = hit; status = "published"; }
      }
      if (n && !email && pattern && mx) { email = `${apply(pattern, n)}@${c.domain}`; status = "company_format"; }
      if (n && !email && mx) { email = `${apply("first.last", n)}@${c.domain}`; status = "standard_format"; }
      if (email && GENERIC.test(email.split("@")[0])) { email = null; status = null; } // never present info@ as personal
      stats[status ?? "none"] = (stats[status ?? "none"] ?? 0) + 1;
      await d.query(`update contacts set email=$2, email_status=$3, rank=$4 where id=$1`,
        [p.id, email, status ?? "none", roleRank(p.role ?? "")]);
    }
    await d.query(`insert into facts (company_id,field,value,confidence,extractor) values ($1,'general_email',$2,'stated','rule')
      on conflict (company_id,field) do update set value=excluded.value`, [c.id, JSON.stringify(generic[0] ?? siteEmails[0] ?? null)]);
    await d.query(`insert into facts (company_id,field,value,confidence,extractor) values ($1,'email_pattern',$2,$3,'rule')
      on conflict (company_id,field) do update set value=excluded.value, confidence=excluded.confidence`,
      [c.id, JSON.stringify(pattern), pattern ? "stated" : "unknown"]);
  }
  console.log("contact emails:", stats);
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
