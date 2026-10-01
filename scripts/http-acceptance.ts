import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { defaultSettings } from "../lib/model";

const origin = process.argv[2] ?? "http://127.0.0.1:3104",
  evidence = process.argv[3];
const results: { check: string; status: number }[] = [];
async function request(
  path: string,
  payload?: unknown,
  cookie?: string,
  suppliedOrigin = origin,
) {
  const response = await fetch(`${origin}${path}`, {
    method: payload ? "POST" : "GET",
    headers: {
      ...(payload
        ? { "Content-Type": "application/json", Origin: suppliedOrigin }
        : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  return {
    response,
    text,
    data: response.headers.get("Content-Type")?.includes("json")
      ? JSON.parse(text)
      : null,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
function check(
  name: string,
  response: Awaited<ReturnType<typeof request>>,
  status: number,
) {
  assert.equal(response.response.status, status, name);
  results.push({ check: name, status });
}
const action = (type: string, fields = {}) => ({
  type,
  ...(type === "claim"
    ? { retryCredential: randomBytes(32).toString("hex") }
    : {}),
  ...fields,
  requestId: randomUUID(),
});
async function main() {
  check(
    "cross-origin create rejects",
    await request("/api/rooms", {}, undefined, "https://unrelated.example"),
    403,
  );
  check(
    "invalid settings reject",
    await request("/api/rooms", {
      name: "t_167eb983 invalid",
      commissioner: "Commissioner",
      settings: { ...defaultSettings, seconds: 0 },
    }),
    400,
  );
  const settings = {
    ...defaultSettings,
    teamCount: 2,
    order: [0, 1],
    seconds: 60,
    slots: { PG: 0, SG: 0, SF: 0, PF: 0, C: 0, G: 0, F: 0, UTIL: 1, BN: 0 },
    scoring: "points",
    fallback: "FP",
  };
  const created = await request("/api/rooms", {
    name: "t_167eb983 HTTP acceptance",
    commissioner: "HTTP A",
    settings,
  });
  check("same-origin creates real room", created, 201);
  assert.ok(created.cookie);
  assert.match(created.response.headers.get("set-cookie")!, /HttpOnly/i);
  const id = created.data.id,
    path = `/api/rooms/${id}`,
    owner = created.cookie!;
  check(
    "commissioner claims",
    await request(path, action("claim", { slot: 0, name: "HTTP A" }), owner),
    200,
  );
  check(
    "start rejects unready teams",
    await request(path, action("start"), owner),
    409,
  );
  const claimRequests = [
    action("claim", { slot: 1, name: "HTTP B" }),
    action("claim", { slot: 1, name: "HTTP C" }),
  ];
  const claims = await Promise.all(
    claimRequests.map((claim) => request(path, claim)),
  );
  assert.deepEqual(
    claims.map((result) => result.response.status).sort(),
    [200, 409],
  );
  results.push({ check: "HTTP concurrent claim exactly one", status: 200 });
  const manager = claims.find((result) => result.response.status === 200)!;
  assert.ok(manager.cookie);
  const savedClaim = claimRequests[claims.indexOf(manager)];
  const lostReplay = await request(path, savedClaim);
  check(
    "complete lost claim response restores private credentials without original cookie",
    lostReplay,
    200,
  );
  assert.equal(lostReplay.cookie, manager.cookie);
  assert.equal(lostReplay.data.recoveryCode, manager.data.recoveryCode);
  check(
    "claim retry also accepts the delivered ownership cookie",
    await request(path, savedClaim, manager.cookie),
    200,
  );
  check(
    "request ID alone cannot retrieve claim secrets",
    await request(path, {
      ...savedClaim,
      retryCredential: randomBytes(32).toString("hex"),
    }),
    409,
  );
  check(
    "claim requires a private retry credential",
    await request(path, { ...savedClaim, retryCredential: undefined }),
    400,
  );
  const pool = (await request(`${path}?catalog=1`)).data;
  const candidate = pool.players.find(
    (player: { positions: string[]; projected: boolean }) =>
      player.positions.includes("UTIL") && player.projected,
  );
  check(
    "queue persists",
    await request(
      path,
      action("queue", { players: [candidate.id] }),
      manager.cookie,
    ),
    200,
  );
  const spectator = await request(path);
  assert.deepEqual(spectator.data.queue, []);
  assert.equal(spectator.data.me, null);
  assert.equal(spectator.text.includes("sessions"), false);
  assert.equal(spectator.text.includes("recovery"), false);
  check("invite view hides ownership and private queue", spectator, 200);
  check(
    "anonymous queue forbidden",
    await request(path, action("queue", { players: [] })),
    403,
  );
  check(
    "cross-origin action forbidden",
    await request(
      path,
      action("ready", { ready: true }),
      owner,
      "https://unrelated.example",
    ),
    403,
  );
  check(
    "manager ready",
    await request(path, action("ready", { ready: true }), manager.cookie),
    200,
  );
  check(
    "commissioner ready",
    await request(path, action("ready", { ready: true }), owner),
    200,
  );
  check("start succeeds", await request(path, action("start"), owner), 200);
  check(
    "manager cannot impersonate commissioner",
    await request(
      path,
      action("pick", {
        playerId: candidate.id,
        expectedIndex: 0,
        forTeam: true,
      }),
      manager.cookie,
    ),
    403,
  );
  check(
    "settings freeze after start",
    await request(path, action("settings", { settings }), owner),
    409,
  );
  check(
    "pause protected",
    await request(path, action("pause"), manager.cookie),
    403,
  );
  const pick = action("pick", { playerId: candidate.id, expectedIndex: 0 });
  const repeated = await Promise.all([
    request(path, pick, owner),
    request(path, pick, owner),
  ]);
  repeated.forEach((result) => {
    check("HTTP idempotent pick retry", result, 200);
    assert.equal(result.data.picks.length, 1);
  });
  check(
    "stale pick rejected",
    await request(
      path,
      action("pick", { playerId: candidate.id, expectedIndex: 0 }),
      owner,
    ),
    409,
  );
  check(
    "invalid recovery rejected",
    await request(
      path,
      action("recover", { code: "incorrect-recovery-code-for-test" }),
    ),
    403,
  );
  const recovered = await request(
    path,
    action("recover", { code: manager.data.recoveryCode }),
  );
  check("cross-device recovery restores private queue", recovered, 200);
  assert.equal(recovered.data.me.slot, 1);
  assert.deepEqual(recovered.data.queue, [candidate.id]);
  check(
    "anonymous export forbidden",
    await request(`${path}/export?kind=picks`),
    403,
  );
  for (const kind of ["picks", "rosters", "order"]) {
    const exported = await request(
      `${path}/export?kind=${kind}`,
      undefined,
      owner,
    );
    check(`authenticated ${kind} CSV`, exported, 200);
    assert.match(
      exported.response.headers.get("Content-Disposition")!,
      /attachment/,
    );
    assert.ok(exported.text.includes("draft_id"));
  }
  const expiry = (authorization?: string) =>
    fetch(`${origin}/api/cron/expire?dryRun=1`, {
      headers: authorization ? { Authorization: authorization } : {},
    });
  assert.equal((await expiry()).status, 401);
  results.push({ check: "Expiry route rejects missing secret", status: 401 });
  assert.equal((await expiry("Bearer wrong")).status, 401);
  results.push({ check: "Expiry route rejects wrong secret", status: 401 });
  if (process.env.CRON_SECRET) {
    const dry = await expiry(`Bearer ${process.env.CRON_SECRET}`);
    assert.equal(dry.status, 200);
    assert.deepEqual(Object.keys(await dry.json()), [
      "candidates",
      "expired",
      "kept",
    ]);
    results.push({ check: "Expiry dry run with secret", status: 200 });
  }
  writeFileSync(
    `${evidence}/http-results.json`,
    JSON.stringify(
      {
        result: "PASS",
        completedAt: new Date().toISOString(),
        room: id,
        checks: results,
      },
      null,
      2,
    ),
  );
  console.log(
    `${results.length} actual HTTP checks pass against the running Postgres app.`,
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
