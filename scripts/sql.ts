// Usage: npx tsx scripts/sql.ts "select ..."   (quick DB inspection)
import { db } from "../src/lib/db.ts";
const d = await db();
for (const q of process.argv.slice(2)) console.table((await d.query(q)).rows);
await d.close();
