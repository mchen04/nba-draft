import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { database } from "../lib/db";
import {
  commissionerIdleLimit,
  createRoom,
  expireRooms,
  inactiveLimit,
  pollRoom,
  roomView,
  transactRoom,
} from "../lib/engine";
import { getCatalog, refreshAge } from "../lib/espn";
import { exportCsv } from "../lib/export";
import { Settings, defaultSettings } from "../lib/model";
import { eligible, pickOrder, rosterSlots } from "../lib/rules";

const settings: Settings = {
  ...defaultSettings,
  teamCount: 2,
  order: [0, 1],
  seconds: 30,
  slots: { PG: 0, SG: 0, SF: 0, PF: 0, C: 0, G: 0, F: 0, UTIL: 3, BN: 0 },
};
const ids: string[] = [];
const command = (type: string, extra: Record<string, unknown> = {}) =>
  ({
    type,
    ...(type === "claim"
      ? { retryCredential: randomBytes(32).toString("hex") }
      : {}),
    ...extra,
    requestId: randomUUID(),
  }) as Parameters<typeof transactRoom>[2];
async function makeRoom(custom = settings) {
  const created = await createRoom(
    `t_167eb983 Postgres acceptance ${randomUUID().slice(0, 8)}`,
    "Commissioner",
    custom,
  );
  ids.push(created.room.id);
  return created;
}
async function readyRoom(custom = settings) {
  const created = await makeRoom(custom);
  await transactRoom(
    created.room.id,
    created.token,
    command("claim", { slot: 0, name: "Manager A" }),
  );
  const second = await transactRoom(
    created.room.id,
    undefined,
    command("claim", { slot: 1, name: "Manager B" }),
  );
  await transactRoom(
    created.room.id,
    created.token,
    command("ready", { ready: true }),
  );
  await transactRoom(
    created.room.id,
    second.token,
    command("ready", { ready: true }),
  );
  await transactRoom(created.room.id, created.token, command("start"));
  return { ...created, secondToken: second.token! };
}
after(async () => {
  console.log(JSON.stringify({ task: "t_167eb983", evidenceRooms: ids }));
  await database().end();
});

