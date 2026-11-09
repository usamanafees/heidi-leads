// Stage 9: validation. Three layers, reported as numbers:
//  1. Rule checks over the whole dataset (postcode in city, email domain = website domain,
//     LinkedIn slug matches name, units vs. staff sanity, duplicates).
//  2. Independent judge: a stronger model (config/models.yaml: check) re-reads the source pages
//     for a random sample and grades each extracted fact correct / wrong / not-on-page.
//  3. Writes output/validation_sample.csv so a human can spot-check the same sample.
import { z } from "zod";
import pLimit from "p-limit";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "../lib/db.ts";
import { ROOT } from "../lib/env.ts";
import { extract, models } from "../lib/llm.ts";
import { splitName } from "../lib/names.ts";

const SAMPLE = Number(process.argv.find((a) => a.startsWith("--sample="))?.split("=")[1] ?? 30);
const JUDGED = ["is_property_manager", "management_types", "units_managed", "employees", "founded_year", "software", "has_portal", "associations"];

const Verdicts = z.object({
  verdicts: z.array(z.object({ field: z.string(), verdict: z.enum(["correct", "wrong", "not_on_page"]), note: z.string() })),
  people: z.array(z.object({ name: z.string(), verdict: z.enum(["correct", "wrong"]), note: z.string() })),
});

async function ruleChecks(d: any) {
  const q = async (sql: string) => Number(Object.values((await d.query(sql)).rows[0])[0]);
  const total = await q("select count(*) from contacts where email is not null");
  const domainOk = await q(`select count(*) from contacts x join companies c on c.id=x.company_id
    where x.email is not null and split_part(x.email,'@',2) like '%' || c.domain`);
  const { rows: li } = await d.query("select name, linkedin from contacts where linkedin is not null");
  const liOk = li.filter((r: any) => { const n = splitName(r.name); return n && r.linkedin.toLowerCase().includes(n.last.slice(0, 4)); }).length;
  return {
    companies: await q("select count(*) from companies"),
    duplicate_domains: await q("select count(*) - count(distinct domain) from companies"),
    postcode_outside_city: await q("select count(*) from companies where postcode is not null and (postcode::int < 10115 or postcode::int > 14199)"),
    emails_matching_company_domain: `${domainOk}/${total}`,
    linkedin_slug_matches_name: `${liOk}/${li.length}`,
    units_per_employee_outliers: await q(`select count(*) from facts u join facts e on e.company_id=u.company_id and e.field='employees'
      where u.field='units_managed' and u.value <> 'null' and e.value <> 'null' and ((u.value)::text::numeric / nullif((e.value)::text::numeric,0)) not between 20 and 1500`),
    website_facts_with_verified_quote: `${await q("select count(*) from facts where confidence='stated'")}/${await q("select count(*) from facts where evidence is not null")}`,
  };
}

async function main() {
  const d = await db();
  const rules = await ruleChecks(d);
  console.log("rule checks", rules);

  // fixed seed-ish sample: real property managers with extracted facts, spread across score range
  const { rows: sample } = await d.query<any>(`select c.id, c.name, c.website from companies c join scores s on s.company_id=c.id
    where c.crawl_status='ok' order by md5(c.id::text) limit $1`, [SAMPLE]);
  const tally: Record<string, { correct: number; wrong: number; not_on_page: number }> = {};
  const people = { correct: 0, wrong: 0 };
  const csv: string[] = ["company,field,extracted_value,evidence,judge_verdict,judge_note,source_url"];
  const limit = pLimit(4);
  await Promise.all(sample.map((c: any) => limit(async () => {
    const { rows: pages } = await d.query<any>("select url, kind, left(text, 9000) text from pages where company_id=$1 order by kind", [c.id]);
    const { rows: facts } = await d.query<any>(`select field, value, evidence, source_url from facts where company_id=$1 and field = any($2)`, [c.id, JUDGED]);
    const { rows: ppl } = await d.query<any>("select name, role from contacts where company_id=$1 and source_url not like '%linkedin%' limit 5", [c.id]);
    const claims = facts.map((f: any) => `- ${f.field} = ${JSON.stringify(f.value)}`).join("\n");
    const v = await extract({
      stage: "validate", companyId: c.id, model: models.check, schema: Verdicts, effort: "medium",
      system: `You audit data extracted from a company's website. For each claim, read the pages and answer:
correct = the pages support this value (null/false/[] is correct when the pages really don't state it),
wrong = the pages contradict it or state a different value, not_on_page = a non-empty value the pages don't support.
For people: correct if the person and role appear on the pages.`,
      user: `Company: ${c.name}\n\nCLAIMS:\n${claims}\n\nPEOPLE:\n${ppl.map((p: any) => `- ${p.name} (${p.role})`).join("\n") || "none"}\n\n` +
        pages.map((p: any) => `<page url="${p.url}">\n${p.text}\n</page>`).join("\n"),
    }).catch((e) => { console.error(c.name, e.message); return null; });
    if (!v) return;
    for (const x of v.verdicts) {
      (tally[x.field] ??= { correct: 0, wrong: 0, not_on_page: 0 })[x.verdict]++;
      const f = facts.find((f: any) => f.field === x.field);
      csv.push([c.name, x.field, JSON.stringify(f?.value ?? null), f?.evidence ?? "", x.verdict, x.note, f?.source_url ?? ""]
        .map((s) => `"${String(s).replace(/"/g, '""')}"`).join(","));
    }
    for (const p of v.people) people[p.verdict]++;
  })));
  const acc = Object.fromEntries(Object.entries(tally).map(([k, t]) => {
    const n = t.correct + t.wrong + t.not_on_page;
    return [k, `${t.correct}/${n} (${Math.round((100 * t.correct) / n)}%)`];
  }));
  const allC = Object.values(tally).reduce((s, t) => s + t.correct, 0), allN = Object.values(tally).reduce((s, t) => s + t.correct + t.wrong + t.not_on_page, 0);
  const report = { rules, judge_model: models.check, sample_companies: sample.length, field_accuracy: acc,
    overall_fact_accuracy: `${allC}/${allN} (${Math.round((100 * allC) / allN)}%)`, people_accuracy: `${people.correct}/${people.correct + people.wrong}` };
  console.log(JSON.stringify(report, null, 1));
  await writeFile(path.join(ROOT, "output/validation_sample.csv"), csv.join("\n"));
  await writeFile(path.join(ROOT, "output/validation_report.json"), JSON.stringify(report, null, 1));
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
