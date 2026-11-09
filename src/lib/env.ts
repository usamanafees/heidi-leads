import "dotenv/config";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export function loadYaml<T = any>(rel: string): T {
  return parse(readFileSync(path.join(ROOT, rel), "utf8")) as T;
}