test("actual Postgres slot-claim race admits exactly one manager and hides ownership/queues", async () => {
  const { room } = await makeRoom();
  const attempts = await Promise.allSettled([
    transactRoom(room.id, undefined, command("claim", { slot: 0, name: "A" })),
    transactRoom(room.id, undefined, command("claim", { slot: 0, name: "B" })),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const winner = attempts.find(
    (result) => result.status === "fulfilled",
  )! as PromiseFulfilledResult<Awaited<ReturnType<typeof transactRoom>>>;
  const playerId = room.catalog.players[0].id;
  await transactRoom(
    room.id,
    winner.value.token,
    command("queue", { players: [playerId] }),
  );
  const other = await transactRoom(room.id, undefined);
  assert.deepEqual(other.view.queue, []);
  assert.equal(JSON.stringify(other.view).includes("sessions"), false);
  assert.equal(JSON.stringify(other.view).includes("recovery"), false);
  await assert.rejects(
    transactRoom(room.id, undefined, command("queue", { players: [] })),
  );
  await assert.rejects(
    transactRoom(room.id, winner.value.token, command("pause")),
  );
  const recovered = await transactRoom(
    room.id,
    undefined,
    command("recover", { code: winner.value.recoveryCode }),
  );
  assert.equal(recovered.view.me?.slot, 0);
  assert.deepEqual(recovered.view.queue, [playerId]);
});
test("manual pick races and retries select once; other manager cannot pick or control", async () => {
  const { room, token, secondToken } = await readyRoom();
  const legal = room.catalog.players.filter((player) =>
    player.positions.includes("UTIL"),
  );
  await assert.rejects(
    transactRoom(
      room.id,
      secondToken,
      command("pick", { expectedIndex: 0, playerId: legal[0].id }),
    ),
  );
  const request = command("pick", { expectedIndex: 0, playerId: legal[0].id });
  const duplicate = await Promise.all([
    transactRoom(room.id, token, request),
    transactRoom(room.id, token, request),
  ]);
  duplicate.forEach((result) => assert.equal(result.room.picks.length, 1));
  const competing = await Promise.allSettled([
    transactRoom(
      room.id,
      secondToken,
      command("pick", { expectedIndex: 1, playerId: legal[1].id }),
    ),
    transactRoom(
      room.id,
      secondToken,
      command("pick", { expectedIndex: 1, playerId: legal[2].id }),
    ),
  ]);
  assert.equal(
    competing.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const persisted = await database().query(
    "SELECT count(*)::int AS picks, count(DISTINCT player_id)::int AS players FROM nba_draft.picks WHERE room_id=$1",
    [room.id],
  );
  assert.deepEqual(persisted.rows[0], { picks: 2, players: 2 });
  await assert.rejects(
    transactRoom(room.id, secondToken, command("undo", { expectedIndex: 2 })),
  );
  await assert.rejects(
    transactRoom(room.id, token, {
      ...request!,
      playerId: legal[3].id,
    } as Parameters<typeof transactRoom>[2]),
  );
});
test("expired timeout/manual race commits catch-up even when manual action loses", async () => {
  const { room, token } = await readyRoom();
  const queued = room.catalog.players.find((player) =>
    player.positions.includes("UTIL"),
  )!.id;
  await transactRoom(room.id, token, command("queue", { players: [queued] }));
  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-100)::bigint)) WHERE id=$1",
    [room.id],
  );
  const manual = command("pick", { expectedIndex: 0, playerId: queued });
  await Promise.allSettled([
    transactRoom(room.id, token, manual),
    transactRoom(room.id, token),
  ]);
  const { room: result } = await transactRoom(room.id, token);
  assert.equal(result.picks.length, 1);
  assert.equal(result.picks[0].playerId, queued);
  assert.equal(result.picks[0].source, "queue");
  assert.equal(
    (
      await database().query(
        "SELECT count(*)::int AS count FROM nba_draft.picks WHERE room_id=$1",
        [room.id],
      )
    ).rows[0].count,
    1,
  );
});
test("pause/resume preserves time; commissioner pick, undo, persistence and exports", async () => {
  const { room, token } = await readyRoom();
  const paused = await transactRoom(room.id, token, command("pause"));
  assert.equal(paused.room.phase, "paused");
  assert.ok(paused.room.remaining! > 0 && paused.room.remaining! <= 30000);
  const resumed = await transactRoom(room.id, token, command("resume"));
  assert.equal(
    resumed.room.deadline! - resumed.view.serverNow,
    paused.room.remaining,
  );
  const candidate = resumed.room.catalog.players.find((player) =>
    eligible(resumed.room, 0, player),
  )!;
  const picked = await transactRoom(
    room.id,
    token,
    command("pick", {
      playerId: candidate.id,
      expectedIndex: 0,
      forTeam: true,
    }),
  );
  const undone = await transactRoom(
    room.id,
    token,
    command("undo", {
      expectedIndex: 1,
      expectedPlayerId: candidate.id,
      expectedVersion: picked.view.version,
    }),
  );
  assert.equal(undone.room.phase, "paused");
  assert.equal(undone.room.remaining, 30000);
  assert.equal(undone.room.picks.length, 0);
  assert.equal(
    (
      await database().query(
        "SELECT count(*)::int AS count FROM nba_draft.picks WHERE room_id=$1",
        [room.id],
      )
    ).rows[0].count,
    0,
  );
  await transactRoom(room.id, token, command("resume"));
  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-300000)::bigint)) WHERE id=$1",
    [room.id],
  );
  const complete = await transactRoom(room.id, token);
  assert.equal(complete.room.phase, "complete");
  assert.equal(complete.room.picks.length, pickOrder(settings).length);
  assert.deepEqual(
    complete.room.picks.map((pick) => pick.slot),
    [0, 1, 1, 0, 1, 0],
  );
  const stored = (
    await database().query("SELECT data FROM nba_draft.rooms WHERE id=$1", [
      room.id,
    ])
  ).rows[0].data;
  assert.deepEqual(stored.picks, complete.room.picks);
  for (const kind of ["picks", "rosters", "order"] as const)
    assert.equal(exportCsv(complete.room, kind).split("\r\n").length, 8);
  const sheetSafe = {
    ...complete.room,
    members: complete.room.members.map((member) => ({
      ...member,
      name: "=SUM(1,2)",
    })),
  };
  assert.ok(exportCsv(sheetSafe, "picks").includes("'=SUM(1,2)"));
  assert.equal(roomView(complete.room).me, null);
});
test("queue skips ineligible players; matching uses real ESPN eligibility", async () => {
  const custom = {
    ...settings,
    slots: { ...settings.slots, UTIL: 0, PG: 1, G: 1 },
  };
  const { room, token, secondToken } = await readyRoom(custom);
  const center = room.catalog.players.find(
    (player) =>
      player.positions.includes("C") &&
      !player.positions.includes("PG") &&
      !player.positions.includes("G"),
  )!;
  const guard = room.catalog.players.find(
    (player) =>
      player.positions.includes("PG") && player.positions.includes("G"),
  )!;
  const laterGuard = room.catalog.players.find(
    (player) => player.id !== guard.id && player.positions.includes("PG"),
  )!;
  assert.ok(center);
  assert.ok(guard);
  await assert.rejects(
    transactRoom(
      room.id,
      token,
      command("pick", { playerId: center.id, expectedIndex: 0 }),
    ),
  );
  await transactRoom(
    room.id,
    token,
    command("queue", { players: [center.id, guard.id, laterGuard.id] }),
  );
  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-100)::bigint)) WHERE id=$1",
    [room.id],
  );
  const first = await transactRoom(room.id, token);
  assert.equal(first.room.picks[0].playerId, guard.id);
  assert.equal(first.room.picks[0].source, "queue");
  await transactRoom(
    room.id,
    secondToken,
    command("queue", { players: [guard.id] }),
  );
  const bestRemainingRate = Math.max(
    ...first.room.catalog.players
      .filter((player) => eligible(first.room, 1, player))
      .map((player) =>
        player.totals.PTS !== null &&
        player.totals.GP !== null &&
        player.totals.GP > 0
          ? player.totals.PTS / player.totals.GP
          : -Infinity,
      ),
  );
  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-100)::bigint)) WHERE id=$1",
    [room.id],
  );
  const next = await transactRoom(room.id, token);
  assert.equal(next.room.picks.length, 2);
  assert.equal(next.room.picks[1].source, "ranking");
  const automaticPlayer = next.room.catalog.players.find(
    (player) => player.id === next.room.picks[1].playerId,
  )!;
  assert.equal(
    automaticPlayer.totals.PTS! / automaticPlayer.totals.GP!,
    bestRemainingRate,
  );
  assert.ok(
    eligible(
      next.room,
      1,
      next.room.catalog.players.find(
        (player) =>
          !next.room.picks.some((pick) => pick.playerId === player.id) &&
          player.positions.includes("PG"),
      )!,
    ),
  );
  assert.equal(rosterSlots(custom).length, 2);
});
// Season 2025 is outside the app's season choices, so live rooms never share this cache row.
const OUTAGE_SEASON = 2025;
test("cache outage preserves real source values; frozen room cannot refresh", async () => {
  const catalog = await getCatalog(OUTAGE_SEASON);
  const original = await database().query(
    "SELECT attempted_at,error FROM nba_draft.catalogs WHERE season=$1",
    [OUTAGE_SEASON],
  );
  try {
    await database().query(
      "UPDATE nba_draft.catalogs SET attempted_at=NULL WHERE season=$1",
      [OUTAGE_SEASON],
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Task-scoped simulated upstream outage");
    };
    let cached;
    try {
      cached = await getCatalog(OUTAGE_SEASON, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(cached.players, catalog.players);
    assert.equal(cached.fetchedAt, catalog.fetchedAt);
    assert.match(cached.warning!, /refresh failed/i);
    const { room, token } = await readyRoom();
    await assert.rejects(transactRoom(room.id, token, command("refresh")));
  } finally {
    await database().query(
      "UPDATE nba_draft.catalogs SET attempted_at=$1,error=$2 WHERE season=$3",
      [original.rows[0].attempted_at, original.rows[0].error, OUTAGE_SEASON],
    );
  }
});

test("largest supported room catches up 600 expired picks within a serverless request budget", async () => {
  const custom: Settings = {
    ...settings,
    teamCount: 20,
    order: Array.from({ length: 20 }, (_, index) => index),
    seconds: 5,
    slots: { ...settings.slots, UTIL: 30 },
  };
  const { room, token } = await makeRoom(custom);
  await transactRoom(
    room.id,
    token,
    command("claim", { slot: 0, name: "Manager 1" }),
  );
  await transactRoom(room.id, token, command("ready", { ready: true }));
  for (let slot = 1; slot < 20; slot++) {
    const claimed = await transactRoom(
      room.id,
      undefined,
      command("claim", { slot, name: `Manager ${slot + 1}` }),
    );
    await transactRoom(
      room.id,
      claimed.token,
      command("ready", { ready: true }),
    );
  }
  await transactRoom(room.id, token, command("start"));
  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-4000000)::bigint)) WHERE id=$1",
    [room.id],
  );
  const started = performance.now();
  const caughtUp = await transactRoom(room.id, token);
  const duration = performance.now() - started;
  assert.equal(caughtUp.room.phase, "complete");
  assert.equal(caughtUp.room.picks.length, 600);
  assert.equal(
    new Set(caughtUp.room.picks.map((pick) => pick.playerId)).size,
    600,
  );
  assert.deepEqual(
    caughtUp.room.picks.map((pick) => pick.slot),
    pickOrder(custom),
  );
  assert.ok(duration < 30000, `Catch-up takes ${duration}ms`);
  const stored = await database().query(
    "SELECT count(*)::int AS picks,count(DISTINCT player_id)::int AS players FROM nba_draft.picks WHERE room_id=$1",
    [room.id],
  );
  assert.deepEqual(stored.rows[0], { picks: 600, players: 600 });
  console.log(
    JSON.stringify({
      room: room.id,
      largestCatchUpMilliseconds: Math.round(duration),
      picks: 600,
    }),
  );
});

