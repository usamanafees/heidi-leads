// Thin wrapper around the Anthropic SDK: one place for model choice, retries,
// refusal handling and per-call cost logging (llm_calls table).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { db } from "./db.ts";
import { loadYaml } from "./env.ts";

export const client = new Anthropic({ maxRetries: 4 });
export const models = loadYaml<Record<string, string>>("config/models.yaml");

// $ per 1M tokens (input, output) - for the cost report
const PRICE: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5],
};

export async function logCall(stage: string, companyId: number | null, model: string,
  usage: { input_tokens?: number | null; output_tokens?: number | null } | null, ms: number, ok: boolean, error?: string) {
  const [pi, po] = PRICE[model] ?? [0, 0];
  const it = usage?.input_tokens ?? 0, ot = usage?.output_tokens ?? 0;
  await (await db()).query(
    `insert into llm_calls (stage,company_id,model,input_tokens,output_tokens,cost_usd,ms,ok,error) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [stage, companyId, model, it, ot, (it * pi + ot * po) / 1e6, ms, ok, error ?? null]);
}

/** Structured extraction: returns parsed object matching `schema`, or throws. */
export async function extract<T extends z.ZodType>(opts: {
  stage: string; companyId: number; model: string; system: string; user: string; schema: T;
  effort?: "low" | "medium" | "high";
}): Promise<z.infer<T>> {
  const t0 = Date.now();
  try {
    const res = await client.messages.parse({
      model: opts.model,
      max_tokens: 8000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      output_config: { format: zodOutputFormat(opts.schema), effort: opts.effort ?? "low" },
    });
    await logCall(opts.stage, opts.companyId, opts.model, res.usage, Date.now() - t0, res.stop_reason !== "refusal");
    if (res.stop_reason === "refusal") throw new Error("refusal");
    if (!res.parsed_output) throw new Error(`unparsed (stop_reason=${res.stop_reason})`);
    return res.parsed_output;
  } catch (e: any) {
    if (!String(e?.message).startsWith("refusal") && !String(e?.message).startsWith("unparsed"))
      await logCall(opts.stage, opts.companyId, opts.model, null, Date.now() - t0, false, String(e?.message ?? e).slice(0, 300));
    throw e;
  }
}
