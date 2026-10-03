// Controlled stored boards for the real browser; never use a user's database.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { database } from "../lib/db";
import { createRoom } from "../lib/engine";
import { defaultSettings } from "../lib/model";
import { ingestPhotos } from "../lib/photos";
import { pickOrder, rankPlayers } from "../lib/rules";

async function main() {
  const connection = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(connection.hostname, "127.0.0.1");
  assert.equal(connection.username, "nba_png_test");
  assert.equal(connection.port, "55437");
  const evidence = process.env.EVIDENCE!;
  assert.ok(evidence && !evidence.startsWith(process.cwd()));
  mkdirSync(evidence, { recursive: true });
  const settings = {
    ...defaultSettings,
    teamCount: 20,
    seconds: 600,
    slots: { PG: 0, SG: 0, SF: 0, PF: 0, C: 0, G: 0, F: 0, UTIL: 30, BN: 0 },
    order: Array.from({ length: 20 }, (_, i) => 19 - i),
  };
  const { room } = await createRoom(
    "Complete board — 20 teams and 30 rounds",
    "Export test",
    settings,
  );
  const pool = [...room.catalog.players];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const order = pickOrder(settings);
  room.members = Array.from({ length: 20 }, (_, slot) => ({
    name:
      slot === 19
        ? "Alexandria Montgomery with a long team name to test wrapping"
        : "Manager " + (slot + 1),
    slot,
    commissioner: slot === 0,
    sessions: [],
    recovery: "",
    ready: true,
    queue: [],
  }));
  room.picks = order.map((slot, index) => ({
    index,
    slot,
    playerId: pool[index].id,
    source: index % 3 === 0 ? "ranking" : index % 3 === 1 ? "queue" : "manual",
    at: new Date().toISOString(),
    requestId: null,
  }));
  room.phase = "complete";
  room.version++;
  const { players, ...meta } = room.catalog;
  await database().query("UPDATE nba_draft.rooms SET data=$2 WHERE id=$1", [
    room.id,
    JSON.stringify({ ...room, catalog: meta }),
  ]);
  await database().query(
    "INSERT INTO nba_draft.picks(room_id,pick_index,player_id,team_slot,source,picked_at) SELECT $1, * FROM unnest($2::integer[],$3::bigint[],$4::integer[],$5::text[],$6::timestamptz[])",
    [
      room.id,
      room.picks.map((p) => p.index),
      room.picks.map((p) => p.playerId),
      room.picks.map((p) => p.slot),
      room.picks.map((p) => p.source),
      room.picks.map((p) => p.at),
    ],
  );
  const photoResult = await ingestPhotos([
    ...rankPlayers(players, defaultSettings, "FP", false)
      .slice(0, 30)
      .map((p) => p.id),
    ...[...room.picks.slice(0, 4), ...room.picks.slice(-4)].map(
      (p) => p.playerId,
    ),
  ]);
  const path = `${evidence}/long-board-seed.json`;
  writeFileSync(
    path,
    JSON.stringify(
      {
        id: room.id,
        origin: process.env.ORIGIN,
        controlledStoredBoard: true,
        randomPlayerOrder: true,
        teams: 20,
        rounds: 30,
        picks: room.picks,
        headers: room.members.map((m) => m.name),
        dataset: meta,
        photos: photoResult,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      id: room.id,
      teams: 20,
      rounds: 30,
      picks: 600,
      path,
      photos: photoResult,
    }),
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => database().end());