test("a completely lost anonymous claim response can be replayed only with its private credential", async () => {
  const { room } = await makeRoom();
  const claim = command("claim", { slot: 0, name: "Lost response" })!;
  await transactRoom(room.id, undefined, claim); // Discard both issued secrets.
  const replay = await transactRoom(room.id, undefined, claim);
  assert.equal(replay.view.me?.slot, 0);
  assert.ok(replay.token);
  assert.ok(replay.recoveryCode);
  const cookieReplay = await transactRoom(room.id, replay.token, claim);
  assert.equal(cookieReplay.token, replay.token);
  assert.equal(cookieReplay.recoveryCode, replay.recoveryCode);
  await assert.rejects(
    transactRoom(room.id, undefined, {
      ...claim,
      retryCredential: randomBytes(32).toString("hex"),
    } as Parameters<typeof transactRoom>[2]),
    /different action/,
  );
  await assert.rejects(
    transactRoom(room.id, undefined, {
      ...claim,
      slot: 1,
    } as Parameters<typeof transactRoom>[2]),
    /different action/,
  );
  const anonymous = await transactRoom(room.id);
  assert.equal(anonymous.view.me, null);
  assert.equal(
    anonymous.room.members.filter((member) => member.slot === 0).length,
    1,
  );
  const persisted = (
    await database().query(
      "SELECT data::text AS room, (SELECT jsonb_agg(r)::text FROM nba_draft.requests r WHERE room_id=$1) AS receipts FROM nba_draft.rooms WHERE id=$1",
      [room.id],
    )
  ).rows[0];
  assert.equal(claim.type, "claim");
  if (claim.type !== "claim") throw new Error("Expected claim request");
  for (const secret of [
    replay.token!,
    replay.recoveryCode!,
    claim.retryCredential,
  ]) {
    assert.equal(persisted.room.includes(secret), false);
    assert.equal(persisted.receipts.includes(secret), false);
    assert.equal(JSON.stringify(anonymous.view).includes(secret), false);
  }
  const recovered = await transactRoom(
    room.id,
    undefined,
    command("recover", { code: replay.recoveryCode }),
  );
  assert.equal(recovered.view.me?.slot, 0);
});

