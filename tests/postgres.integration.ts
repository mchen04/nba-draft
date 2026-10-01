import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { database } from "../lib/db";
import { createRoom, roomView, transactRoom } from "../lib/engine";
import { getCatalog } from "../lib/espn";
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
    `t_d4c47e94 Postgres acceptance ${randomUUID().slice(0, 8)}`,
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
  await transactRoom(
    created.room.id,
    created.token,
    command("start", { acknowledge: true }),
  );
  return { ...created, secondToken: second.token! };
}
after(async () => {
  console.log(JSON.stringify({ task: "t_d4c47e94", evidenceRooms: ids }));
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
test("cache outage preserves real source values; frozen room cannot refresh", async () => {
  const catalog = await getCatalog(2027);
  const original = await database().query(
    "SELECT attempted_at,error FROM nba_draft.catalogs WHERE season=2027",
  );
  try {
    await database().query(
      "UPDATE nba_draft.catalogs SET attempted_at=NULL WHERE season=2027",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Task-scoped simulated upstream outage");
    };
    let cached;
    try {
      cached = await getCatalog(2027, true);
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
      "UPDATE nba_draft.catalogs SET attempted_at=$1,error=$2 WHERE season=2027",
      [original.rows[0].attempted_at, original.rows[0].error],
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
  await transactRoom(room.id, token, command("start", { acknowledge: true }));
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
