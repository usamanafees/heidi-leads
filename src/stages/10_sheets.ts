// Stage 10: publish the exported workbook to a live Google Sheet (service account).
// Setup: share the Sheet with the service account email as Editor; set GOOGLE_SHEET_ID + GOOGLE_KEY_FILE in .env.
// Values are written RAW (so "+49 30..." or "030..." stay text); formula cells are written as formulas.
// Tier colours are conditional formats, so they follow live score changes made in the Criteria tab.
import ExcelJS from "exceljs";
import path from "node:path";
import { sheets as Sheets, auth as GAuth, type sheets_v4 } from "@googleapis/sheets";
import { ROOT, requireEnv } from "../lib/env.ts";

const TABS = ["Start here", "Leads", "Contacts", "Criteria", "Column guide", "Run stats"];
const id = requireEnv("GOOGLE_SHEET_ID");
const auth = new GAuth.GoogleAuth({ keyFile: path.join(ROOT, requireEnv("GOOGLE_KEY_FILE")), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const api = Sheets({ version: "v4", auth });

const colLetter = (n: number) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const rgb = (argb: string) => ({ red: parseInt(argb.slice(2, 4), 16) / 255, green: parseInt(argb.slice(4, 6), 16) / 255, blue: parseInt(argb.slice(6, 8), 16) / 255 });

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ROOT, "output/berlin_hausverwaltungen.xlsx"));

  // 1) make sure all tabs exist (reuse the default "Sheet1" as Leads)
  let meta = (await api.spreadsheets.get({ spreadsheetId: id })).data;
  const have = new Map(meta.sheets!.map((s) => [s.properties!.title!, s.properties!.sheetId!]));
  const reqs: sheets_v4.Schema$Request[] = [];
  if (!have.has("Leads") && have.has("Sheet1")) reqs.push({ updateSheetProperties: { properties: { sheetId: have.get("Sheet1"), title: "Leads" }, fields: "title" } });
  for (const t of TABS) if (!have.has(t) && !(t === "Leads" && have.has("Sheet1"))) reqs.push({ addSheet: { properties: { title: t } } });
  if (reqs.length) await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: reqs } });
  meta = (await api.spreadsheets.get({ spreadsheetId: id })).data;
  const sid = new Map(meta.sheets!.map((s) => [s.properties!.title!, s.properties!.sheetId!]));

  const fmt: sheets_v4.Schema$Request[] = [];
  for (const tab of TABS) {
    const ws = wb.getWorksheet(tab)!;
    const sheetId = sid.get(tab)!;
    const rows: any[][] = [];
    const formulas = new Map<number, (string | null)[]>(); // column -> formulas by row
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      const out: any[] = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const v: any = cell.value;
        if (v && typeof v === "object" && "formula" in v) {
          (formulas.get(c) ?? formulas.set(c, []).get(c)!)[r - 1] = "=" + v.formula;
          out[c - 1] = "";
        } else if (v && typeof v === "object" && "richText" in v) out[c - 1] = v.richText.map((t: any) => t.text).join("");
        else if (v && typeof v === "object" && "text" in v) out[c - 1] = v.text;
        else out[c - 1] = v ?? "";
        const fill: any = cell.fill;
        if (fill?.fgColor?.argb && (r > 1 || tab === "Start here") && tab !== "Leads") // yellow editable cells, section bands (Criteria)
          fmt.push({ repeatCell: { range: { sheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: c - 1, endColumnIndex: c },
            cell: { userEnteredFormat: { backgroundColor: rgb(fill.fgColor.argb), textFormat: { bold: !!cell.font?.bold || fill.fgColor.argb === "FF1F2937",
              foregroundColor: rgb(fill.fgColor.argb === "FF1F2937" ? "FFFFFFFF" : "FF111827") } } },
            fields: "userEnteredFormat(backgroundColor,textFormat)" } });
        else if (cell.font?.bold && tab !== "Leads" && tab !== "Contacts") // bold labels / titles
          fmt.push({ repeatCell: { range: { sheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: c - 1, endColumnIndex: c },
            cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: r === 1 && tab === "Start here" ? 16 : 10 } } }, fields: "userEnteredFormat.textFormat" } });
      });
      rows[r - 1] = out;
    });
    const width = Math.max(...rows.map((r) => r?.length ?? 0));
    const grid = rows.map((r) => Array.from({ length: width }, (_, i) => (r?.[i] ?? "")));

    // size the tab, clear, then write values in chunks (RAW) and formulas (USER_ENTERED)
    fmt.push({ updateSheetProperties: { properties: { sheetId, gridProperties: {
      rowCount: Math.max(grid.length + 5, 50), columnCount: Math.max(width, 5),
      frozenRowCount: tab === "Criteria" ? 3 : tab === "Start here" ? 0 : 1, frozenColumnCount: tab === "Leads" ? 3 : 0 } },
      fields: "gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)" } });
    await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [fmt.pop()!] } });
    await api.spreadsheets.values.clear({ spreadsheetId: id, range: `'${tab}'` });
    for (let i = 0; i < grid.length; i += 400) {
      await api.spreadsheets.values.update({ spreadsheetId: id, range: `'${tab}'!A${i + 1}`, valueInputOption: "RAW",
        requestBody: { values: grid.slice(i, i + 400) } });
    }
    if (formulas.size) {
      await api.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: "USER_ENTERED",
        data: [...formulas.entries()].map(([c, f]) => {
          const first = f.findIndex((x) => x != null), last = f.length - 1;
          return { range: `'${tab}'!${colLetter(c)}${first + 1}:${colLetter(c)}${last + 1}`, values: f.slice(first).map((x) => [x ?? ""]) };
        }) } });
    }

    // header style + column widths
    if (tab !== "Start here") fmt.push({ repeatCell: { range: { sheetId, startRowIndex: tab === "Criteria" ? 2 : 0, endRowIndex: tab === "Criteria" ? 3 : 1 },
      cell: { userEnteredFormat: { backgroundColor: rgb("FF1F2937"), textFormat: { bold: true, foregroundColor: rgb("FFFFFFFF") }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE" } },
      fields: "userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment)" } });
    ws.columns.forEach((col, i) => fmt.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: Math.round((col.width ?? 12) * 7) }, fields: "pixelSize" } }));
    if (tab === "Leads" || tab === "Contacts") fmt.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: grid.length, startColumnIndex: 0, endColumnIndex: width } } } });
    if (tab === "Leads") {
      // grey "in:" input columns, live tier colours
      const firstIn = (rows[0] as string[]).findIndex((h) => String(h).startsWith("in: "));
      fmt.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: firstIn, endColumnIndex: width },
        cell: { userEnteredFormat: { backgroundColor: rgb("FF9CA3AF") } }, fields: "userEnteredFormat.backgroundColor" } });
      fmt.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: firstIn, endIndex: width },
        properties: { hiddenByUser: true }, fields: "hiddenByUser" } }); // formula inputs, hidden
      for (const [t, c] of [["A", "FFC6EFCE"], ["B", "FFFFEB9C"], ["C", "FFFCE4D6"], ["X", "FFE7E6E6"]])
        fmt.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId, startRowIndex: 1, endRowIndex: grid.length, startColumnIndex: 0, endColumnIndex: 1 }],
          booleanRule: { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: t }] }, format: { backgroundColor: rgb(c) } } } } });
    }
    fmt.push({ updateSheetProperties: { properties: { sheetId, index: TABS.indexOf(tab) }, fields: "index" } });
    if (tab === "Start here") fmt.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: grid.length, startColumnIndex: 1, endColumnIndex: 2 },
      cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } });
    console.log(`${tab}: ${grid.length - 1} rows, ${formulas.size} formula columns`);
  }
  // drop old conditional formats first so re-runs don't stack them
  const leadsMeta = (await api.spreadsheets.get({ spreadsheetId: id, fields: "sheets(properties.sheetId,conditionalFormats)" })).data.sheets!
    .find((s) => s.properties!.sheetId === sid.get("Leads"))!;
  const clearCf = (leadsMeta.conditionalFormats ?? []).map(() => ({ deleteConditionalFormatRule: { sheetId: sid.get("Leads")!, index: 0 } }));
  await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [...clearCf, ...fmt] } });
  console.log(`published: https://docs.google.com/spreadsheets/d/${id}/edit`);
}

main().catch((e) => { console.error(e?.response?.data?.error ?? e); process.exit(1); });