test("undo rejects a replacement at the same count, including the same player drafted again", async () => {
  const { room, token } = await readyRoom({ ...settings, seconds: 600 });
  const [first, replacement] = room.catalog.players.filter((player) =>
    player.positions.includes("UTIL"),
  );
  const picked = await transactRoom(
    room.id,
    token,
    command("pick", { playerId: first.id, expectedIndex: 0 }),
  );
  const preview = command("undo", {
    expectedIndex: 1,
    expectedPlayerId: first.id,
    expectedVersion: picked.view.version,
  });
  await transactRoom(room.id, token, preview);
  await transactRoom(room.id, token, command("resume"));
  let latest = await transactRoom(
    room.id,
    token,
    command("pick", { playerId: replacement.id, expectedIndex: 0 }),
  );
  await assert.rejects(
    transactRoom(room.id, token, { ...preview!, requestId: randomUUID() }),
    /Latest pick changed/,
  );
  assert.equal(
    (await transactRoom(room.id, token)).room.picks[0].playerId,
    replacement.id,
  );
  await transactRoom(
    room.id,
    token,
    command("undo", {
      expectedIndex: 1,
      expectedPlayerId: replacement.id,
      expectedVersion: latest.view.version,
    }),
  );
  await transactRoom(room.id, token, command("resume"));
  latest = await transactRoom(
    room.id,
    token,
    command("pick", { playerId: first.id, expectedIndex: 0 }),
  );
  await assert.rejects(
    transactRoom(room.id, token, { ...preview!, requestId: randomUUID() }),
    /Latest pick changed/,
  );
  assert.equal(
    (
      await database().query(
        "SELECT player_id::int AS id FROM nba_draft.picks WHERE room_id=$1",
        [room.id],
      )
    ).rows[0].id,
    first.id,
  );
  const undone = await transactRoom(
    room.id,
    token,
    command("undo", {
      expectedIndex: 1,
      expectedPlayerId: first.id,
      expectedVersion: latest.view.version,
    }),
  );
  assert.equal(undone.room.picks.length, 0);
});

