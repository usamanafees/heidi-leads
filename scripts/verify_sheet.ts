// Recalculates the exported workbook with a real spreadsheet engine (HyperFormula) and checks
// that the sheet's Score/Tier formulas equal the code's scores, then shows that editing a
// Criteria cell re-ranks the leads.   Usage: npx tsx scripts/verify_sheet.ts
import ExcelJS from "exceljs";
import { HyperFormula } from "hyperformula";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("output/berlin_hausverwaltungen.xlsx");
const toArray = (ws: ExcelJS.Worksheet) => {
  const out: any[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, r) => {
    const arr: any[] = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      const v: any = cell.value;
      arr[c - 1] = v && typeof v === "object" && "formula" in v ? "=" + v.formula : v && typeof v === "object" && "richText" in v ? v.richText.map((t: any) => t.text).join("") : v ?? null;
    });
    out[r - 1] = arr;
  });
  return out.map((r) => r ?? []);
};
const leads = wb.getWorksheet("Leads")!, crit = wb.getWorksheet("Criteria")!;
const hf = HyperFormula.buildFromSheets({ Leads: toArray(leads), Criteria: toArray(crit) }, { licenseKey: "gpl-v3" });
const L = hf.getSheetId("Leads")!, C = hf.getSheetId("Criteria")!;
const header = toArray(leads)[0];
const tierCol = header.indexOf("Tier"), scoreCol = header.indexOf("Score");
const n = leads.rowCount - 1;
let mismatch = 0;
const tiers = () => { const t: Record<string, number> = {}; for (let r = 1; r <= n; r++) { const x = String(hf.getCellValue({ sheet: L, row: r, col: tierCol })); t[x] = (t[x] ?? 0) + 1; } return t; };
for (let r = 1; r <= n; r++) {
  const cached: any = leads.getRow(r + 1).getCell(scoreCol + 1).value;
  const cachedTier: any = leads.getRow(r + 1).getCell(tierCol + 1).value;
  const s = hf.getCellValue({ sheet: L, row: r, col: scoreCol }), t = hf.getCellValue({ sheet: L, row: r, col: tierCol });
  if (s !== cached.result || t !== cachedTier.result) { mismatch++; if (mismatch <= 5) console.log("mismatch row", r + 1, { sheet: [s, t], code: [cached.result, cachedTier.result] }); }
}
console.log(`formula vs code: ${n - mismatch}/${n} rows identical`);
console.log("tiers (sheet, as exported):", tiers());

// simulate a salesperson: size weight 35 -> 45, switch trigger 20 -> 10
const critRows = toArray(crit);
const findRow = (label: string) => critRows.findIndex((r) => r[0] === label);
hf.setCellContents({ sheet: C, row: findRow("Weight: size"), col: 1 }, 45);
hf.setCellContents({ sheet: C, row: findRow("Weight: switch_trigger"), col: 1 }, 10);
console.log("sum of weights cell:", hf.getCellValue({ sheet: C, row: findRow("Sum of weights (should be 100)"), col: 1 }));
console.log("tiers after editing two Criteria cells:", tiers());
