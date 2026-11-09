// In-process MCP server "heidi": the agents' only way to read and write lead data.
// Every write is checked here, in code, before it reaches the database:
//   - source_url must be a page the agents actually saw in this run (tracked by hooks)
//   - LinkedIn URLs must be /in/ profiles whose slug matches the person's name
//   - facts already stated on the company's own website are never overwritten
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../../lib/db.ts";
import { roleRank, splitName } from "../../lib/names.ts";

/** URLs the agents saw in this run (search results + fetched pages), filled by hooks. */
export const visited = new Set<string>();
export const stats = { accepted: 0, rejected: 0, linkedin: 0 };

const safeDecode = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };
export const normUrl = (u: string) => safeDecode(u.trim()).toLowerCase().replace(/^https?:\/\//, "")
  .replace(/^(www|[a-z]{2})\.linkedin\.com/, "linkedin.com").replace(/^www\./, "").split(/[?#]/)[0].replace(/\/+$/, "");

export function rememberUrls(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  for (const m of text.match(/https?:\/\/[^\s"'<>\\)\]]+/g) ?? []) visited.add(normUrl(m));
}
const seen = (u: string) => !!u && visited.has(normUrl(u));

function slugMatches(url: string, name: string) {
  const n = splitName(name); if (!n) return false;
  const slug = safeDecode(url.split("/in/")[1] ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  return slug.includes(n.last) || slug.includes(n.last.replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u"));
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export const heidiServer = createSdkMcpServer({
  name: "heidi",
  version: "1.0.0",
  instructions: "Lead database for Heidi Systems. Read a company with get_company; record findings with record_fact / record_person. Writes are verified against the pages you actually visited.",
  tools: [
    tool("get_company", "Read what is already known about a company: name, website, address, stated facts and known people.",
      { company_id: z.number().int() },
      async ({ company_id }) => {
        const d = await db();
        const c = (await d.query<any>("select id, name, website, address, district from companies where id=$1", [company_id])).rows[0];
        if (!c) return ok(`No company with id ${company_id}.`);
        const facts = (await d.query<any>(`select field, value, confidence from facts where company_id=$1
          and field in ('units_managed','employees','associations','management_types','kind','summary')`, [company_id])).rows;
        const people = (await d.query<any>("select name, role, linkedin from contacts where company_id=$1 order by rank nulls last limit 8", [company_id])).rows;
        return ok(JSON.stringify({ ...c, facts, people }, null, 1));
      }),

    tool("record_fact", "Record a fact you found, with the page URL you saw it on and a short verbatim quote. Rejected if the URL was not visited in this run.",
      {
        company_id: z.number().int(),
        field: z.enum(["units_managed", "employees", "vdiv_member"]),
        value: z.number().describe("Integer; for vdiv_member use 1"),
        source_url: z.string(),
        quote: z.string(),
      },
      async ({ company_id, field, value, source_url, quote }) => {
        if (!seen(source_url)) { stats.rejected++; return ok(`REJECTED: ${source_url} was not opened or returned by a search in this run.`); }
        const d = await db();
        if (field === "vdiv_member") {
          await d.query(`update facts set value = (select to_jsonb(array(select distinct x from jsonb_array_elements_text(coalesce(value,'[]'::jsonb) || '["VDIV"]'::jsonb) x)))
            where company_id=$1 and field='associations'`, [company_id]);
        } else {
          // never overwrite a value stated on the company's own website
          await d.query(`insert into facts (company_id,field,value,confidence,evidence,source_url,extractor,checked)
            values ($1,$2,$3,'web',$4,$5,'agent-sdk','grounded') on conflict (company_id,field) do update set value=excluded.value,
            confidence=excluded.confidence, evidence=excluded.evidence, source_url=excluded.source_url, extractor=excluded.extractor,
            checked=excluded.checked where facts.value = 'null'::jsonb or facts.confidence <> 'stated'`,
            [company_id, field, JSON.stringify(Math.round(value)), quote.slice(0, 300), source_url]);
        }
        stats.accepted++;
        return ok(`ACCEPTED: ${field}=${value}`);
      }),

    tool("record_person", "Record a decision-maker (and their LinkedIn profile if found). source_url = where you saw the person.",
      {
        company_id: z.number().int(),
        name: z.string(),
        role: z.string(),
        linkedin_url: z.string().describe("linkedin.com/in/... or empty"),
        source_url: z.string(),
      },
      async ({ company_id, name, role, linkedin_url, source_url }) => {
        let li: string | null = linkedin_url?.trim() || null;
        const notes: string[] = [];
        if (li && (!/linkedin\.com\/in\//i.test(li) || !seen(li) || !slugMatches(li, name))) { notes.push("LinkedIn URL rejected (not seen in results or name mismatch)"); li = null; stats.rejected++; }
        if (!li && !seen(source_url)) { stats.rejected++; return ok(`REJECTED: ${source_url} was not visited in this run.`); }
        const d = await db();
        await d.query(`insert into contacts (company_id,name,role,linkedin,source_url,rank) values ($1,$2,$3,$4,$5,$6)
          on conflict (company_id,name) do update set linkedin=coalesce(excluded.linkedin, contacts.linkedin)`,
          [company_id, name.trim(), role, li ? li.split("?")[0] : null, li ?? source_url, roleRank(role)]);
        stats.accepted++; if (li) stats.linkedin++;
        return ok(`ACCEPTED: ${name}${li ? " with LinkedIn" : ""}${notes.length ? " (" + notes.join("; ") + ")" : ""}`);
      }),

    tool("finish_company", "Mark a company as researched, with short notes (sources used, conflicts found).",
      { company_id: z.number().int(), notes: z.string() },
      async ({ company_id, notes }) => {
        await (await db()).query(`insert into facts (company_id,field,value,confidence,extractor) values ($1,'researched',$2,'model','agent-sdk')
          on conflict (company_id,field) do update set value=excluded.value, extractor=excluded.extractor`, [company_id, JSON.stringify(notes)]);
        return ok("done");
      }),
  ],
});