test("refresh and season changes share their room transaction connection under concurrent reads", async () => {
  await getCatalog(2026);
  for (const action of [
    command("refresh"),
    command("settings", { settings: { ...settings, season: 2026 } }),
  ]) {
    const { room, token } = await makeRoom();
    const started = performance.now();
    const results = await Promise.all([
      transactRoom(room.id, token, action),
      transactRoom(room.id, token),
      transactRoom(room.id, token),
    ]);
    assert.ok(performance.now() - started < 10000);
    assert.equal(
      results[0].room.catalog.season,
      action?.type === "settings" ? 2026 : 2027,
    );
    results.forEach((result) => assert.equal(result.room.phase, "lobby"));
  }
});

test("leave, rejoin, switch, and commissioner departure keep one owner per team", async () => {
  const { room, token, recoveryCode } = await makeRoom();
  const commissioner = await transactRoom(
    room.id,
    token,
    command("claim", { slot: 0, name: "Commish" }),
  );
  assert.equal(commissioner.view.me?.commissioner, true);
  const b = await transactRoom(
    room.id,
    undefined,
    command("claim", { slot: 1, name: "B" }),
  );
  await transactRoom(room.id, b.token, command("ready", { ready: true }));
  // Switching teams before start releases the old slot and clears ready.
  await transactRoom(room.id, b.token, command("leave"));
  await assert.rejects(
    transactRoom(room.id, b.token, command("ready", { ready: true })),
  );
  const rejoined = await transactRoom(
    room.id,
    undefined,
    command("claim", { slot: 1, name: "B again" }),
  );
  assert.equal(rejoined.view.me?.commissioner, false);
  const recovered = await transactRoom(
    room.id,
    undefined,
    command("recover", { code: recoveryCode }),
  );
  assert.equal(recovered.view.me?.commissioner, true);
  await transactRoom(room.id, token, command("ready", { ready: true }));
  const switched = await transactRoom(
    room.id,
    rejoined.token,
    command("claim", { slot: 0, name: "B" }),
  ).catch((error) => error);
  assert.match(String(switched.message), /already claimed/);
  // Commissioner hands off, then the new commissioner leaves; the role passes on.
  const handed = await transactRoom(
    room.id,
    token,
    command("transfer", { slot: 1 }),
  );
  assert.equal(handed.view.me?.commissioner, false);
  await assert.rejects(transactRoom(room.id, token, command("pause")));
  const departed = await transactRoom(
    room.id,
    rejoined.token,
    command("leave"),
  );
  assert.equal(departed.view.me, null);
  const after = await transactRoom(room.id, token);
  assert.equal(after.view.me?.commissioner, true);
  assert.equal(
    after.view.members.filter((member) => member.commissioner).length,
    1,
  );
});

test("a departed team keeps drafting by timeout and can be reclaimed mid-draft", async () => {
  const { room, token, secondToken } = await readyRoom();
  const left = await transactRoom(room.id, secondToken, command("leave"));
  assert.equal(left.room.phase, "live");
  assert.equal(
    left.view.members.some((member) => member.slot === 1),
    false,
  );
  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-1000)::bigint)) WHERE id=$1",
    [room.id],
  );
  const caught = await transactRoom(room.id, token);
  assert.ok(caught.room.picks.length >= 1);
  const reclaimed = await transactRoom(
    room.id,
    undefined,
    command("claim", { slot: 1, name: "Returning B" }),
  );
  assert.equal(reclaimed.view.me?.slot, 1);
  await assert.rejects(
    transactRoom(
      room.id,
      reclaimed.token,
      command("claim", { slot: 0, name: "X" }),
    ),
  );
});

test("only manager actions count as activity; polls and timeout picks do not", async () => {
  const { room, token } = await readyRoom();
  const started = await transactRoom(room.id, token);
  const activeAt = started.room.activeAt!;
  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-1000)::bigint)) WHERE id=$1",
    [room.id],
  );
  const polled = await transactRoom(room.id, token);
  assert.ok(polled.room.picks.length >= 1, "timeout pick happened");
  assert.equal(polled.room.activeAt, activeAt);
  const paused = await transactRoom(room.id, token, command("pause"));
  assert.ok(paused.room.activeAt! > activeAt);
});

