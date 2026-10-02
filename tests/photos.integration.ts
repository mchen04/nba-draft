import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { database } from "../lib/db";
import { ingestPhoto, ingestPhotos, readPhoto } from "../lib/photos";

const created: number[] = [];
const originalFetch = globalThis.fetch;
async function unusedId() {
  for (;;) {
    const id = randomInt(1000000000, 2000000000);
    if (!(await readPhoto(id))) return id;
  }
}
after(async () => {
  globalThis.fetch = originalFetch;
  if (created.length)
    await database().query(
      "DELETE FROM nba_draft.player_photos WHERE player_id=ANY($1::bigint[])",
      [created],
    );
  await database().end();
});

test("real Postgres photo cache serializes ingestion and reuses saved bytes without fetching", async () => {
  const sample = await database().query(
    "SELECT image FROM nba_draft.player_photos WHERE status='cached' LIMIT 1",
  );
  assert.ok(sample.rows[0]?.image, "Ingest real photos before this check.");
  const bytes: Buffer = sample.rows[0].image;
  const id = await unusedId();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/png" },
    });
  };
  try {
    const outcomes = await Promise.all([
      ingestPhoto(id),
      ingestPhoto(id),
      ingestPhoto(id),
    ]);
    created.push(id);
    assert.deepEqual(outcomes.sort(), ["cached", "reused", "reused"]);
    assert.equal(calls, 1);
    assert.deepEqual((await readPhoto(id))?.image, bytes);
    globalThis.fetch = async () => {
      throw new Error("Unexpected upstream request.");
    };
    assert.equal(await ingestPhoto(id), "reused");
    const result = await ingestPhotos([id, id]);
    assert.equal(result.reused, 1);
    assert.equal(result.failed, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing photos persist; transient and invalid responses roll back and can retry", async () => {
  const missing = await unusedId(),
    retry = await unusedId();
  try {
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(await ingestPhoto(missing), "missing");
    created.push(missing);
    globalThis.fetch = async () => {
      throw new Error("Unexpected upstream request.");
    };
    assert.equal(await ingestPhoto(missing), "reused");
    assert.equal((await readPhoto(missing))?.image, null);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(ingestPhoto(retry));
    assert.equal(await readPhoto(retry), null);
    globalThis.fetch = async () =>
      new Response("not an image", { status: 200 });
    await assert.rejects(ingestPhoto(retry));
    assert.equal(await readPhoto(retry), null);
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(await ingestPhoto(retry), "missing");
    created.push(retry);
    await assert.rejects(
      database().query(
        "INSERT INTO nba_draft.player_photos(player_id,status) VALUES($1,'cached')",
        [await unusedId()],
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
