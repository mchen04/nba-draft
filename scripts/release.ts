import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { database } from "../lib/db";

const keys = {
  rooms: "id::text",
  picks: "room_id::text || ':' || pick_index::text",
  requests: "room_id::text || ':' || request_id::text",
  catalogs: "season::text",
  datasets: "id::text",
  player_photos: "player_id::text",
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const report = (stage: string, evidence: unknown) =>
  console.log(JSON.stringify({ stage, at: new Date().toISOString(), evidence }));

async function snapshot() {
  const client = await database().connect();
  const rows: Record<string, Map<string, string>> = {};
  const tables: Record<string, { count: number; fingerprint: string }> = {};
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const server = await client.query(
      "SELECT current_setting('server_version') AS version, encode(sha256(convert_to(current_database(),'UTF8')),'hex') AS database_fingerprint",
    );
    const schema = await client.query(
      "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='nba_draft' ORDER BY table_name, ordinal_position",
    );
    const constraints = await client.query(
      "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass('nba_draft.player_photos') ORDER BY conname",
    );
    for (const [table, key] of Object.entries(keys)) {
      const exists = schema.rows.some((row) => row.table_name === table);
      assert.ok(exists || table === "player_photos", `Existing ${table} table is required.`);
      if (!exists) continue;
      const result = await client.query<{ key: string; digest: string }>(
        `SELECT encode(sha256(convert_to(${key},'UTF8')),'hex') AS key,
         encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest
         FROM nba_draft.${table} t ORDER BY key`,
      );
      rows[table] = new Map(result.rows.map((row) => [row.key, row.digest]));
      tables[table] = { count: result.rowCount!, fingerprint: hash(JSON.stringify(result.rows)) };
    }
    const photos = rows.player_photos
      ? (await client.query(
          "SELECT status, count(*)::int AS players, coalesce(sum(octet_length(image)),0)::bigint AS bytes, count(*) FILTER (WHERE image IS NOT NULL AND encode(sha256(image),'hex')<>digest)::int AS invalid_digests FROM nba_draft.player_photos GROUP BY status ORDER BY status",
        )).rows
      : [];
    await client.query("COMMIT");
    return { rows, summary: { server: server.rows[0], schema: schema.rows, photoConstraints: constraints.rows, tables, photos } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function compare(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  return Object.fromEntries(Object.entries(before.rows).map(([table, old]) => {
    const current = after.rows[table] ?? new Map();
    return [table, {
      added: [...current.keys()].filter((key) => !old.has(key)).length,
      removed: [...old.keys()].filter((key) => !current.has(key)).length,
      changed: [...old].filter(([key, digest]) => current.has(key) && current.get(key) !== digest).length,
    }];
  }));
}

async function run(script: string, args: string[] = []) {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", `scripts/${script}.ts`, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      report(`${script}-process`, { args, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() });
      if (code === 0 || (script === "photos" && code === 1 && stdout.trim())) resolve(stdout);
      else reject(new Error(`${script} process failed with exit ${code}.`));
    });
  });
  if (script === "photos") return JSON.parse(output.trim().split("\n")[0]);
}

function sanitizedError(error: unknown) {
  const value = error as { message?: string; code?: string; syscall?: string };
  let message = value.message ?? "Unknown release error.";
  const connection = process.env.DATABASE_URL;
  if (connection) {
    message = message.replaceAll(connection, "<database connection>");
    try {
      const url = new URL(connection);
      for (const part of [url.password, url.username, url.hostname, url.pathname.slice(1)]) {
        if (part) {
          message = message.replaceAll(part, "<redacted>");
          message = message.replaceAll(decodeURIComponent(part), "<redacted>");
        }
      }
    } catch {}
  }
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<database connection>");
  return { message, code: value.code, syscall: value.syscall };
}

async function main() {
  const before = await snapshot();
  report("before", before.summary);
  if (process.argv[2] === "inspect") {
    for (const id of process.argv.slice(3)) {
      assert.match(id, /^[0-9a-f-]{36}$/i);
      const counts = await database().query(
        "SELECT (SELECT count(*)::int FROM nba_draft.rooms WHERE id=$1) AS rooms, (SELECT count(*)::int FROM nba_draft.picks WHERE room_id=$1) AS picks, (SELECT count(*)::int FROM nba_draft.requests WHERE room_id=$1) AS requests",
        [id],
      );
      report("controlled-room", { id, ...counts.rows[0] });
    }
    return;
  }
  assert.equal(process.argv[2], "migrate", "Use migrate or inspect.");
  const sql = await readFile(new URL("../db/003.sql", import.meta.url));
  report("migration", { file: "db/003.sql", sha256: hash(sql) });
  await run("database", ["migrate", "003.sql"]);
  const migrated = await snapshot();
  report("after-migration", migrated.summary);
  report("migration-record-changes", compare(before, migrated));
  let ingestion = await run("photos");
  for (let retry = 0; ingestion.failed && retry < 2; retry++) {
    report("partial-ingestion", (await snapshot()).summary);
    ingestion = await run("photos");
  }
  const ingested = await snapshot();
  report("after-ingestion", ingested.summary);
  report("ingestion-record-changes", compare(migrated, ingested));
  assert.equal(ingestion.failed, 0, "Photo ingestion still has failed entries.");
  const reuse = await run("photos", ["--no-upstream"]);
  assert.equal(reuse.upstreamFetches, 0);
  assert.equal(reuse.failed, 0);
  assert.equal(reuse.deferred, 0);
  assert.equal(reuse.reused, reuse.requested);
  const repeated = await snapshot();
  assert.deepEqual(repeated.summary.tables.player_photos, ingested.summary.tables.player_photos);
  report("fresh-process-reuse", { ...reuse, unchangedPhotoFingerprint: true });
  report("after-repeat", repeated.summary);
  report("repeat-record-changes", compare(ingested, repeated));
}

main().catch((error) => {
  report("release-error", sanitizedError(error));
  process.exitCode = 1;
}).finally(async () => {
  try { await database().end(); } catch {}
});
