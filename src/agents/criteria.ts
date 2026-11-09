// Criteria assistant: change the lead criteria in plain language, re-score, see what moved.
//   npm run criteria -- "Focus on WEG managers and ignore anyone under 100 units"
// Claude edits config/criteria.yaml; code validates it (parses, same structure, weights = 100)
// before anything is written. Old file is kept as criteria.yaml.bak.
import { z } from "zod";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parse } from "yaml";
import { ROOT } from "../lib/env.ts";
import { client, models } from "../lib/llm.ts";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const FILE = path.join(ROOT, "config/criteria.yaml");
const request = process.argv.slice(2).join(" ").trim();
if (!request) { console.log('Usage: npm run criteria -- "your change in plain words"'); process.exit(1); }

async function snapshot() {
  const { db } = await import("../lib/db.ts");
  const d = await db();
  const r = await d.query<any>("select s.company_id, s.tier, s.score, c.name from scores s join companies c on c.id=s.company_id");
  await d.close();
  return new Map(r.rows.map((x: any) => [x.company_id, x]));
}

function validate(y: string, old: any) {
  const cfg = parse(y);
  for (const k of ["gates", "criteria", "tiers"]) if (!cfg?.[k]) throw new Error(`missing section: ${k}`);
  for (const k of Object.keys(old.criteria)) if (!cfg.criteria[k]) throw new Error(`criterion removed: ${k} (set weight 0 instead)`);
  const sum = Object.values<any>(cfg.criteria).reduce((s, c) => s + Number(c.weight ?? 0), 0);
  if (sum !== 100) throw new Error(`weights sum to ${sum}, must be 100`);
  return cfg;
}

async function main() {
  const oldText = readFileSync(FILE, "utf8");
  const old = parse(oldText);
  const res = await client.messages.parse({
    model: models.criteria, max_tokens: 8000,
    system: `You maintain a YAML lead-scoring config for Heidi Systems (metering service selling to property managers).
Apply the user's change with the smallest edit. Keep every existing key and comment style. Weights must still sum to 100
(rebalance others proportionally if needed). New ideas that the scorer cannot compute must NOT be invented as new keys -
instead explain in "not_possible". Only use existing knobs: gates, criteria.*.weight, bands, points, units_per_employee, tiers.`,
    messages: [{ role: "user", content: `CURRENT FILE:\n${oldText}\n\nCHANGE REQUEST: ${request}` }],
    output_config: { format: zodOutputFormat(z.object({ yaml: z.string(), summary: z.string(), not_possible: z.string() })), effort: "medium" },
  });
  const out = res.parsed_output!;
  validate(out.yaml, old);
  const before = await snapshot();
  copyFileSync(FILE, FILE + ".bak");
  writeFileSync(FILE, out.yaml.endsWith("\n") ? out.yaml : out.yaml + "\n");
  console.log("Change:", out.summary);
  if (out.not_possible) console.log("Not possible with current data:", out.not_possible);
  execFileSync("npx", ["tsx", path.join(ROOT, "src/stages/07_score.ts")], { stdio: "inherit", cwd: ROOT });
  const after = await snapshot();
  const moved = [...after.values()].filter((a: any) => before.get(a.company_id)?.tier !== a.tier && a.tier !== "?");
  const up = moved.filter((a: any) => "ABCDX".indexOf(a.tier) < "ABCDX".indexOf(before.get(a.company_id)?.tier ?? "X"));
  console.log(`\n${moved.length} companies changed tier (${up.length} up, ${moved.length - up.length} down). Examples:`);
  for (const a of moved.slice(0, 12)) console.log(`  ${before.get(a.company_id)?.tier} -> ${a.tier}  ${a.name}`);
  console.log("\nUndo: cp config/criteria.yaml.bak config/criteria.yaml && npm run score");
}

main().catch((e) => { console.error("Rejected:", e.message); process.exit(1); });