test("scheduled expiry deletes only seven-day-inactive rooms and protects live drafts", async () => {
  const old = (days: number) =>
    `(extract(epoch FROM clock_timestamp())*1000 - ${days} * 86400000)::bigint`;
  const age = (id: string, days: number) =>
    database().query(
      `UPDATE nba_draft.rooms SET data=jsonb_set(data,'{activeAt}',to_jsonb(${old(days)})), created_at=clock_timestamp() - interval '${days} days' WHERE id=$1`,
      [id],
    );
  const lobby = await makeRoom();
  await age(lobby.room.id, 8);
  const finished = await readyRoom();
  await database().query(
    `UPDATE nba_draft.rooms SET data=jsonb_set(jsonb_set(data,'{activeAt}',to_jsonb(${old(9)})),'{deadline}',to_jsonb(${old(9)})) WHERE id=$1`,
    [finished.room.id],
  );
  const live = await readyRoom();
  await database().query(
    `UPDATE nba_draft.rooms SET data=jsonb_set(jsonb_set(data,'{activeAt}',to_jsonb(${old(8)})),'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000 + 3600000)::bigint)) WHERE id=$1`,
    [live.room.id],
  );
  const recent = await makeRoom();
  await age(recent.room.id, 6);
  const candidates = await database().query(
    `SELECT id, data->>'name' AS name FROM nba_draft.rooms WHERE COALESCE((data->>'activeAt')::bigint, (extract(epoch FROM created_at) * 1000)::bigint) < (extract(epoch FROM clock_timestamp()) * 1000)::bigint - $1`,
    [inactiveLimit],
  );
  // Earlier runs of this task may leave protected rooms; anything else blocks the sweep.
  const unrelated = candidates.rows.filter(
    (row) => !String(row.name).startsWith("t_167eb983 "),
  );
  assert.equal(
    unrelated.length,
    0,
    "Refusing to sweep: unrelated rooms are already expired.",
  );
  const dry = await expireRooms(true);
  assert.ok(dry.candidates >= 3 && dry.expired >= 2 && dry.kept >= 1);
  const exists = async (id: string) =>
    (await database().query("SELECT 1 FROM nba_draft.rooms WHERE id=$1", [id]))
      .rows.length === 1;
  assert.equal(await exists(lobby.room.id), true, "dry run deletes nothing");
  const swept = await expireRooms();
  assert.deepEqual(swept, dry);
  assert.equal(await exists(lobby.room.id), false);
  assert.equal(await exists(finished.room.id), false);
  assert.equal(await exists(live.room.id), true);
  assert.equal(await exists(recent.room.id), true);
  const orphans = await database().query(
    "SELECT (SELECT count(*) FROM nba_draft.picks WHERE room_id=ANY($1))::int AS picks, (SELECT count(*) FROM nba_draft.requests WHERE room_id=ANY($1))::int AS requests",
    [[lobby.room.id, finished.room.id]],
  );
  assert.deepEqual(orphans.rows[0], { picks: 0, requests: 0 });
  console.log(
    JSON.stringify({
      expiry: swept,
      expired: [lobby.room.id, finished.room.id],
      kept: [live.room.id, recent.room.id],
    }),
  );
});

test("a manager can take over only after the commissioner is idle", async () => {
  const { room, token, secondToken } = await readyRoom();
  const blocked = await transactRoom(
    room.id,
    secondToken,
    command("takeCommissioner"),
  ).catch((error) => error);
  assert.match(String(blocked.message), /commissioner is active/);
  await database().query(
    `UPDATE nba_draft.rooms SET data=jsonb_set(data,'{members,0,activeAt}',to_jsonb((extract(epoch FROM clock_timestamp())*1000 - $2)::bigint)) WHERE id=$1`,
    [room.id, commissionerIdleLimit + 1000],
  );
  const idle = await transactRoom(room.id, secondToken);
  assert.equal(idle.view.commissionerIdle, true);
  const taken = await transactRoom(
    room.id,
    secondToken,
    command("takeCommissioner"),
  );
  assert.equal(taken.view.me?.commissioner, true);
  assert.equal(
    taken.view.members.filter((member) => member.commissioner).length,
    1,
  );
  await assert.rejects(transactRoom(room.id, token, command("pause")));
  await transactRoom(room.id, secondToken, command("pause"));
});

