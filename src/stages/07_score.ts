// Stage 7: score every company from config/criteria.yaml. Pure function of stored facts:
// re-run after editing the YAML, no scraping or LLM calls needed.
import { db } from "../lib/db.ts";
import { loadYaml } from "../lib/env.ts";

import { scoreCompany, type Facts } from "../lib/scoring.ts";

async function main() {
  const d = await db();
  const cfg = loadYaml("config/criteria.yaml");
  await d.exec(`create table if not exists scores (company_id int primary key, score int, tier text, parts jsonb,
     units int, units_basis text, reasons text, scored_at timestamptz default now())`);
  const { rows: companies } = await d.query<any>("select * from companies");
  const { rows: facts } = await d.query<any>("select * from facts");
  const { rows: contacts } = await d.query<any>("select * from contacts order by company_id, rank nulls last, id"); // same order as export
  const fBy = new Map<number, Facts>();
  for (const f of facts) (fBy.get(f.company_id) ?? fBy.set(f.company_id, {}).get(f.company_id)!)[f.field] = f;
  const tiers: Record<string, number> = {};
  for (const c of companies) {
    const s = scoreCompany(cfg, c, fBy.get(c.id) ?? {}, contacts.filter((x) => x.company_id === c.id));
    tiers[s.tier] = (tiers[s.tier] ?? 0) + 1;
    await d.query(`insert into scores (company_id,score,tier,parts,units,units_basis,reasons) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (company_id) do update set score=excluded.score, tier=excluded.tier, parts=excluded.parts, units=excluded.units,
      units_basis=excluded.units_basis, reasons=excluded.reasons, scored_at=now()`,
      [c.id, s.score, s.tier, JSON.stringify(s.parts), s.units, s.unitsBasis, s.reasons]);
  }
  console.log("tiers:", tiers);
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
