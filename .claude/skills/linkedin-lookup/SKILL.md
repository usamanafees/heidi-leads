---
name: linkedin-lookup
description: How to find and verify the LinkedIn profile of a named decision-maker at a German company. Use when matching a person from a company website to a LinkedIn profile.
---

# Finding a decision-maker on LinkedIn

## Who to look up
- Take the top 2 people from `get_company` that have no LinkedIn profile yet.
- Order: Geschäftsführer / Inhaber, then billing lead (Abrechnung, Betriebskosten, Umlagen), then Prokurist.

## How to search
1. WebSearch with `allowed_domains: ["linkedin.com"]` and the query `<full name> <short company name>`.
   Short company name = drop legal forms: GmbH, GmbH & Co. KG, KG, UG, e.K., mbH.
2. If nothing matches, one more search: `<full name> Hausverwaltung Berlin`.
3. At most 2 searches per person. People without a public profile are normal: record nothing.

## Normalizing names
- Drop titles before matching: Dr., Dipl.-Kfm., Dipl.-Ing., Immobilienökonom (GdW), B.A., M.Sc.
- Umlauts may appear either way in URLs: ü = ue, ö = oe, ä = ae, ß = ss.
- Double names: match on the last family name ("Müller-Lüdenscheidt" can appear as "mueller-luedenscheidt" or "lüdenscheidt").

## When a result counts
Accept a profile only if **all** are true:
- The URL is a personal profile: `linkedin.com/in/...` (not `/company/`, `/pub/dir/`, or a post).
- The name in the result matches the person.
- The employer or headline names the same company, or "Hausverwaltung" in Berlin for a family-named firm.

## Recording
`record_person` with the person's known role, `linkedin_url` = the profile URL and `source_url` = the same URL.
Never construct or guess a LinkedIn URL; use exactly the URL from the search results.