test("polls read a small room row and leave the frozen player pool intact", async () => {
  const { room, token } = await readyRoom();
  const stored = () =>
    database()
      .query(
        "SELECT md5((data->'catalog')::text || (data->'ranking')::text) AS frozen, (data->>'version')::int AS version FROM nba_draft.rooms WHERE id=$1",
        [room.id],
      )
      .then((result) => result.rows[0]);
  const before = await stored();
  const query = Client.prototype.query;
  let bytes = 0;
  const poll = async () => {
    bytes = 0;
    Client.prototype.query = async function (this: Client, ...args: unknown[]) {
      const result = await (query as Function).apply(this, args);
      bytes += JSON.stringify(result?.rows ?? []).length;
      return result;
    } as typeof query;
    try {
      return await transactRoom(room.id, token, undefined, false);
    } finally {
      Client.prototype.query = query;
    }
  };
  const quiet = await poll();
  assert.ok(bytes < 20000, `poll read ${bytes} bytes`);
  assert.equal(quiet.view.phase, "live");
  assert.equal(quiet.view.me?.slot, 0);
  assert.ok(quiet.view.catalog.season);
  const full = await transactRoom(room.id, token);
  assert.ok(JSON.stringify(full.room.catalog.players).length > 20 * bytes);
  assert.deepEqual(await stored(), before);

  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-1000)::bigint)) WHERE id=$1",
    [room.id],
  );
  const due = await poll();
  assert.equal(due.view.picks.length, 1);
  assert.equal(due.view.picks[0].source, "ranking");
  assert.equal(due.view.picks[0].playerId, full.room.ranking[0]);
  const after = await stored();
  assert.equal(after.version, before.version + 1);
  const frozen = await database().query(
    "SELECT md5((data->'catalog')::text || (data->'ranking')::text) AS frozen FROM nba_draft.rooms WHERE id=$1",
    [room.id],
  );
  assert.equal(frozen.rows[0].frozen, before.frozen);
});

test("idle polls neither wait for nor take the room lock, and write no WAL", async () => {
  const { room, token } = await readyRoom();
  const holder = await database().connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM nba_draft.rooms WHERE id=$1 FOR UPDATE", [
      room.id,
    ]);
    const polled = await Promise.race([
      transactRoom(room.id, token, undefined, false),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("poll waited for the lock")), 3000),
      ),
    ]);
    assert.equal(polled.view.phase, "live");
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  const lsn = async () =>
    (await database().query("SELECT pg_current_wal_insert_lsn() AS lsn"))
      .rows[0].lsn;
  const start = await lsn();
  for (let poll = 0; poll < 20; poll++)
    await transactRoom(room.id, token, undefined, false);
  const written = await database().query(
    "SELECT pg_wal_lsn_diff($1, $2)::int AS bytes",
    [await lsn(), start],
  );
  assert.equal(written.rows[0].bytes, 0, "20 idle polls wrote WAL");
});

test("rooms share one stored player dataset and keep only its id", async () => {
  const first = await makeRoom(),
    second = await makeRoom();
  assert.equal(first.room.catalog.dataset, second.room.catalog.dataset);
  assert.ok(first.room.catalog.players.length > 100);
  const rows = await database().query(
    "SELECT data->'catalog' ? 'players' AS embedded, pg_column_size(data) AS bytes FROM nba_draft.rooms WHERE id = ANY($1)",
    [[first.room.id, second.room.id]],
  );
  for (const row of rows.rows) {
    assert.equal(row.embedded, false);
    assert.ok(row.bytes < 10000, `room row is ${row.bytes} bytes`);
  }
  const polled = await transactRoom(first.room.id, first.token);
  assert.deepEqual(polled.room.catalog.players, first.room.catalog.players);
});

test("weekly refresh pins running drafts, reuses unchanged pools, and lobby refresh re-pins", async () => {
  const season = OUTAGE_SEASON,
    custom = { ...settings, season };
  const base = await getCatalog(season);
  const original = (
    await database().query(
      "SELECT dataset_id, attempted_at, checked_at, error FROM nba_draft.catalogs WHERE season=$1",
      [season],
    )
  ).rows[0];
  const live = await readyRoom(custom);
  const lobby = await makeRoom(custom);
  const sample = readFileSync(
    new URL("./fixtures/espn-2027-sample.json", import.meta.url),
    "utf8",
  );
  const due = () =>
    database().query(
      "UPDATE nba_draft.catalogs SET attempted_at=NULL, checked_at=now() - make_interval(secs => $2::double precision / 1000) WHERE season=$1",
      [season, refreshAge + 60000],
    );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(sample, {
      headers: { "x-fantasy-filter-player-count": "4" },
    });
  };
  try {
    await due();
    const refreshed = await getCatalog(season);
    assert.equal(calls, 1);
    assert.notEqual(refreshed.dataset, base.dataset);
    assert.equal(refreshed.source?.reported, 4);
    assert.ok(refreshed.checkedAt);
    assert.equal((await getCatalog(season)).dataset, refreshed.dataset);
    assert.equal(calls, 1, "a fresh check is reused for a week");
    await due();
    assert.equal((await getCatalog(season)).dataset, refreshed.dataset);
    assert.equal(calls, 2, "an unchanged pool keeps its dataset");

    const running = await transactRoom(live.room.id, live.token);
    assert.equal(running.room.catalog.dataset, base.dataset);
    assert.deepEqual(running.room.catalog.players, base.players);
    const repinned = await transactRoom(
      lobby.room.id,
      lobby.token,
      command("refresh"),
    );
    assert.equal(repinned.room.catalog.dataset, refreshed.dataset);
    assert.equal(calls, 2, "lobby refresh within 15 minutes reuses the check");
    await assert.rejects(
      transactRoom(live.room.id, live.token, command("refresh")),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await database().query(
      "UPDATE nba_draft.catalogs SET dataset_id=$2, attempted_at=$3, checked_at=$4, error=$5 WHERE season=$1",
      [
        season,
        original.dataset_id,
        original.attempted_at,
        original.checked_at,
        original.error,
      ],
    );
  }
});

