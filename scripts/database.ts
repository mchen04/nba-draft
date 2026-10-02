import { readFile, readdir } from "node:fs/promises";
import { database } from "../lib/db";

async function main() {
  const pool = database();
  try {
    const metadata = await pool.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2",
    );
    console.log(
      JSON.stringify({
        inspectedAt: new Date().toISOString(),
        tables: metadata.rows,
      }),
    );
    if (process.argv[2] === "migrate") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(67823411)");
        const folder = new URL("../db/", import.meta.url);
        const files = (await readdir(folder))
          .filter((name) => name.endsWith(".sql"))
          .sort();
        const selected = process.argv[3];
        if (selected && !files.includes(selected))
          throw new Error("Unknown migration file.");
        for (const file of selected ? [selected] : files)
          await client.query(await readFile(new URL(file, folder), "utf8"));
        await client.query("COMMIT");
        console.log("Namespaced migration complete.");
      } catch {
        await client.query("ROLLBACK");
        throw new Error(
          "Namespaced migration failed; no credentials are logged.",
        );
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    "Database operation failed. Check server configuration and connectivity.",
  );
  process.exitCode = 1;
});
