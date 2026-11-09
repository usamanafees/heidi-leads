// Stage 8: export to Excel (import into Google Sheets with File > Import, or open directly in Drive).
// Tabs: Leads | Contacts | Criteria | Column guide | Run stats
import ExcelJS from "exceljs";
import path from "node:path";
import { db } from "../lib/db.ts";
import { loadYaml, ROOT } from "../lib/env.ts";
import { scoreCompany } from "../lib/scoring.ts";
import { byBestContact } from "../lib/names.ts";

// Some listings are named just "Hausverwaltung" - add the domain so the row is identifiable.
const GENERIC_NAME = /^(haus|immobilien|weg|miet)?\s*-?\s*(verwaltung|hausverwaltung|immobilienverwaltung|immobilien)( berlin)?$/i;
const displayName = (c: any) => (GENERIC_NAME.test(c.name.trim()) && c.domain && !c.domain.startsWith("nosite:") ? `${c.name} (${c.domain})` : c.name);

const yesno = (x: any) => (x === true ? "yes" : x === false ? "no" : "");
const str = (x: any) => (x == null ? "" : Array.isArray(x) ? x.join(", ") : String(x));

async function main() {
  const d = await db();
  const cfg = loadYaml("config/criteria.yaml");
  const { rows: companies } = await d.query<any>(`select c.*, s.score, s.tier, s.reasons, s.units, s.units_basis, s.parts
    from companies c left join scores s on s.company_id=c.id
    order by case s.tier when 'A' then 0 when 'B' then 1 when 'C' then 2 when 'D' then 3 when '?' then 4 else 5 end, s.score desc nulls last`);
  const { rows: facts } = await d.query<any>("select * from facts");
  const { rows: contacts } = await d.query<any>("select * from contacts order by company_id, rank nulls last, id");
  const F = new Map<number, Record<string, any>>();
  for (const f of facts) (F.get(f.company_id) ?? F.set(f.company_id, {}).get(f.company_id)!)[f.field] = f;
  const P = new Map<number, any[]>();
  for (const p of contacts) (P.get(p.company_id) ?? P.set(p.company_id, []).get(p.company_id)!).push(p);

  const wb = new ExcelJS.Workbook();
  wb.creator = "heidi-leads pipeline";

  // ---------------- Leads ----------------
  const start = wb.addWorksheet("Start here"); // filled at the end, once counts are known
  const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", xSplit: 3, ySplit: 1 }] });
  // Column order = what a salesperson needs first: who, why, how to reach them. Details after.
  const contactCols = (i: number) => [
    [`Contact ${i}`, 22, (_c: any, _f: any, p: any[]) => p[i - 1]?.name ?? ""],
    [`Role ${i}`, 22, (_c: any, _f: any, p: any[]) => p[i - 1]?.role ?? ""],
    [`Email ${i}`, 30, (_c: any, _f: any, p: any[]) => p[i - 1]?.email ?? ""],
    [`Email ${i} status`, 10, (_c: any, _f: any, p: any[]) => (p[i - 1]?.email ? String(p[i - 1].email_status).replace("_", " ") : "")],
    [`LinkedIn ${i}`, 30, (_c: any, _f: any, p: any[]) => p[i - 1]?.linkedin ?? ""],
  ] as [string, number, any][];
  const cols: [string, number, (c: any, f: any, p: any[]) => any][] = [
    ["Tier", 6, (c) => c.tier ?? "?"],
    ["Score", 7, (c) => c.score ?? ""],
    ["Company", 34, (c) => displayName(c)],
    ["Why (scoring reasons)", 46, (c) => c.reasons ?? ""],
    ...contactCols(1),
    ["Phone", 16, (c) => c.phone ?? ""],
    ["Website", 30, (c) => c.website ?? ""],
    ["Units managed", 10, (c) => c.units ?? ""],
    ["Units basis", 14, (c) => c.units_basis ?? ""],
    ["What they do", 50, (_c, f) => str(f.summary?.value)],
    ...contactCols(2),
    ["General email", 26, (_c, f) => str(f.general_email?.value)],
    ["District", 16, (c) => c.district ?? ""],
    ["Address", 36, (c) => c.address ?? ""],
    ["Kind", 20, (_c, f) => str(f.kind?.value)],
    ["Management types", 20, (_c, f) => str(f.management_types?.value)],
    ["Units evidence", 40, (_c, f) => f.units_managed?.evidence ?? ""],
    ["Employees", 10, (_c, f) => str(f.employees?.value)],
    ["Founded", 9, (_c, f) => str(f.founded_year?.value)],
    ["Metering provider", 16, (_c, f) => str(f.metering_provider?.value)],
    ["Software", 18, (_c, f) => str(f.software?.value)],
    ["Portal", 7, (_c, f) => yesno(f.has_portal?.value)],
    ["Mentions heating billing", 10, (_c, f) => yesno(f.mentions_heating_billing?.value)],
    ["Mentions remote reading", 10, (_c, f) => yesno(f.mentions_remote_reading?.value)],
    ["Associations", 14, (_c, f) => str(f.associations?.value)],
    ["Hiring", 7, (_c, f) => yesno(f.hiring?.value)],
    ["Google rating", 8, (c) => c.rating ?? ""],
    ["Google reviews", 8, (c) => c.rating_count ?? ""],
    ["Locations", 8, (c) => c.locations],
    ["Email pattern", 12, (_c, f) => str(f.email_pattern?.value)],
    ["Google Maps", 20, (c) => c.maps_url ?? ""],
  ];
  // Raw inputs (grey columns at the end) - the Score/Tier formulas read these + the Criteria tab.
  const INPUTS = ["units_stated", "employees", "weg", "miet", "sev", "commercial_only", "big_provider", "billing_pain", "remote_reading",
    "software", "portal", "dm_named", "email_strong", "email_any", "linkedin", "vdiv", "other_assoc", "gate", "no_data"] as const;
  const firstInput = cols.length + 1;
  ws.columns = [...cols.map(([header, width]) => ({ header, width })), ...INPUTS.map((k) => ({ header: `in: ${k}`, width: 9 }))];
  const L = (k: string) => ws.getColumn(firstInput + INPUTS.indexOf(k as any)).letter;
  const colOf = (h: string) => ws.getColumn(cols.findIndex(([x]) => x === h) + 1).letter;

  // ---------------- Criteria (editable) ----------------
  const crit = buildCriteria(wb, cfg);

  for (const c of companies) {
    const f = F.get(c.id) ?? {};
    const p = [...(P.get(c.id) ?? [])].sort(byBestContact);
    const s = scoreCompany(cfg, c, f, [...p]);
    const row = ws.addRow([...cols.map(([, , fn]) => fn(c, f, p)), ...INPUTS.map((k) => (s.inputs as any)[k])]);
    const r = row.number, at = (k: string) => `${L(k)}${r}`;
    const ueff = `IF(${at("units_stated")}>0,${at("units_stated")},ROUND(${at("employees")}*${crit.upe},0))`;
    const size = `IF(${ueff}=0,${crit.unknown},` + crit.bands.slice(0, -1).map((b) => `IF(${ueff}<=${b.max},${b.pts},`).join("") +
      crit.bands.at(-1)!.pts + ")".repeat(crit.bands.length);
    const seg = `MAX(0,MIN(1,${at("weg")}*${crit.weg}+${at("miet")}*${crit.miet}+${at("sev")}*${crit.sev}+${at("commercial_only")}*${crit.pen}))`;
    const trig = `MIN(1,${at("big_provider")}*${crit.big}+${at("billing_pain")}*${crit.pain}+(1-${at("remote_reading")})*${crit.noremote})`;
    const dig = `(${at("software")}*${crit.sw}+${at("portal")}*${crit.portal})`;
    const reach = `(${at("dm_named")}*${crit.dm}+IF(${at("email_strong")}=1,${crit.email},IF(${at("email_any")}=1,${crit.email}/2,0))+${at("linkedin")}*${crit.li})`;
    const chan = `IF(${at("vdiv")}=1,${crit.vdiv},IF(${at("other_assoc")}=1,${crit.otherassoc},0))`;
    const scoreF = `ROUND(${size}*${crit.w.size}+${seg}*${crit.w.segment_fit}+${trig}*${crit.w.switch_trigger}+${dig}*${crit.w.digital_readiness}+${reach}*${crit.w.reachability}+${chan}*${crit.w.channel},0)`;
    const S = `${colOf("Score")}${r}`;
    row.getCell(colOf("Score")).value = { formula: scoreF, result: s.score } as any;
    row.getCell(colOf("Tier")).value = { formula: `IF(${at("no_data")}=1,"?",IF(${at("gate")}<>"","X",IF(${S}>=${crit.tA},"A",IF(${S}>=${crit.tB},"B",IF(${S}>=${crit.tC},"C","D")))))`, result: s.tier } as any;
    row.getCell(colOf("Units managed")).value = { formula: `IF(${ueff}=0,"",${ueff})`, result: s.units ?? "" } as any;
  }
  styleHeader(ws);
  for (let i = firstInput; i < firstInput + INPUTS.length; i++) {
    ws.getRow(1).getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF9CA3AF" } };
    ws.getColumn(i).hidden = true; // formula inputs: hidden, still used by Score/Tier
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  const tierColor: Record<string, string> = { A: "FFC6EFCE", B: "FFFFEB9C", C: "FFFCE4D6", X: "FFE7E6E6" };
  ws.eachRow((row, i) => { if (i > 1) { const t = String(row.getCell(1).value); if (tierColor[t]) row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: tierColor[t] } }; } });

  // ---------------- Contacts ----------------
  const wc = wb.addWorksheet("Contacts", { views: [{ state: "frozen", ySplit: 1 }] });
  wc.columns = [["Company", 34], ["Tier", 6], ["Name", 24], ["Role", 26], ["Email", 32], ["Email status", 12], ["LinkedIn", 36], ["Phone", 16], ["Source", 40]]
    .map(([header, width]) => ({ header: header as string, width: width as number }));
  const byId = new Map(companies.map((c: any) => [c.id, c]));
  for (const p of contacts) {
    const c: any = byId.get(p.company_id);
    if (!c) continue;
    wc.addRow([c.name, c.tier ?? "", p.name, p.role, p.email ?? "", p.email ? String(p.email_status).replace("_", " ") : "", p.linkedin ?? "", p.phone ?? "", p.source_url ?? ""]);
  }
  styleHeader(wc);
  wc.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };

  // ---------------- Column guide ----------------
  const wg = wb.addWorksheet("Column guide");
  wg.columns = [{ header: "Column", width: 24 }, { header: "Meaning / source", width: 100 }];
  for (const [k, v] of [
    ["Units basis", "stated = quoted from the company's own site (see Units evidence) · web = found by research agent with a source · estimated from staff = employees × 180"],
    ["Email status", "published = printed on the company website · company format = built from the company's real address format (learned from a colleague's published email) · standard format = vorname.nachname@ on a domain with a live mail server; in production confirmed with a verification service (e.g. ZeroBounce, NeverBounce) before outreach. Start outreach with published / company format."],
    ["Metering provider", "Named Messdienst (ista, Techem, Brunata, Minol, Kalo ...). Big provider => switch candidate."],
    ["Mentions remote reading", "no = nothing about Funk/Fernablesung on the site => likely still needs to retrofit before 1.1.2027"],
    ["Kind", "independent_manager · housing_company_or_coop · municipal_housing · broker_mainly · facility_or_other"],
    ["Evidence", "Every website fact is backed by a verbatim quote that the pipeline verified exists on the page; unverifiable values are dropped."],
  ]) wg.addRow([k, v]);
  styleHeader(wg);

  // ---------------- Run stats ----------------
  const wr = wb.addWorksheet("Run stats");
  wr.columns = [{ header: "Metric", width: 40 }, { header: "Value", width: 20 }];
  const q = async (sql: string) => Object.values((await d.query<any>(sql)).rows[0])[0];
  for (const [k, sql] of [
    ["Places found (Google)", "select count(*) from places"],
    ["Companies (deduplicated)", "select count(*) from companies"],
    ["Websites crawled OK", "select count(*) from companies where crawl_status='ok'"],
    ["Confirmed property managers", "select count(*) from companies where is_hv"],
    ["Tier A", "select count(*) from scores where tier='A'"],
    ["Tier B", "select count(*) from scores where tier='B'"],
    ["Named contacts", "select count(*) from contacts"],
    ["Contacts with email (published / company format)", "select count(*) from contacts where email_status in ('published','company_format')"],
    ["Contacts with LinkedIn", "select count(*) from contacts where linkedin is not null"],
  ]) wr.addRow([k, Number(await q(sql))]);
  styleHeader(wr);

  // ---------------- Start here ----------------
  const n = async (sql: string) => Number(Object.values((await d.query<any>(sql)).rows[0])[0]);
  const [nA, nB, nHv, nAll] = [await n("select count(*) from scores where tier='A'"), await n("select count(*) from scores where tier='B'"),
    await n("select count(*) from companies where is_hv"), companies.length];
  start.columns = [{ width: 26 }, { width: 110 }];
  const title = start.addRow(["Berlin property managers: lead list for Heidi Systems"]);
  title.font = { bold: true, size: 16 };
  start.addRow([`${nAll} companies found · ${nHv} confirmed property managers · ${nA} A-leads · ${nB} B-leads`]).font = { italic: true };
  start.addRow([]);
  const block = (head: string, lines: [string, string][]) => {
    const h = start.addRow([head]); h.font = { bold: true, color: { argb: "FFFFFFFF" } };
    h.getCell(1).fill = h.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } } as any;
    for (const [a, b] of lines) { const r = start.addRow([a, b]); r.getCell(1).font = { bold: true }; r.alignment = { wrapText: true, vertical: "top" }; }
    start.addRow([]);
  };
  block("How to use it (2 minutes)", [
    ["1. Leads tab", "One row per company, best first. Filter Tier = A to get the call list for this week."],
    ["2. Read across", "Why = the reasons behind the score. Contact 1 = the best person to reach (role, email, LinkedIn, phone)."],
    ["3. Need someone else?", "Contacts tab = every named person we found at each company (filter by company)."],
    ["4. Disagree with the ranking?", "Criteria tab: change any yellow cell (e.g. weight of company size). Scores and tiers update instantly; re-sort Leads by Score."],
    ["5. Other search terms or city?", "The search terms, sources and city are one settings file (config/search.yaml). Change it and re-run the pipeline for a new list, scored with the same criteria."],
  ]);
  block("Tiers", [
    ["A  (score ≥ 70)", "Call this week: right type, big enough, a reason to switch, reachable."],
    ["B  (≥ 50) / C (≥ 30) / D", "Sequence / nurture / low priority."],
    ["X", "Excluded: not a property manager, commercial only, municipal housing, or already a Heidi customer."],
    ["?", "No website data (no site, or the site blocked us). Kept so the list is complete, but not scored."],
  ]);
  block("How sure is each value?", [
    ["Email status", "published = printed on the company website · company format = built from the company's real address format (learned from a colleague's published email) · standard format = vorname.nachname@ on a domain with a live mail server; in production confirmed with a verification service (e.g. ZeroBounce, NeverBounce) before outreach. Start outreach with published / company format."],
    ["Units basis", "stated = quoted from their own website (see Units evidence) · web = found by the research agent with a source · estimated from staff = employees × 180."],
    ["LinkedIn", "Only profiles that appeared in a real search result and match the person's name. Researched for the top (A-tier) leads."],
    ["Accuracy check", "An independent model re-read 30 random companies' pages: 98% of extracted facts confirmed."],
  ]);
  const [nFail, nProv, nResearched] = [
    await n("select count(*) from companies where crawl_status like 'failed%'"),
    await n("select count(*) from facts where field='metering_provider' and value <> 'null'"),
    await n("select count(*) from facts where field='researched'")];
  block("Scope decisions & production path", [
    ["Protected websites", `${nFail} sites use bot protection. The crawler respects that and skips them (tier "?"). In production: a managed scraping service (e.g. Bright Data, Zyte) or a headless browser covers these.`],
    ["Email verification", `Every email carries its evidence level (published / company format / standard format). In production, a verification service (e.g. ZeroBounce, NeverBounce) confirms deliverability before outreach.`],
    ["Current metering provider", `Rarely published (named by ${nProv} companies). Next signal: tenant reviews and published utility-cost statements.`],
    ["Research depth", `Web research + LinkedIn run for A- and B-tier leads (${nResearched} companies), so spend follows lead value.`],
  ]);
  block("Tabs", [
    ["Leads", "The list. Columns: who + why + how to reach first, details after."],
    ["Contacts", "All named people (one row per person)."],
    ["Criteria", "The scoring weights, editable (yellow cells)."],
    ["Column guide", "What each column means and where it comes from."],
    ["Run stats", "Counts from the run that produced this sheet."],
  ]);

  const out = path.join(ROOT, "output", "berlin_hausverwaltungen.xlsx");
  await (await import("node:fs/promises")).mkdir(path.dirname(out), { recursive: true });
  await wb.xlsx.writeFile(out);
  console.log("wrote", out, `(${companies.length} companies, ${contacts.length} contacts)`);
}

