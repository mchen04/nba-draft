import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { database } from "../lib/db";
import { getCatalog } from "../lib/espn";
import {
  cli,
  click,
  fill,
  select,
  waitFor,
  evaluate,
  shot,
  snapshot,
  overflow,
} from "./browser-acceptance";

const origin = process.argv[2], evidence = process.argv[3];
const first = "nba-t_d4c47e94-extra-a", second = "nba-t_d4c47e94-extra-b";

async function main() {
  const original = await database().query(
    "SELECT attempted_at,error FROM nba_draft.catalogs WHERE season=2027",
  );
  try {
    cli(first, ["open", origin]);
    cli(first, ["set", "viewport", "1440", "1000"]);
    fill(first, "Room name", "t_d4c47e94 Browser controls proof");
    fill(first, "Commissioner name", "Controls A");
    fill(first, "Teams", "2", "spinbutton");
    fill(first, "Seconds per pick", "600", "spinbutton");
    for (const slot of ["PG", "SG", "SF", "PF", "C", "G", "F", "BN"])
      fill(first, slot, "0", "spinbutton");
    fill(first, "UTIL", "1", "spinbutton");
    select(first, "Scoring", "points");
    fill(first, "PTS", "1.25", "spinbutton");
    fill(first, "Draft order (team numbers, separated by commas)", "1,1");
    click(first, "Create draft room");
    await waitFor(
      () => snapshot(first).includes("Draft order must contain every team once."),
      "invalid draft order is visible",
    );
    shot(first, "invalid-settings-desktop");
    fill(first, "Draft order (team numbers, separated by commas)", "1,2");
    click(first, "Create draft room");
    await waitFor(
      () => evaluate(first, "return location.pathname.startsWith('/room/');"),
      "points room created",
    );
    const url = evaluate(first, "return location.href;"), id = url.split("/").at(-1);
    const state = () => evaluate(
      first,
      `return fetch('/api/rooms/${id}').then(response=>response.json());`,
    );
    await waitFor(() => snapshot(first).includes("Draft lobby"), "points lobby");
    click(first, "League settings");
    select(first, "Draft format", "snake");
    click(first, "Save league settings");
    await waitFor(() => state().settings.format === "snake", "lobby settings saved");
    click(first, "League settings");
    select(first, "Draft format", "3rr");
    click(first, "Save league settings");
    await waitFor(() => state().settings.format === "3rr", "3RR restored");

    const before = await getCatalog(2027);
    await database().query(
      "UPDATE nba_draft.catalogs SET attempted_at=NULL WHERE season=2027",
    );
    const normalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("Task-scoped upstream outage"); };
    let cached;
    try {
      cached = await getCatalog(2027, true);
    } finally {
      globalThis.fetch = normalFetch;
    }
    assert.equal(cached.fetchedAt, before.fetchedAt);
    assert.equal(cached.projectedCount, before.projectedCount);
    click(first, "Refresh ESPN cache");
    await waitFor(
      () => snapshot(first).includes("ESPN refresh failed"),
      "honest cached outage warning",
    );
    cli(first, ["scrollintoview", ".data-footer"]);
    shot(first, "cache-outage-desktop");
    fill(first, "Manager name", "Controls A");
    click(first, "Claim team 1");
    await waitFor(
      () => state().me?.slot === 0 && snapshot(first).includes("Ready to draft"),
      "claim A",
    );
    click(first, "Ready to draft");
    cli(second, ["open", url]);
    cli(second, ["set", "viewport", "320", "568"]);
    await waitFor(() => snapshot(second).includes("Draft lobby"), "claim B lobby");
    click(second, /Team 2.*Open slot/);
    fill(second, "Manager name", "Controls B");
    click(second, "Claim team 2");
    await waitFor(
      () => evaluate(
        second,
        `return fetch('/api/rooms/${id}').then(response=>response.json()).then(state=>state.me?.slot);`,
      ) === 1 && snapshot(second).includes("Ready to draft"),
      "claim B",
    );
    click(second, "Ready to draft");
    click(first, "Start draft");
    await waitFor(
      () => snapshot(first).includes("Acknowledge stale, missing, or cached source data"),
      "outage acknowledgment required",
    );
    click(first, "I accept any stale, missing, or cached source data shown below", "checkbox");
    click(first, "Start draft");
    await waitFor(() => state().phase === "live", "start with actual cached pool");
    click(first, "Players");
    fill(first, "Search players", "Luka Doncic");
    click(first, "Queue Luka Doncic");
    await waitFor(() => state().queue.length === 1, "queued");
    click(first, "Remove Luka Doncic");
    await waitFor(() => state().queue.length === 0, "queue removal");
    click(first, "Select Luka Doncic");

    const blocked = await database().connect();
    try {
      await blocked.query("BEGIN");
      await blocked.query("SELECT id FROM nba_draft.rooms WHERE id=$1 FOR UPDATE", [id]);
      click(first, "Draft Luka Doncic");
      cli(first, ["set", "offline", "on"]);
      await waitFor(
        () => snapshot(first).includes("Retry saved request"),
        "network failure offers idempotent retry",
      );
      shot(first, "retry-desktop");
    } finally {
      await blocked.query("ROLLBACK");
      blocked.release();
    }
    cli(first, ["set", "offline", "off"]);
    await waitFor(() => snapshot(first).includes("Connected"), "network returns");
    assert.equal(state().picks.length, 1);
    click(first, "Retry saved request");
    await waitFor(() => state().picks.length === 1, "saved request picked exactly once");

    click(second, "Players");
    fill(second, "Search players", "Nikola Jokic");
    const selected = cli(second, ["snapshot", "-i"]).refs;
    const selectRef = Object.entries(
      selected as Record<string, { name: string; role: string }>,
    ).find(([, item]) => item.role === "button" && item.name === "Select Nikola Jokic")!;
    cli(second, ["scrollintoview", `@${selectRef[0]}`]);
    cli(second, ["focus", `@${selectRef[0]}`]);
    cli(second, ["press", "Enter"]);
    assert.equal(state().picks.length, 1);
    await waitFor(
      () => snapshot(second).includes("Draft Nikola Jokic"),
      "keyboard selection guard",
    );
    const draftRefs = cli(second, ["snapshot", "-i"]).refs;
    const draftRef = Object.entries(
      draftRefs as Record<string, { name: string; role: string }>,
    ).find(([, item]) => item.role === "button" && item.name === "Draft Nikola Jokic")!;
    cli(second, ["focus", `@${draftRef[0]}`]);
    const stalled = await database().connect();
    const stalledAt = Date.now();
    let waitedMilliseconds = 0;
    try {
      await stalled.query("BEGIN");
      await stalled.query("SELECT id FROM nba_draft.rooms WHERE id=$1 FOR UPDATE", [id]);
      cli(second, ["press", "Enter"]);
      await waitFor(
        () => snapshot(second).includes("Retry saved request"),
        "stalled request stops waiting",
      );
      waitedMilliseconds = Date.now() - stalledAt;
      assert.ok(waitedMilliseconds >= 29000 && waitedMilliseconds < 45000);
    } finally {
      await stalled.query("ROLLBACK");
      stalled.release();
    }
    await waitFor(
      () => snapshot(second).includes("Connected"),
      "connection recovers after stalled read",
    );
    assert.equal(state().picks.length, 2);
    click(second, "Retry saved request");
    await waitFor(
      () => state().phase === "complete",
      "keyboard draft and saved retry complete once",
    );
    click(second, "Players");
    fill(second, "Search players", "");
    click(second, "Filters");
    select(second, "Position", "PG");
    select(second, "Sort by", "rank");
    click(second, "Board");
    click(second, "Players");
    assert.equal(
      evaluate(second, "return document.querySelector('.player-filters select').value;"),
      "PG",
    );
    shot(second, "mobile-filters-points");
    click(second, "Hide filters");
    overflow(second);
    const final = state();
    assert.equal(final.picks.length, 2);
    assert.equal(final.settings.weights.PTS, 1.25);
    for (const session of [first, second]) {
      assert.deepEqual(cli(session, ["errors"]).errors ?? [], []);
      assert.deepEqual(cli(session, ["console"]).messages ?? [], []);
    }
    writeFileSync(
      `${evidence}/ui-extra-results.json`,
      JSON.stringify({
        result: "PASS",
        visualCapture: process.env.CAPTURE_TRANSPORT === "none"
          ? "UNPROVEN: extra screenshots unavailable; see capture-unavailable.jsonl"
          : "Captured; open images before claiming visual proof",
        completedAt: new Date().toISOString(),
        room: id,
        stalledRequestWaitMilliseconds: waitedMilliseconds,
        originalRequestsPersistBeforeRetry: true,
        checks: [
          "client invalid-order rejection",
          "custom points weights",
          "lobby save snake/3RR",
          "source outage preserves real cache",
          "warning and start acknowledgment",
          "queue removal",
          "browser network failure and retry under real Postgres contention",
          "30-second stalled action cancellation and saved retry",
          "keyboard select then draft",
          "mobile filters, rank sort and state preservation",
        ],
        picks: final.picks,
      }, null, 2),
    );
    console.log("Extra browser controls, cache warning, retry, keyboard, points, and mobile-filter checks pass.");
  } finally {
    await database().query(
      "UPDATE nba_draft.catalogs SET attempted_at=$1,error=$2 WHERE season=2027",
      [original.rows[0].attempted_at, original.rows[0].error],
    );
    for (const session of [first, second]) {
      try { cli(session, ["close"]); } catch {}
    }
    await database().end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
