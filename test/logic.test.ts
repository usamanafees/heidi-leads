// Unit tests for the deterministic logic (run: npm test). No network, no DB, no LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitName, apply, detect, roleRank } from "../src/lib/names.ts";
import { scoreCompany } from "../src/lib/scoring.ts";
import { parse } from "yaml";
import { readFileSync } from "node:fs";

test("splitName strips titles and transliterates umlauts", () => {
  assert.deepEqual(splitName("Dipl.-Kfm. Jürgen Müller-Weiß"), { first: "juergen", last: "mueller-weiss" });
  assert.deepEqual(splitName("Dr. Anna von Rüden"), { first: "anna", last: "rueden" });
  assert.equal(splitName("Müller"), null);
});

test("email pattern is learned from a colleague and applied to others", () => {
  const colleague = splitName("Marcus Holz")!;
  assert.equal(detect("m.holz", colleague), "f.last");
  assert.equal(apply("f.last", splitName("Ilka Schmidt")!), "i.schmidt");
  assert.equal(apply("first.last", splitName("Ilka Schmidt")!), "ilka.schmidt");
});

test("roleRank puts decision-makers and billing leads first", () => {
  assert.equal(roleRank("Geschäftsführer"), 1);
  assert.equal(roleRank("Teamleitung Umlagenabteilung"), 2);
  assert.equal(roleRank("Prokuristin"), 3);
  assert.ok(roleRank("Auszubildende") > 5);
});

const cfg = parse(readFileSync("config/criteria.yaml", "utf8"));
const f = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: "stated", evidence: null, source_url: null }]));
const base = { is_property_manager: true, kind: "independent_manager", management_types: ["weg", "mietverwaltung"] };

test("weights sum to 100", () => {
  assert.equal(Object.values<any>(cfg.criteria).reduce((s, c) => s + c.weight, 0), 100);
});

test("big manager on a big provider with a reachable GF scores A", () => {
  const s = scoreCompany(cfg, {}, f({ ...base, units_managed: 3000, metering_provider: "Techem", software: "Domus", has_portal: true, associations: ["VDIV"] }),
    [{ name: "Max Muster", role: "Geschäftsführer", rank: 1, email: "max.muster@x.de", email_status: "published", linkedin: "https://linkedin.com/in/max-muster" }]);
  assert.equal(s.tier, "A");
});

test("gates exclude brokers, municipal housing and existing Heidi customers", () => {
  assert.equal(scoreCompany(cfg, {}, f({ ...base, is_property_manager: false }), []).tier, "X");
  assert.equal(scoreCompany(cfg, {}, f({ ...base, kind: "municipal_housing" }), []).tier, "X");
  assert.equal(scoreCompany(cfg, {}, f({ ...base, metering_provider: "Heidi Systems" }), []).tier, "X");
});

test("no website data => tier '?' not a fake score", () => {
  assert.equal(scoreCompany(cfg, {}, {}, []).tier, "?");
});

test("units are estimated from staff when not stated, and labelled", () => {
  const s = scoreCompany(cfg, {}, f({ ...base, employees: 10 }), []);
  assert.equal(s.units, 10 * cfg.criteria.size.units_per_employee);
  assert.equal(s.unitsBasis, "estimated from staff");
});

test("units above the top band use the top band, not 'unknown'", () => {
  const s = scoreCompany(cfg, {}, f({ ...base, employees: 13500 }), []);
  assert.equal(s.parts.size, cfg.criteria.size.bands.at(-1).score);
});