/** Criteria tab: every weight/threshold is an editable (yellow) cell. Returns absolute cell refs for the formulas. */
function buildCriteria(wb: ExcelJS.Workbook, cfg: any) {
  const wk = wb.addWorksheet("Criteria", { views: [{ state: "frozen", ySplit: 3 }] });
  wk.columns = [{ width: 34 }, { width: 12 }, { width: 100 }];
  wk.addRow(["Change any yellow cell. Score and Tier on the Leads tab update instantly; then sort Leads by Score."]).font = { bold: true, size: 13 };
  wk.addRow(["Starting values come from config/criteria.yaml (the code's copy). Weights should add up to 100 (check below)."]).font = { italic: true };
  const hdr = wk.addRow(["Setting", "Value", "Why it matters for Heidi"]);
  hdr.font = { bold: true, color: { argb: "FFFFFFFF" } };
  hdr.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } }));
  const ref = (r: number, col = "B") => `Criteria!$${col}$${r}`;
  const yellow = (cell: ExcelJS.Cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } });
  const section = (t: string) => { const r = wk.addRow([t]); r.font = { bold: true }; r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } }; };
  const setting = (label: string, value: number, why = "") => { const r = wk.addRow([label, value, why]); yellow(r.getCell(2)); return ref(r.number); };
  const C = cfg.criteria;

  section("Weights (points out of 100)");
  const w: Record<string, string> = {};
  const wRows: number[] = [];
  for (const [k, v] of Object.entries<any>(C)) { w[k] = setting(`Weight: ${k}`, v.weight, v.why); wRows.push(Number(w[k].split("$").pop())); }
  const sum = wk.addRow(["Sum of weights (should be 100)", { formula: `SUM(B${wRows[0]}:B${wRows.at(-1)})`, result: 100 }]);
  sum.font = { bold: true };

  section("Size: units managed → points (0–1). Bands checked top to bottom: 'up to N units'");
  const bands = C.size.bands.map((b: any, i: number) => {
    const r = wk.addRow([`Band ${i + 1}: up to N units →`, b.score, ""]);
    r.getCell(3).value = i === C.size.bands.length - 1 ? "(everything above the previous band)" : b.max;
    yellow(r.getCell(2)); if (i < C.size.bands.length - 1) yellow(r.getCell(3));
    return { max: ref(r.number, "C"), pts: ref(r.number) };
  });
  const unknown = setting("Points when size unknown", C.size.unknown_score);
  const upe = setting("Units per employee (estimate when units not stated)", C.size.units_per_employee);

  section("Segment fit points (capped 0–1)");
  const S = C.segment_fit.points;
  const weg = setting("Manages WEGs", S.weg), miet = setting("Manages rentals", S.mietverwaltung), sev = setting("Sondereigentum (SEV)", S.sev);
  const pen = setting("Commercial-only penalty", S.gewerbe_only_penalty);
  section("Switch trigger points (capped at 1)");
  const T = C.switch_trigger.points;
  const big = setting("Uses a big provider (ista, Techem, ...)", T.uses_big_provider), pain = setting("Billing pain signal", T.mentions_billing_pain);
  const noremote = setting("No remote reading mentioned", T.no_remote_reading_mentioned);
  section("Digital readiness points");
  const D = C.digital_readiness.points;
  const sw = setting("Named software", D.known_software), portal = setting("Owner/tenant portal", D.tenant_or_owner_portal);
  section("Reachability points");
  const R = C.reachability.points;
  const dm = setting("Named decision-maker", R.named_decision_maker), email = setting("Personal email (published / company format; standard format = half)", R.personal_email);
  const li = setting("LinkedIn profile", R.linkedin);
  section("Channel points");
  const vdiv = setting("VDIV member", C.channel.points.vdiv_member), otherassoc = setting("Other association (IVD, BVI ...)", C.channel.points.other_association);
  section("Tier thresholds (score ≥)");
  const tA = setting("Tier A (call this week)", cfg.tiers.A), tB = setting("Tier B (sequence)", cfg.tiers.B), tC = setting("Tier C (nurture)", cfg.tiers.C);
  section("Fixed rules (in code / YAML)");
  wk.addRow(["Gates → tier X", "", "Not a property manager · commercial only · municipal housing · already a Heidi customer"]);
  wk.addRow(["Tier ?", "", "No website data - kept in the list, not scored"]);
  wk.addRow(["New criterion", "", "Add a field to the extraction schema, re-run on stored pages (no re-scraping), add its weight here."]);
  return { w, bands, unknown, upe, weg, miet, sev, pen, big, pain, noremote, sw, portal, dm, email, li, vdiv, otherassoc, tA, tB, tC };
}

function styleHeader(ws: ExcelJS.Worksheet) {
  const r = ws.getRow(1);
  r.font = { bold: true, color: { argb: "FFFFFFFF" } };
  r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
  r.alignment = { vertical: "middle", wrapText: true };
  r.height = 32;
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
