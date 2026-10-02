import { database } from "../lib/db";
import { ingestPhotos } from "../lib/photos";

let upstreamFetches = 0;
const upstream = globalThis.fetch;
globalThis.fetch = (...args) => {
  upstreamFetches++;
  if (process.argv.includes("--no-upstream"))
    throw new Error("Upstream fetch is disabled for cache verification.");
  return upstream(...args);
};

async function main() {
  try {
    // Include every pinned pool, so old rooms also keep their photos.
    const players = await database().query(
      "SELECT DISTINCT (player->>'id')::bigint AS id FROM nba_draft.datasets, jsonb_array_elements(players) player",
    );
    const result = await ingestPhotos(
      players.rows.map((row) => Number(row.id)),
    );
    console.log(JSON.stringify({ ...result, upstreamFetches }));
    if (result.failed) process.exitCode = 1;
    const counts = await database().query(
      "SELECT status, count(*)::int AS players, coalesce(sum(octet_length(image)),0)::bigint AS bytes FROM nba_draft.player_photos GROUP BY status ORDER BY status",
    );
    console.log(JSON.stringify({ storage: counts.rows }));
  } finally {
    await database().end();
  }
}
main().catch(() => {
  console.error("Photo ingestion failed. Check database configuration.");
  process.exitCode = 1;
});
