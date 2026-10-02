import { createHash } from "node:crypto";
import { begin, database } from "./db";

export const photoFallback = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#eef1f5"/><circle cx="48" cy="34" r="17" fill="#9aa7b6"/><path d="M17 84a31 31 0 0 1 62 0" fill="#9aa7b6"/></svg>`;

export async function readPhoto(playerId: number) {
  const result = await database().query<{
    status: string;
    image: Buffer | null;
    content_type: string | null;
    digest: string | null;
  }>(
    "SELECT status, image, content_type, digest FROM nba_draft.player_photos WHERE player_id=$1",
    [playerId],
  );
  return result.rows[0] ?? null;
}

// Ingestion is separate from page reads. A lock prevents two jobs fetching the same photo.
export async function ingestPhoto(playerId: number) {
  const client = await begin();
  try {
    await client.query("SELECT pg_advisory_xact_lock(67823412, $1)", [
      playerId,
    ]);
    const existing = await client.query(
      "SELECT status FROM nba_draft.player_photos WHERE player_id=$1",
      [playerId],
    );
    if (existing.rows.length) {
      await client.query("COMMIT");
      return "reused" as const;
    }
    const response = await fetch(
      `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${playerId}.png&w=96&h=70`,
      { signal: AbortSignal.timeout(5000), cache: "no-store" },
    );
    if (response.status === 404 || response.status === 410) {
      await client.query(
        "INSERT INTO nba_draft.player_photos(player_id,status) VALUES($1,'missing')",
        [playerId],
      );
      await client.query("COMMIT");
      return "missing" as const;
    }
    if (!response.ok) throw new Error("Photo source failed.");
    const image = Buffer.from(await response.arrayBuffer());
    const png =
      image.length >= 33 &&
      image
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      image.toString("ascii", 12, 16) === "IHDR" &&
      image.readUInt32BE(16) > 0 &&
      image.readUInt32BE(20) > 0;
    const jpeg =
      image.length > 4 &&
      image[0] === 255 &&
      image[1] === 216 &&
      image[2] === 255 &&
      image[image.length - 2] === 255 &&
      image[image.length - 1] === 217;
    if ((!png && !jpeg) || image.length > 2097152)
      throw new Error("Invalid photo bytes.");
    await client.query(
      "INSERT INTO nba_draft.player_photos(player_id,status,image,content_type,digest) VALUES($1,'cached',$2,$3,$4)",
      [
        playerId,
        image,
        png ? "image/png" : "image/jpeg",
        createHash("sha256").update(image).digest("hex"),
      ],
    );
    await client.query("COMMIT");
    return "cached" as const;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ingestPhotos(playerIds: number[], budget = Infinity) {
  const ids = [...new Set(playerIds)];
  const stored = await database().query(
    "SELECT player_id FROM nba_draft.player_photos WHERE player_id=ANY($1::bigint[])",
    [ids],
  );
  const known = new Set(stored.rows.map((row) => Number(row.player_id)));
  const pending = ids.filter((id) => !known.has(id));
  const result = {
    requested: ids.length,
    reused: known.size,
    cached: 0,
    missing: 0,
    failed: 0,
    deferred: 0,
  };
  const deadline = Date.now() + budget;
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < pending.length && Date.now() < deadline) {
        const id = pending[next++];
        try {
          result[await ingestPhoto(id)]++;
        } catch {
          result.failed++;
        }
      }
    }),
  );
  result.deferred = pending.length - next;
  return result;
}
