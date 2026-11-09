// Stage 3: crawl each company website. Fetch once, store clean text in `pages`,
// so every later stage (extraction, contacts, re-scoring) runs without re-fetching.
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { db } from "../lib/db.ts";

// Transparent crawler identity. (A fake "Chrome" UA got 503s from some hosts, e.g. Strato.)
// Sites that still refuse us are skipped, not worked around.
const UA = "heidi-leads-crawler/1.0 (B2B research; low volume)";
const MAX_PAGES = 9;
const MAX_TEXT = 25_000;

// Which internal links are worth reading, and what we call them.
const KINDS: [string, RegExp][] = [
  ["impressum", /impressum|imprint|legal-notice/i],
  ["team", /team|ansprechpartner|mitarbeiter|unser-team|wir-sind|personen/i],
  ["about", /ueber-uns|uber-uns|über-uns|about|unternehmen|wir\b|philosophie|geschichte/i],
  ["services", /leistung|service|hausverwaltung|weg-verwaltung|mietverwaltung|sondereigentum|verwaltung|angebot/i],
  ["jobs", /karriere|jobs|stellen|career/i],
  ["references", /referenz|objekte|portfolio|bestand/i],
  ["contact", /kontakt|contact/i],
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|svg|webp)$|example\.|sentry|wixpress|domain\.|@email\.|ihre-?email/i;

async function get(url: string): Promise<{ status: number; html: string; finalUrl: string } | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9" },
      redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return { status: r.status, html: "", finalUrl: r.url };
    return { status: r.status, html: await r.text(), finalUrl: r.url };
  } catch { return null; }
}

/** Decode Cloudflare-obfuscated emails (data-cfemail). Common on German SME sites. */
function cfDecode(hex: string): string {
  const k = parseInt(hex.slice(0, 2), 16);
  let s = "";
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
  return s;
}

function parse(html: string, base: string) {
  const $ = cheerio.load(html);
  const emails = new Set<string>();
  $("a[href^='mailto:']").each((_, a) => { const e = ($(a).attr("href") ?? "").slice(7).split("?")[0]; if (e) emails.add(decodeURIComponent(e)); });
  $("[data-cfemail]").each((_, el) => { const h = $(el).attr("data-cfemail"); if (h) emails.add(cfDecode(h)); });
  const links: { url: string; label: string }[] = [];
  $("a[href]").each((_, a) => {
    try {
      const u = new URL($(a).attr("href")!, base);
      if (u.hostname.replace(/^www\./, "") !== new URL(base).hostname.replace(/^www\./, "")) return;
      u.hash = "";
      links.push({ url: u.toString(), label: $(a).text().trim().slice(0, 60) });
    } catch {}
  });
  $("script,style,noscript,svg,iframe").remove();
  // keep some structure: block elements become newlines
  $("br,p,div,li,h1,h2,h3,h4,tr,section,footer,header").after("\n");
  const text = $("body").text().replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  // "name [at] domain.de" style obfuscation
  const deob = text.replace(/\s*[\[(]\s*(at|@)\s*[\])]\s*/gi, "@").replace(/\s*[\[(]\s*(dot|punkt)\s*[\])]\s*/gi, ".");
  for (const m of deob.match(EMAIL_RE) ?? []) emails.add(m);
  return {
    text: text.slice(0, MAX_TEXT), links,
    emails: [...emails].map((e) => e.toLowerCase().trim()).filter((e) => !BAD_EMAIL.test(e)),
  };
}

function classify(url: string, label: string): string | null {
  const s = `${new URL(url).pathname} ${label}`;
  for (const [kind, re] of KINDS) if (re.test(s)) return kind;
  return null;
}

async function crawlCompany(c: { id: number; website: string }) {
  const d = await db();
  const home = await get(c.website);
  if (!home || home.status >= 400 || !home.html) {
    await d.query("update companies set crawl_status=$2 where id=$1", [c.id, `failed:${home?.status ?? "network"}`]);
    return "failed";
  }
  const h = parse(home.html, home.finalUrl);
  await d.query(`insert into pages (company_id,url,kind,status,text,emails) values ($1,$2,'home',$3,$4,$5)
                 on conflict (company_id,url) do update set text=excluded.text, emails=excluded.emails, fetched_at=now()`,
    [c.id, home.finalUrl, home.status, h.text, h.emails]);

  // pick the best link per kind (first match), impressum + team first
  const picked = new Map<string, string>();
  const extra: string[] = [];
  for (const l of h.links) {
    const kind = classify(l.url, l.label);
    if (!kind || l.url === home.finalUrl) continue;
    if (!picked.has(kind)) picked.set(kind, l.url);
    else if ((kind === "services" || kind === "team") && extra.length < 2 && !extra.includes(l.url) && picked.get(kind) !== l.url) extra.push(l.url);
  }
  const queue = [...picked.entries(), ...extra.map((u) => ["other", u] as [string, string])].slice(0, MAX_PAGES - 1);
  for (const [kind, url] of queue) {
    const r = await get(url);
    if (!r || !r.html) continue;
    const p = parse(r.html, r.finalUrl);
    await d.query(`insert into pages (company_id,url,kind,status,text,emails) values ($1,$2,$3,$4,$5,$6)
                   on conflict (company_id,url) do update set text=excluded.text, emails=excluded.emails, fetched_at=now()`,
      [c.id, r.finalUrl, kind, r.status, p.text, p.emails]);
  }
  await d.query("update companies set crawl_status='ok' where id=$1", [c.id]);
  return "ok";
}

async function main() {
  const d = await db();
  const force = process.argv.includes("--force");
  const retry = process.argv.includes("--retry-failed"); // slower second pass for sites that blocked us
  const { rows } = await d.query<any>(
    `select id, website from companies where website is not null and ${force ? "true" : retry ? "(crawl_status is null or crawl_status like 'failed%')" : "crawl_status is null"} order by id`);
  console.log(`crawling ${rows.length} companies`);
  const limit = pLimit(retry ? 3 : 12);
  let done = 0; const stats: Record<string, number> = {};
  await Promise.all(rows.map((c) => limit(async () => {
    const r = await crawlCompany(c).catch(() => "error");
    stats[r] = (stats[r] ?? 0) + 1;
    if (++done % 25 === 0) console.log(`${done}/${rows.length}`, stats);
  })));
  console.log("done", stats);
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