test("migration moves a legacy embedded pool into a shared dataset without touching picks", async () => {
  const { room, token } = await readyRoom();
  await transactRoom(
    room.id,
    token,
    command("pick", {
      playerId: (await transactRoom(room.id, token)).room.ranking[0],
      expectedIndex: 0,
    }),
  );
  const { players, ...meta } = room.catalog;
  const { dataset: _dataset, ...legacy } = meta;
  await database().query(
    "UPDATE nba_draft.rooms SET data = jsonb_set(data, '{catalog}', $2::jsonb) WHERE id=$1",
    [room.id, JSON.stringify({ ...legacy, players })],
  );
  const snapshot = () =>
    database()
      .query(
        "SELECT md5((r.data - 'catalog')::text) AS room, (SELECT md5(string_agg(pick_index||':'||player_id, ',' ORDER BY pick_index)) FROM nba_draft.picks WHERE room_id=r.id) AS picks FROM nba_draft.rooms r WHERE id=$1",
        [room.id],
      )
      .then((result) => result.rows[0]);
  // Before migration the room keeps working on its embedded pool and never loses it.
  const legacyRead = await transactRoom(room.id, token);
  assert.deepEqual(legacyRead.room.catalog.players, players);
  await transactRoom(
    room.id,
    token,
    command("queue", { players: [legacyRead.room.ranking[5]] }),
  );
  const embedded = await database().query(
    "SELECT jsonb_array_length(data->'catalog'->'players') AS players FROM nba_draft.rooms WHERE id=$1",
    [room.id],
  );
  assert.equal(embedded.rows[0].players, players.length);
  const before = await snapshot();
  const datasets = async () =>
    (
      await database().query(
        "SELECT count(*)::int AS n FROM nba_draft.datasets",
      )
    ).rows[0].n;
  const count = await datasets();
  await database().query(
    readFileSync(new URL("../db/002.sql", import.meta.url), "utf8"),
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(await datasets(), count, "identical pool reuses its dataset");
  const migrated = await transactRoom(room.id, token);
  assert.equal(migrated.room.catalog.dataset, room.catalog.dataset);
  assert.deepEqual(migrated.room.catalog.players, players);
  assert.equal(migrated.room.picks.length, 1);
});

test("a poll with the shown version gets only clock fields until the room changes", async () => {
  const { room, token, secondToken } = await readyRoom();
  const first = await pollRoom(room.id, token);
  assert.ok(!("unchanged" in first));
  const query = Client.prototype.query;
  let bytes = 0;
  Client.prototype.query = async function (this: Client, ...args: unknown[]) {
    const result = await (query as Function).apply(this, args);
    bytes += JSON.stringify(result?.rows ?? []).length;
    return result;
  } as typeof query;
  let same;
  try {
    same = await pollRoom(room.id, token, first.version);
  } finally {
    Client.prototype.query = query;
  }
  assert.ok(bytes < 300, `unchanged poll read ${bytes} bytes`);
  assert.deepEqual(Object.keys(same).sort(), [
    "commissionerIdle",
    "serverNow",
    "unchanged",
    "version",
  ]);
  assert.equal(same.version, first.version);
  assert.equal(same.commissionerIdle, first.commissionerIdle);

  const ranked = (await transactRoom(room.id, token)).room.ranking;
  await transactRoom(
    room.id,
    token,
    command("pick", { playerId: ranked[0], expectedIndex: 0 }),
  );
  const changed = await pollRoom(room.id, secondToken, first.version);
  assert.ok(!("unchanged" in changed));
  assert.equal(changed.picks.length, 1);
  assert.equal(changed.me?.slot, 1);

  await database().query(
    "UPDATE nba_draft.rooms SET data=jsonb_set(data,'{deadline}',to_jsonb((extract(epoch FROM clock_timestamp())*1000-1000)::bigint)) WHERE id=$1",
    [room.id],
  );
  const due = await pollRoom(room.id, token, changed.version);
  assert.ok(!("unchanged" in due));
  assert.equal(due.picks.length, 2);
  assert.equal(due.picks[1].source, "ranking");
});
