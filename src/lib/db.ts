// Embedded Postgres (PGlite): real Postgres SQL, zero install.
// The same schema runs unchanged on Supabase / any Postgres in production.
import { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { ROOT } from "./env.ts";

let _db: PGlite | null = null;

export async function db(): Promise<PGlite> {
  if (_db && !_db.closed) return _db;
  _db = new PGlite(path.join(ROOT, "data/pgdata"));
  await _db.exec(SCHEMA);
  return _db;
}

const SCHEMA = `
-- Raw Google Places hits (one row per place)
create table if not exists places (
  place_id        text primary key,
  name            text not null,
  address         text,
  postcode        text,
  district        text,
  lat             double precision,
  lng             double precision,
  website         text,
  phone           text,
  rating          real,
  rating_count    int,
  types           text[],
  primary_type    text,
  business_status text,
  maps_url        text,
  found_by_query  text[] default '{}',
  first_seen      timestamptz default now()
);

-- Finished Google searches (query + grid cell) so discovery can resume after quota stops
create table if not exists search_log (key text primary key, hits int, at timestamptz default now());

-- One row per company (deduplicated by website domain)
create table if not exists companies (
  id            serial primary key,
  domain        text unique,
  name          text not null,
  place_ids     text[] not null,
  address       text,
  postcode      text,
  district      text,
  phone         text,
  website       text,
  rating        real,
  rating_count  int,
  maps_url      text,
  locations     int default 1,
  crawl_status  text,         -- ok | failed | no_website
  is_hv         boolean,      -- is it really a property manager?
  is_hv_reason  text
);

-- Raw crawled pages (cache: fetch once, extract many times)
create table if not exists pages (
  company_id  int references companies(id),
  url         text,
  kind        text,           -- home | impressum | about | team | services | contact | other
  status      int,
  text        text,
  emails      text[],
  fetched_at  timestamptz default now(),
  primary key (company_id, url)
);

-- Extracted facts, each with evidence (one row per company per field)
create table if not exists facts (
  company_id  int references companies(id),
  field       text,
  value       jsonb,
  confidence  text,           -- verified | stated | estimated | unknown
  evidence    text,           -- exact quote from source
  source_url  text,
  extractor   text,           -- which model / rule produced it
  checked     text,           -- checker verdict: supported | unsupported | null
  updated_at  timestamptz default now(),
  primary key (company_id, field)
);

-- Contact people
create table if not exists contacts (
  id               serial primary key,
  company_id       int references companies(id),
  name             text,
  role             text,
  email            text,
  email_status     text,      -- published | company_format | standard_format | none
  linkedin         text,
  phone            text,
  source_url       text,
  rank             int,       -- 1 = best person to contact
  unique (company_id, name)
);

-- Every LLM call, for audit + cost reporting
create table if not exists llm_calls (
  id            serial primary key,
  stage         text,
  company_id    int,
  model         text,
  input_tokens  int,
  output_tokens int,
  cost_usd      real,
  ms            int,
  ok            boolean,
  error         text,
  at            timestamptz default now()
);
`;
