// Stage 6: research agents (Claude Agent SDK) for the top leads.
// An orchestrator delegates each company to a company-researcher subagent and a
// linkedin-finder subagent; findings are written through the verified "heidi" MCP tools.
//   tsx 06_research.ts [--limit=N] [--batch=5] [--ids=1,2,3] [--force]
import { db } from "../lib/db.ts";
import { runResearch } from "../agents/research/agents.ts";
import { stats } from "../agents/research/tools.ts";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

async function main() {
  const d = await db();
  const limit = Number(arg("limit") ?? 200), batch = Number(arg("batch") ?? 5);
  const ids = arg("ids")?.split(",").map(Number);
  const force = process.argv.includes("--force");
  const { rows } = await d.query<any>(ids
    ? `select c.id, c.name, c.website from companies c where c.id = any($1)`
    : `select c.id, c.name, c.website from companies c join scores s on s.company_id=c.id
       where s.tier in ('A','B') ${force ? "" : `and not exists (select 1 from facts f where f.company_id=c.id and f.field='researched' and f.extractor='agent-sdk')`}
       order by s.score desc limit $1`, [ids ?? limit]);
  console.log(`agents: researching ${rows.length} companies in batches of ${batch}`);
  let total = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const t0 = Date.now();
    const r = await runResearch(part, (line) => console.log(line));
    total += r.cost;
    await d.query(`insert into llm_calls (stage,company_id,model,input_tokens,output_tokens,cost_usd,ms,ok) values ('agents',$1,'agent-sdk',0,0,$2,$3,$4)`,
      [part[0].id, r.cost, Date.now() - t0, r.ok]);
    console.log(`batch ${i / batch + 1}: ${part.length} companies, ${r.turns} turns, ${r.ok ? "ok" : "stopped"}`, stats);
  }
  console.log("agents done", stats, `cost ${total.toFixed(2)}`);
}

main().then(async () => (await db()).close()).catch((e) => { console.error(e); process.exit(1); });
