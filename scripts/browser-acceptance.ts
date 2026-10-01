import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const origin = process.argv[2] ?? "http://127.0.0.1:3104";
const evidence = resolve(process.argv[3] ?? "../nba-draft-evidence");
const sessions = ["nba-t_d4c47e94-a", "nba-t_d4c47e94-b", "nba-t_d4c47e94-c"];
mkdirSync(`${evidence}/screenshots`, { recursive: true });
const receipt = `${evidence}/browser-commands.jsonl`;
function cli(session: string, args: string[], privateResult = false) {
  const output = execFileSync(
    "agent-browser",
    ["--session", session, "--json", ...args],
    { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  const result = JSON.parse(output);
  appendFileSync(
    receipt,
    JSON.stringify({
      at: new Date().toISOString(),
      session,
      args: privateResult ? [args[0], "private recovery"] : args,
      result: privateResult ? { success: result.success } : result,
    }) + "\n",
  );
  if (!result.success)
    throw new Error(result.error ?? "Browser command failed.");
  return result.data;
}
function element(session: string, role: string, name: string | RegExp) {
  const snapshot = cli(session, ["snapshot", "-i"]);
  const match = Object.entries(
    snapshot.refs as Record<string, { role: string; name: string }>,
  ).find(
    ([, item]) =>
      item.role === role &&
      (typeof name === "string" ? item.name === name : name.test(item.name)),
  );
  if (!match) throw new Error(`Missing ${role}: ${name}`);
  return `@${match[0]}`;
}
function click(session: string, name: string | RegExp, role = "button") {
  cli(session, ["scrollintoview", element(session, role, name)]);
  const deadline = Date.now() + 15000;
  while (
    !cli(session, ["is", "enabled", element(session, role, name)]).enabled
  ) {
    if (Date.now() >= deadline)
      throw new Error(`Action stays disabled: ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  cli(session, ["click", element(session, role, name)]);
}
function fill(
  session: string,
  name: string,
  input: string,
  role = "textbox",
  privateResult = false,
) {
  if (input === "") {
    click(session, "Clear search");
    return;
  }
  cli(
    session,
    [
      "fill",
      element(session, name === "Search players" ? "searchbox" : role, name),
      input,
    ],
    privateResult,
  );
}
function select(session: string, name: string, input: string) {
  cli(session, ["select", element(session, "combobox", name), input]);
}
const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(test: () => boolean, label: string) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (test()) return;
    await pause(500);
  }
  throw new Error(`Timed out: ${label}`);
}
function evaluate(session: string, source: string, privateResult = false) {
  return cli(session, ["eval", `(() => { ${source} })()`], privateResult)
    .result;
}
function snapshot(session: string) {
  return cli(session, ["snapshot"]).snapshot as string;
}
function shot(session: string, name: string) {
  cli(session, ["wait", "400"]);
  if (process.env.CAPTURE_TRANSPORT === "none") {
    appendFileSync(
      `${evidence}/capture-unavailable.jsonl`,
      JSON.stringify({
        requestedAt: new Date().toISOString(),
        session,
        name,
        reason: "Screenshot unavailable. No image or visual pass is claimed.",
      }) + "\n",
    );
    return;
  }
  cli(session, ["screenshot", `${evidence}/screenshots/${name}.png`]);
}
function overflow(session: string) {
  const result = evaluate(
    session,
    "return {width:innerWidth,scroll:document.documentElement.scrollWidth,clock:!!document.querySelector('.clock-block')};",
  );
  assert.ok(
    result.scroll <= result.width,
    `Page overflow ${JSON.stringify(result)}`,
  );
  return result;
}
function usableList(session: string) {
  const bounds = evaluate(
    session,
    `
    const listNode = document.querySelector('.table-scroll');
    const list = listNode.getBoundingClientRect();
    const heading = document.querySelector('.player-table thead').getBoundingClientRect();
    const tray = document.querySelector('.selection-tray').getBoundingClientRect();
    const summary = document.querySelector('.room-summary').getBoundingClientRect();
    const top = Math.max(list.top + heading.height, summary.bottom);
    const bottom = Math.min(list.top + listNode.clientHeight, tray.top);
    const rows = [...document.querySelectorAll('.player-table tbody tr')].filter(row => {
      const rect = row.getBoundingClientRect();
      return rect.top >= top - 1 && rect.bottom <= bottom + 1;
    });
    return { width: innerWidth, height: innerHeight, listTop: list.top, listBottom: list.bottom,
      trayTop: tray.top, fullRows: rows.length, rowCount: document.querySelectorAll('.player-table tbody tr').length };
  `,
  );
  appendFileSync(
    `${evidence}/list-bounds.jsonl`,
    JSON.stringify(bounds) + "\n",
  );
  assert.ok(
    bounds.listBottom <= bounds.trayTop + 1,
    `List overlaps action bar: ${JSON.stringify(bounds)}`,
  );
  assert.ok(
    bounds.fullRows >= Math.min(3, bounds.rowCount),
    `Too few usable rows: ${JSON.stringify(bounds)}`,
  );
  return bounds;
}
async function searchPlayer(session: string, name: string) {
  click(session, "Players");
  fill(session, "Search players", name);
  await waitFor(() => snapshot(session).includes(`Select ${name}`), name);
  click(session, `Select ${name}`);
}
async function draft(
  session: string,
  name: string,
  count: number,
  state: () => { picks: { slot: number; playerId: number; source: string }[] },
) {
  await searchPlayer(session, name);
  assert.equal(
    cli(session, ["is", "enabled", element(session, "button", `Draft ${name}`)])
      .enabled,
    true,
  );
  click(session, `Draft ${name}`);
  await waitFor(() => state().picks.length === count, `pick ${count}`);
}

async function main() {
  const [first, second, recovered] = sessions;
  try {
    cli(first, ["open", origin]);
    cli(first, ["set", "viewport", "1440", "1000"]);
    fill(
      first,
      "Room name",
      `t_d4c47e94 Browser acceptance ${new Date().toISOString()}`,
    );
    fill(first, "Commissioner name", "Manager A");
    fill(first, "Teams", "2", "spinbutton");
    fill(first, "Seconds per pick", "600", "spinbutton");
    for (const slot of ["SG", "SF", "PF", "F", "UTIL", "BN"])
      fill(first, slot, "0", "spinbutton");
    shot(first, "setup-desktop");
    click(first, "Create draft room");
    await waitFor(
      () => evaluate(first, "return location.pathname.startsWith('/room/');"),
      "create room",
    );
    await waitFor(
      () => snapshot(first).includes("Draft lobby"),
      "lobby loaded",
    );
    const url = evaluate(first, "return location.href;");
    const id = url.split("/").at(-1);
    writeFileSync(`${evidence}/browser-room.txt`, `${id}\n${url}\n`);
    const state = () =>
      evaluate(
        first,
        `return fetch('/api/rooms/${id}').then(response => response.json());`,
      );
    const source = evaluate(
      first,
      `return fetch('/api/rooms/${id}?catalog=1').then(response => response.json());`,
    );
    const playerId = (name: string) =>
      source.players.find(
        (player: { name: string; id: number }) => player.name === name,
      ).id;
    fill(first, "Manager name", "Manager A");
    click(first, "Claim team 1");
    await waitFor(
      () => snapshot(first).includes("Ready to draft"),
      "first claim",
    );
    click(first, "Copy invite link");
    click(first, "Ready to draft");
    cli(second, ["open", url]);
    cli(second, ["set", "viewport", "320", "568"]);
    await waitFor(
      () => snapshot(second).includes("Draft lobby"),
      "second lobby",
    );
    click(second, /Team 2.*Open slot/);
    fill(second, "Manager name", "Manager B");
    click(second, "Claim team 2");
    await waitFor(
      () => snapshot(second).includes("Ready to draft"),
      "second claim",
    );
    const recovery = evaluate(
      second,
      `return sessionStorage.getItem('recovery_${id}');`,
      true,
    );
    click(second, "Ready to draft");
    await waitFor(
      () =>
        state().members.filter(
          (member: { ready: boolean; slot: number | null }) =>
            member.slot !== null && member.ready,
        ).length === 2,
      "both ready",
    );
    shot(first, "lobby-desktop");
    shot(second, "lobby-phone");
    overflow(second);
    click(first, "Start draft");
    await waitFor(() => state().phase === "live", "live draft");
    click(first, "Pause");
    await waitFor(() => state().phase === "paused", "paused");
    const remaining = state().remaining;
    await pause(1200);
    assert.equal(state().remaining, remaining);
    click(first, "Resume");
    await waitFor(() => state().phase === "live", "resumed");
    await searchPlayer(first, "Luka Doncic");
    click(first, "Queue Luka Doncic");
    await waitFor(() => state().queue.length === 1, "queued Luka");
    fill(first, "Search players", "Trae Young");
    click(first, "Queue Trae Young");
    await waitFor(() => state().queue.length === 2, "queued Trae");
    click(first, "Move Trae Young up");
    await waitFor(
      () =>
        state().queue[0] !== state().queue[1] &&
        state().queue[0] === playerId("Trae Young"),
      "queue reorder",
    );
    click(first, "Move Trae Young down");
    await waitFor(
      () => state().queue[0] === playerId("Luka Doncic"),
      "queue reorder back",
    );
    assert.equal(
      evaluate(
        second,
        `return fetch('/api/rooms/${id}').then(response=>response.json()).then(state=>state.queue.length);`,
      ),
      0,
    );
    await searchPlayer(second, "Shai Gilgeous-Alexander");
    click(second, "Queue Shai Gilgeous-Alexander");
    await waitFor(
      () =>
        evaluate(
          second,
          `return fetch('/api/rooms/${id}').then(response=>response.json()).then(state=>state.queue.length);`,
        ) === 1,
      "second queue",
    );
    click(first, "Players");
    fill(first, "Search players", "");
    shot(first, "live-desktop");
    usableList(first);
    overflow(first);
    select(first, "Position", "PG");
    select(
      first,
      "NBA team",
      source.players.find(
        (player: { name: string; team: string }) =>
          player.name === "Trae Young",
      ).team,
    );
    await waitFor(
      () =>
        evaluate(
          first,
          "return [...document.querySelectorAll('.players-panel tbody .player-name strong')].map(element=>element.innerText).includes('Trae Young');",
        ),
      "actual filtered player result",
    );
    select(first, "NBA team", "");
    select(first, "Position", "");
    click(first, /PTS ↓/);
    select(first, "Stats", "total");
    select(first, "Stats", "game");
    await searchPlayer(first, "Luka Doncic");
    click(first, "Player details");
    shot(first, "player-detail-desktop");
    click(first, "Close details");
    await draft(first, "Luka Doncic", 1, state);
    click(first, "Undo latest");
    click(first, "Confirm undo");
    await waitFor(
      () => state().picks.length === 0 && state().phase === "paused",
      "undo",
    );
    click(first, "Resume");
    await draft(first, "Luka Doncic", 1, state);
    await draft(second, "Shai Gilgeous-Alexander", 2, state);
    await draft(second, "Victor Wembanyama", 3, state);
    await draft(first, "Trae Young", 4, state);
    click(first, "Roster");
    select(first, "View team", "1");
    assert.ok(snapshot(first).includes("Victor Wembanyama"));
    click(first, "My team");
    const myRoster = evaluate(
      first,
      "return [...document.querySelectorAll('.roster-list li')].map(element=>element.innerText);",
    );
    assert.ok(
      myRoster.some(
        (row: string) => row.startsWith("G\n") && row.includes("Luka Doncic"),
      ),
    );
    click(first, "Players");
    fill(first, "Search players", "Nikola Jokic");
    click(first, "Board");
    shot(first, "board-desktop");
    click(first, "Players");
    assert.equal(
      evaluate(
        first,
        "return document.querySelector('input[type=search]').value;",
      ),
      "Nikola Jokic",
    );
    fill(first, "Search players", "");
    cli(first, ["set", "viewport", "900", "800"]);
    shot(first, "live-intermediate");
    usableList(first);
    overflow(first);
    cli(first, ["set", "viewport", "1440", "1000"]);
    click(second, "Players");
    fill(second, "Search players", "");
    shot(second, "live-phone");
    usableList(second);
    click(second, "Select Giannis Antetokounmpo");
    cli(second, ["scroll", "up", "1000", "--selector", ".table-scroll"]);
    shot(second, "selected-phone");
    usableList(second);
    overflow(second);
    click(second, /Queue \(/);
    shot(second, "queue-phone");
    click(second, "Roster");
    shot(second, "roster-phone");
    click(second, "Board");
    shot(second, "board-phone");
    overflow(second);
    cli(second, ["set", "offline", "on"]);
    await pause(3000);
    assert.ok(snapshot(second).includes("Disconnected"));
    shot(second, "offline-phone");
    cli(second, ["set", "offline", "off"]);
    await waitFor(() => snapshot(second).includes("Connected"), "reconnected");
    cli(recovered, ["open", url]);
    cli(recovered, ["set", "viewport", "390", "844"]);
    await waitFor(
      () => snapshot(recovered).includes("Recover your team"),
      "recovery page",
    );
    cli(recovered, ["scrollintoview", ".recovery-panel summary"]);
    cli(recovered, ["click", ".recovery-panel summary"]);
    fill(recovered, "Recovery code", recovery, "textbox", true);
    click(recovered, "Recover team");
    await waitFor(
      () =>
        evaluate(
          recovered,
          `return fetch('/api/rooms/${id}').then(response=>response.json()).then(state=>state.me?.slot);`,
        ) === 1,
      "cross device recovery",
    );
    click(recovered, "Players");
    shot(recovered, "live-phone-wide");
    usableList(recovered);
    cli(second, ["reload"]);
    await waitFor(
      () => snapshot(second).includes("My needs"),
      "ownership refresh",
    );
    click(first, "Pick for on-clock team", "checkbox");
    await draft(first, "Jalen Brunson", 5, state);
    click(first, "Pick for on-clock team", "checkbox");
    await draft(first, "Nikola Jokic", 6, state);
    const finalState = state();
    assert.equal(finalState.phase, "complete");
    assert.deepEqual(
      finalState.picks.map((pick: { slot: number }) => pick.slot),
      [0, 1, 1, 0, 1, 0],
    );
    assert.equal(finalState.picks[4].source, "commissioner");
    click(first, "Board");
    shot(first, "complete-desktop");
    click(second, "Board");
    shot(second, "complete-phone");
    click(first, "Players");
    fill(first, "Search players", "");
    cli(first, ["scroll", "down", "480", "--selector", ".table-scroll"]);
    cli(first, ["scroll", "right", "100", "--selector", ".table-scroll"]);
    const savedScroll = evaluate(
      first,
      "return {top:document.querySelector('.table-scroll').scrollTop,left:document.querySelector('.table-scroll').scrollLeft};",
    );
    assert.ok(savedScroll.top > 0);
    click(first, "Board");
    click(first, "Players");
    assert.deepEqual(
      evaluate(
        first,
        "return {top:document.querySelector('.table-scroll').scrollTop,left:document.querySelector('.table-scroll').scrollLeft};",
      ),
      savedScroll,
    );
    fill(first, "Search players", "Giannis Antetokounmpo");
    click(first, "Select Giannis Antetokounmpo");
    click(first, "Roster");
    click(first, "Players");
    assert.equal(
      evaluate(
        first,
        "return document.querySelector('input[type=search]').value;",
      ),
      "Giannis Antetokounmpo",
    );
    assert.ok(snapshot(first).includes("Draft Giannis Antetokounmpo"));
    for (const kind of ["order", "picks", "rosters"]) {
      cli(first, [
        "scrollintoview",
        element(first, "link", `Export ${kind} CSV`),
      ]);
      cli(first, [
        "download",
        element(first, "link", `Export ${kind} CSV`),
        `${evidence}/${kind}.csv`,
      ]);
    }
    evaluate(
      first,
      "window.scrollTo(0, document.documentElement.scrollHeight); return true;",
    );
    const footer = evaluate(
      first,
      "return {bottom:document.querySelector('.data-footer').getBoundingClientRect().bottom,tray:document.querySelector('.selection-tray').getBoundingClientRect().top};",
    );
    assert.ok(
      footer.bottom <= footer.tray,
      `Footer overlaps action bar: ${JSON.stringify(footer)}`,
    );
    for (const session of sessions) {
      assert.deepEqual(cli(session, ["errors"]).errors ?? [], []);
      assert.deepEqual(cli(session, ["console"]).messages ?? [], []);
      overflow(session);
    }
    writeFileSync(
      `${evidence}/browser-results.json`,
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          origin,
          id,
          picks: finalState.picks,
          preservedListScroll: savedScroll,
          selectionPreservedAcrossViews: true,
          viewports: ["1440x1000", "900x800", "320x568", "390x844"],
          result: "PASS",
          screenshotInspection:
            process.env.CAPTURE_TRANSPORT === "none"
              ? "UNPROVEN: screenshots unavailable; see capture-unavailable.jsonl"
              : "Open images separately before claiming visual proof",
        },
        null,
        2,
      ),
    );
    console.log(
      process.env.CAPTURE_TRANSPORT === "none"
        ? "Complete multi-manager functional acceptance passed. Screenshots are unavailable."
        : "Complete multi-manager UI acceptance passed. Screenshots require visual inspection.",
    );
  } finally {
    for (const session of sessions) {
      try {
        cli(session, ["close"]);
      } catch {}
    }
    writeFileSync(
      `${evidence}/browser-sessions-after.txt`,
      execFileSync("agent-browser", ["session", "list"], { encoding: "utf8" }),
    );
  }
}
export {
  cli,
  click,
  fill,
  select,
  waitFor,
  evaluate,
  shot,
  snapshot,
  overflow,
  usableList,
};
if (process.argv[1]?.endsWith("browser-acceptance.ts"))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
