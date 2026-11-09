// Shared helpers for names, email patterns and role ranking.
const TITLES = /\b(dr|prof|dipl|ing|kfm|kffr|kauffrau|kaufmann|betriebswirt|immobilienökonom|immobilienoekonom|mba|ll\.?m|b\.?a|m\.?a|m\.?sc|b\.?sc|ihk|rechtsanwalt|ra|herr|frau)\.?(-\w+\.?)?\b/gi;

const translit = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\- ]/g, "").trim();

export function splitName(full: string): { first: string; last: string } | null {
  const parts = full.replace(TITLES, " ").replace(/[.,]/g, " ").split(/\s+/).filter((p) => p.length > 1);
  if (parts.length < 2) return null;
  return { first: translit(parts[0]), last: translit(parts[parts.length - 1]).replace(/\s/g, "") };
}

export type Pattern = "first.last" | "f.last" | "firstlast" | "flast" | "first" | "last" | "first_last" | "last.first" | "first-last";
export const PATTERNS: Pattern[] = ["first.last", "f.last", "firstlast", "flast", "first_last", "first-last", "last.first", "first", "last"];

export function apply(p: Pattern, n: { first: string; last: string }): string {
  const f = n.first.split("-")[0], l = n.last;
  return { "first.last": `${f}.${l}`, "f.last": `${f[0]}.${l}`, firstlast: `${f}${l}`, flast: `${f[0]}${l}`,
           first: f, last: l, first_last: `${f}_${l}`, "last.first": `${l}.${f}`, "first-last": `${f}-${l}` }[p];
}

/** Which pattern turns `name` into `local`? */
export function detect(local: string, name: { first: string; last: string }): Pattern | null {
  return PATTERNS.find((p) => apply(p, name) === local) ?? null;
}

// lower = more relevant buyer for metering/billing
export function roleRank(role: string): number {
  const r = role.toLowerCase();
  if (/geschäftsführ|geschaeftsfuehr|inhaber|owner|managing director|vorstand|gründer|gruender/.test(r)) return 1;
  if (/abrechnung|betriebskosten|heizkosten|nebenkosten|umlage|buchhaltung|rechnungswesen|finanz/.test(r)) return 2;
  if (/prokur|leitung|leiter|head|bereichsleit|niederlassungsleit/.test(r)) return 3;
  if (/weg|mietverwalt|objektbetreu|immobilienverwalt|verwalter|property/.test(r)) return 4;
  if (/assist|sekret|empfang|azubi|auszubild|hausmeister|techni/.test(r)) return 9;
  return 6;
}


/** Best contact first: most senior role, then strongest email (published > company format > standard format), then has LinkedIn. */
const EMAIL_STRENGTH: Record<string, number> = { published: 0, company_format: 1, standard_format: 2 };
export function byBestContact(a: any, b: any): number {
  return (a.rank ?? 9) - (b.rank ?? 9)
    || (EMAIL_STRENGTH[a.email_status] ?? 3) - (EMAIL_STRENGTH[b.email_status] ?? 3)
    || (b.linkedin ? 1 : 0) - (a.linkedin ? 1 : 0)
    || (a.id ?? 0) - (b.id ?? 0);
}
