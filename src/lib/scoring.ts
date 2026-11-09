import { byBestContact } from "./names.ts";
// Pure scoring function: (criteria config, company, facts, contacts) -> score/tier/reasons. No I/O.
const BIG_PROVIDERS = /ista|techem|brunata|minol|kalo|metrona|qundis|zenner|bfw|messdienst gmbh/i;

export type Facts = Record<string, { value: any; confidence: string; evidence: string | null; source_url: string | null }>;

export function scoreCompany(cfg: any, c: any, f: Facts, contacts: any[]) {
  const v = (k: string) => f[k]?.value ?? null;
  const reasons: string[] = [];
  const C = cfg.criteria;

  // ---- gates ----
  const kind = v("kind");
  const types: string[] = v("management_types") ?? [];
  const gateFails: string[] = [];
  if (cfg.gates.must_be_property_manager && v("is_property_manager") === false) gateFails.push("not a property manager");
  if (cfg.gates.must_manage_residential && types.length && types.every((t) => t === "gewerbe")) gateFails.push("commercial only");
  if ((cfg.gates.exclude_kinds ?? []).includes(kind)) gateFails.push(`excluded kind: ${kind}`);
  if (/heidi/i.test(v("metering_provider") ?? "")) gateFails.push("already a Heidi customer");

  // ---- size ----
  let units: number | null = v("units_managed"), unitsBasis = units ? "stated" : "unknown";
  if (!units && v("employees")) { units = Math.round(v("employees") * C.size.units_per_employee); unitsBasis = "estimated from staff"; }
  let size = C.size.unknown_score;
  // bands checked top to bottom by their upper bound; the last band is open-ended (same rule as the sheet)
  if (units) size = (C.size.bands.find((b: any) => units! <= b.max) ?? C.size.bands.at(-1)).score;
  if (units) reasons.push(`${unitsBasis === "stated" ? "" : "~"}${units.toLocaleString("de-DE")} units${unitsBasis === "stated" ? "" : " (est.)"}`);

  // ---- segment fit ----
  const P = C.segment_fit.points;
  let seg = 0;
  if (types.includes("weg")) seg += P.weg;
  if (types.includes("mietverwaltung")) seg += P.mietverwaltung;
  if (types.includes("sev")) seg += P.sev;
  if (types.length && types.every((t) => t === "gewerbe")) seg += P.gewerbe_only_penalty;
  seg = Math.max(0, Math.min(1, seg));
  if (types.length) reasons.push(types.map((t) => ({ weg: "WEG", mietverwaltung: "rental", sev: "SEV", gewerbe: "commercial" } as any)[t]).join("+"));

  // ---- switch trigger ----
  const T = C.switch_trigger.points;
  let trig = 0;
  const prov = v("metering_provider");
  if (prov && BIG_PROVIDERS.test(prov)) { trig += T.uses_big_provider; reasons.push(`uses ${prov}`); }
  if (v("billing_pain")) { trig += T.mentions_billing_pain; reasons.push("billing pain signal"); }
  if (!v("mentions_remote_reading")) trig += T.no_remote_reading_mentioned;
  trig = Math.min(1, trig);

  // ---- digital readiness ----
  const D = C.digital_readiness.points;
  let dig = 0;
  if (v("software")) { dig += D.known_software; reasons.push(`software: ${v("software")}`); }
  if (v("has_portal")) { dig += D.tenant_or_owner_portal; reasons.push("has portal"); }

  // ---- reachability ----
  const R = C.reachability.points;
  const best = [...contacts].sort(byBestContact)[0];
  let reach = 0;
  if (best && (best.rank ?? 9) <= 3) reach += R.named_decision_maker;
  if (best?.email && ["published", "company_format"].includes(best.email_status)) reach += R.personal_email;
  else if (best?.email) reach += R.personal_email / 2;
  if (contacts.some((x) => x.linkedin)) reach += R.linkedin;

  // ---- channel ----
  const assoc: string[] = v("associations") ?? [];
  let chan = 0;
  if (assoc.includes("VDIV")) { chan = C.channel.points.vdiv_member; reasons.push("VDIV member"); }
  else if (assoc.length) chan = C.channel.points.other_association;

  const parts = { size, segment_fit: seg, switch_trigger: trig, digital_readiness: dig, reachability: reach, channel: chan };
  const score = Math.round(Object.entries(parts).reduce((s, [k, x]) => s + x * C[k].weight, 0));
  let tier = score >= cfg.tiers.A ? "A" : score >= cfg.tiers.B ? "B" : score >= cfg.tiers.C ? "C" : "D";
  if (gateFails.length) { tier = "X"; reasons.unshift(`EXCLUDED: ${gateFails.join(", ")}`); }
  if (v("is_property_manager") == null) { tier = "?"; reasons.unshift("no website data"); }
  // Raw 0/1 inputs, so the spreadsheet can recompute the score with formulas from editable weights.
  const b = (x: any) => (x ? 1 : 0);
  const inputs = {
    units_stated: v("units_managed") ?? 0, employees: v("employees") ?? 0,
    weg: b(types.includes("weg")), miet: b(types.includes("mietverwaltung")), sev: b(types.includes("sev")),
    commercial_only: b(types.length && types.every((t) => t === "gewerbe")),
    big_provider: b(prov && BIG_PROVIDERS.test(prov)), billing_pain: b(v("billing_pain")), remote_reading: b(v("mentions_remote_reading")),
    software: b(v("software")), portal: b(v("has_portal")),
    dm_named: b(best && (best.rank ?? 9) <= 3), email_strong: b(best?.email && ["published", "company_format"].includes(best.email_status)),
    email_any: b(best?.email), linkedin: b(contacts.some((x) => x.linkedin)),
    vdiv: b(assoc.includes("VDIV")), other_assoc: b(assoc.length && !assoc.includes("VDIV")),
    gate: gateFails.join(", "), no_data: b(v("is_property_manager") == null),
  };
  return { score, tier, parts, units, unitsBasis, reasons: reasons.join(" · "), inputs };
}

