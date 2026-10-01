// Complete three-manager draft through real browser sessions on phone, tablet, and desktop viewports.
import assert from "node:assert/strict";
import { pickOrder } from "../lib/rules";
import {
  api,
  cli,
  click,
  evidence,
  dimensions,
  errors,
  evaluate,
  fill,
  find,
  origin,
  record,
  save,
  shot,
  sleep,
  text,
  viewport,
  waitFor,
} from "./browser/lib";

const tag = process.env.RUN_TAG ?? "local";
// Session names are task-scoped so a shared browser daemon never touches other runs.
const prefix = process.env.SESSION_PREFIX ?? "nba-t167";
const [A, B, C, D, E] = ["a", "b", "c", "d", "e"].map(
  (name) => `${prefix}-${name}`,
);
const sizes: Record<string, [number, number]> = {
  [A]: [390, 844],
  [B]: [1440, 900],
  [C]: [820, 1180],
  [D]: [375, 667],
  [E]: [1280, 720],
};
const label: Record<string, string> = {
  [A]: "mobile",
  [B]: "desktop",
  [C]: "tablet",
  [D]: "small",
  [E]: "laptop",
};
// Close this run's sessions on every exit path.
process.on("exit", () => {
  for (const session of [A, B, C, D, E])
    try {
      cli(session, ["close"]);
    } catch {}
});
let roomUrl = "",
  roomId = "";
const step = (session: string, screen: string) => {
  dimensions(session, `${label[session]}-${screen}`);
  shot(session, `${tag}-${label[session]}-${screen}`);
};
function open(session: string, url: string) {
  viewport(session, ...sizes[session]);
  cli(session, ["open", url]);
}
function tab(session: string, name: string) {
  const ref = find(session, "button", new RegExp(`^${name}( \\d+)?$`), false);
  if (
    ref &&
    evaluate(
      session,
      `return getComputedStyle([...document.querySelectorAll('.tabs button')].find(b => b.textContent.startsWith('${name}'))).display !== 'none'`,
    )
  )
    cli(session, ["click", ref]);
}
function menu(session: string, openIt: boolean) {
  const isOpen = evaluate(
    session,
    "return document.querySelector('.menu').open",
  );
  if (isOpen !== openIt) cli(session, ["click", ".menu summary"]);
}
function state(session = A) {
  return api(session, roomId);
}
function waitPicks(count: number, session = A, ms = 20000) {
  waitFor(
    session,
    `picks ${count}`,
    () => state(session).picks.length >= count,
    ms,
  );
}
function draftTop(session: string, filter?: string) {
  tab(session, "Players");
  const before = state(session).picks.length;
  // Read the list only after this page's poll shows the latest pick.
  waitFor(session, `page shows pick ${before + 1}`, () =>
    evaluate(
      session,
      `return !!document.querySelector('.pick-strip button.current')?.getAttribute('aria-label').startsWith('Pick ${before + 1},')`,
    ),
  );
  if (filter) fill(session, "Search players", filter, "searchbox");
  const names: string[] = evaluate(
    session,
    "return [...document.querySelectorAll('.player-table tbody tr:not(.taken) button.item')].slice(0, 25).map((b) => b.getAttribute('aria-label').replace(/^Select /, ''));",
  );
  for (const name of names) {
    // A poll can remove a just-drafted row after the list was read; read it again.
    try {
      click(session, `Select ${name}`);
    } catch {
      sleep(2500);
      return draftTop(session, filter);
    }
    waitFor(
      session,
      `selected ${name}`,
      () => !!find(session, "button", `Draft ${name}`, false),
      5000,
    );
    const draft = find(session, "button", `Draft ${name}`)!;
    sleep(150);
    if (!cli(session, ["is", "enabled", draft]).enabled) continue;
    cli(session, ["click", draft]);
    waitPicks(before + 1, session);
    if (filter) fill(session, "Search players", "", "searchbox");
    return name;
  }
  throw new Error(`No eligible player for ${session}`);
}
function owner(slot: number, ownerOf: Record<number, string>) {
  return ownerOf[slot];
}

// --- Create and lobby -------------------------------------------------------
open(A, origin);
step(A, "create");
fill(A, "Room name", `${process.env.ROOM_PREFIX ?? "t_167eb983"} ${tag} draft`);
fill(A, "Your name", "Ava");
fill(A, "Teams", "3", "spinbutton");
fill(A, "Seconds/pick", "30", "spinbutton");
assert.match(text(A), /Custom rules/);
click(A, "Create room");
waitFor(
  A,
  "room url",
  () => /\/room\//.test(cli(A, ["get", "url"]).url),
  30000,
);
roomUrl = cli(A, ["get", "url"]).url;
roomId = roomUrl.split("/room/")[1];
record({ kind: "room", roomId, tag });
waitFor(A, "lobby", () => /0\/3 ready/.test(text(A)), 30000);
step(A, "lobby");
click(A, "Show code");
const commissionerCode = evaluate(
  A,
  "return document.querySelector('.alert code').textContent",
  true,
);
click(A, "Saved · hide");
click(A, "Claim team 1");
fill(A, "Manager name", "Ava");
click(A, "Join team 1");
waitFor(A, "A claimed", () => state(A).me?.slot === 0);

open(C, roomUrl);
waitFor(C, "C lobby", () => /ready/.test(text(C)), 30000);
click(C, "Claim team 2");
fill(C, "Manager name", "Cy");
click(C, "Join team 2");
waitFor(C, "C claimed 2", () => state(C).me?.slot === 1);
click(C, "Switch to team 3");
click(C, "Move to team 3");
waitFor(C, "C switched to 3", () => state(C).me?.slot === 2);
record({
  kind: "flow",
  name: "switch team",
  ok: true,
  slots: state(C).members,
});

open(B, roomUrl);
waitFor(B, "B lobby", () => /ready/.test(text(B)), 30000);
click(B, "Claim team 2");
fill(B, "Manager name", "Ben");
click(B, "Join team 2");
waitFor(B, "B claimed", () => state(B).me?.slot === 1);
step(B, "lobby");

// C leaves, then rejoins the same team.
menu(C, true);
click(C, "Leave room…");
click(C, "Leave room");
waitFor(C, "C left", () => state(C).me === null);
assert.equal(
  state(A).members.some((m: { slot: number }) => m.slot === 2),
  false,
);
record({ kind: "flow", name: "leave in lobby", ok: true });
click(C, "Claim team 3");
fill(C, "Manager name", "Cy");
click(C, "Join team 3");
waitFor(C, "C rejoined", () => state(C).me?.slot === 2);
record({ kind: "flow", name: "rejoin in lobby", ok: true });
step(C, "lobby");

// Commissioner edits settings in the lobby; ready flags reset.
click(B, "Ready");
waitFor(B, "B ready", () => state(B).me?.ready === true);
click(A, "League settings");
step(A, "settings");
assert.match(text(A), /3RR is this app's default/);
fill(A, "Seconds/pick", "25", "spinbutton");
click(A, "Save");
waitFor(A, "settings saved", () => state(A).settings.seconds === 25);
assert.equal(state(B).me.ready, false, "settings clear ready");
record({ kind: "flow", name: "lobby settings edit clears ready", ok: true });

// Queue building before the draft (phone).
tab(A, "Players");
const queued: string[] = evaluate(
  A,
  "return [...document.querySelectorAll('.player-table tbody button.item')].slice(3, 6).map((b) => b.getAttribute('aria-label').replace(/^Select /, ''));",
);
for (const name of queued) {
  click(A, `Queue ${name}`);
  waitFor(
    A,
    `queued ${name}`,
    () => state(A).queue.length >= queued.indexOf(name) + 1,
  );
}
tab(A, "Queue");
click(A, `Move ${queued[2]} up`);
waitFor(
  A,
  "reordered",
  () =>
    state(A).queue[1] === state(A).queue[1] &&
    evaluate(
      A,
      "return document.querySelector('.queue-list li:nth-child(2) strong').textContent",
    ) === queued[2],
);
click(A, `Remove ${queued[0]} from queue`);
waitFor(A, "removed", () => state(A).queue.length === 2);
step(A, "queue");
record({ kind: "flow", name: "queue add/reorder/remove", ok: true });

// Ben queues two players for a timeout pick.
tab(B, "Players");
const benQueue: string[] = evaluate(
  B,
  "return [...document.querySelectorAll('.player-table tbody button.item')].slice(10, 12).map((b) => b.getAttribute('aria-label').replace(/^Select /, ''));",
);
for (const name of benQueue) {
  click(B, `Queue ${name}`);
  waitFor(
    B,
    `B queued ${name}`,
    () => state(B).queue.length >= benQueue.indexOf(name) + 1,
  );
}

for (const session of [A, B, C]) {
  tab(session, "Lobby");
  click(session, "Ready");
}
waitFor(
  A,
  "all ready",
  () =>
    state(A).members.filter((m: { ready: boolean }) => m.ready).length === 3,
);
click(A, "Start draft");
waitFor(A, "live", () => state(A).phase === "live");
record({
  kind: "flow",
  name: "start without stale-data acknowledgment",
  ok: true,
});
waitFor(C, "C sees live players", () =>
  evaluate(
    C,
    "const p = document.querySelector('.players-panel'); return !!p && getComputedStyle(p).visibility === 'visible';",
  ),
);
record({
  kind: "flow",
  name: "lobby tab falls back to players at start",
  ok: true,
});
const order = pickOrder(state(A).settings);
assert.deepEqual(
  order.slice(0, 12),
  [0, 1, 2, 2, 1, 0, 2, 1, 0, 0, 1, 2],
  "3RR order",
);

// --- Draft -----------------------------------------------------------------
const ownerOf: Record<number, string> = { 0: A, 1: B, 2: C };
// Pick 1: search on the phone.
tab(A, "Players");
fill(A, "Search players", "Jok", "searchbox");
step(A, "players-search");
draftTop(A, "Jok");
step(A, "players-live");
// Pick 2: Ben times out; queue supplies the pick.
const timeoutStart = Date.now();
waitPicks(2, A, 45000);
const second = state(A).picks[1];
record({
  kind: "flow",
  name: "timeout uses queue",
  ok: second.source === "queue",
  source: second.source,
  waitedMs: Date.now() - timeoutStart,
});
assert.equal(second.source, "queue");
// Pick 3: commissioner picks for Cy's team.
cli(A, ["check", find(A, "checkbox", "Pick for team on clock")!]);
draftTop(A);
cli(A, ["uncheck", find(A, "checkbox", "Pick for team on clock")!]);
assert.equal(state(A).picks[2].source, "commissioner");
record({
  kind: "flow",
  name: "commissioner picks for team on clock",
  ok: true,
});
// Pick 4: Cy on the tablet, then Cy leaves mid-draft.
step(C, "live");
draftTop(C);
menu(C, true);
click(C, "Leave room…");
click(C, "Leave room");
waitFor(C, "C left live", () => state(C).me === null);
record({ kind: "flow", name: "leave mid-draft keeps team", ok: true });
// Pick 5: Ben, then Ben recovers on a second device while the commissioner pauses.
draftTop(B);
click(A, "Pause");
waitFor(A, "paused for recovery", () => state(A).phase === "paused");
menu(B, true);
click(B, "Show");
const benCode = evaluate(
  B,
  "return document.querySelector('.code-row code').textContent",
  true,
);
menu(B, false);
open(E, roomUrl);
waitFor(E, "E loaded", () => /Players/.test(text(E)), 30000);
menu(E, true);
fill(E, "Recovery code", benCode, "textbox", true);
click(E, "Recover team");
waitFor(E, "E recovered", () => state(E).me?.slot === 1);
assert.equal(
  state(E).queue.length,
  state(B).queue.length,
  "queue follows recovery",
);
menu(E, false);
record({ kind: "flow", name: "cross-device recovery", ok: true });
step(E, "live");
click(A, "Resume");
waitFor(A, "resumed for A", () => state(A).phase === "live");
// Pick 6: Ava drafts, pauses, resumes, then undoes and redrafts.
draftTop(A);
click(A, "Pause");
waitFor(A, "paused", () => state(A).phase === "paused");
step(A, "paused");
click(A, "Resume");
waitFor(A, "resumed", () => state(A).phase === "live");
click(A, "Undo");
click(A, "Confirm undo");
waitFor(
  A,
  "undone",
  () => state(A).picks.length === 5 && state(A).phase === "paused",
);
click(A, "Resume");
waitFor(A, "resumed after undo", () => state(A).phase === "live");
draftTop(A);
record({ kind: "flow", name: "pause/resume/undo", ok: true });
// Pick 7: team 3 has no owner. Dee claims it on a small phone during a pause.
click(A, "Pause");
waitFor(A, "paused for claim", () => state(A).phase === "paused");
open(D, roomUrl);
waitFor(D, "D loaded", () => /Open team/.test(text(D)), 30000);
step(D, "claim-open-team");
click(D, /^Claim (Team 3|Cy)$/);
fill(D, "Manager name", "Dee");
click(D, "Join team 3");
waitFor(D, "D owns team 3", () => state(D).me?.slot === 2);
ownerOf[2] = D;
record({ kind: "flow", name: "reclaim departed team mid-draft", ok: true });
click(A, "Resume");
waitFor(A, "resumed for D", () => state(A).phase === "live");
draftTop(D);
step(D, "live");
// Pick 8: Ben from the recovered device.
ownerOf[1] = E;
draftTop(E);
// Pick 9: Ava, then hands the commissioner role to Ben.
draftTop(A);
menu(A, true);
step(A, "menu");
cli(A, ["select", find(A, "combobox", "Hand off commissioner")!, "1"]);
waitFor(A, "handed off", () => state(A).me.commissioner === false);
menu(A, false);
waitFor(E, "E commissioner", () => !!find(E, "button", "Pause", false));
record({ kind: "flow", name: "commissioner hand-off", ok: true });
// Offline: draft actions disable; reconnect restores them.
cli(A, ["set", "offline", "on"]);
waitFor(A, "offline banner", () => /Offline/.test(text(A)), 20000);
step(A, "offline");
cli(A, ["set", "offline", "off"]);
waitFor(A, "online", () => !/Offline/.test(text(A)), 20000);
record({ kind: "flow", name: "offline and reconnect", ok: true });

// Remaining picks by whoever is on the clock.
let shots = 0;
while (state(A).phase !== "complete") {
  const room = state(A);
  if (room.phase === "paused") throw new Error(`Paused: ${room.message}`);
  const session = owner(order[room.picks.length], ownerOf);
  draftTop(session);
  if (room.picks.length === 20 && shots++ === 0) {
    tab(A, "Board");
    step(A, "board-mid");
    tab(A, "Roster");
    step(A, "roster-mid");
    step(B, "live-mid");
    step(C, "viewer-mid");
  }
}
const final = state(A);
assert.equal(final.picks.length, 39);
assert.deepEqual(
  final.picks.map((p: { slot: number }) => p.slot),
  order,
);
assert.equal(
  new Set(final.picks.map((p: { playerId: number }) => p.playerId)).size,
  39,
);
record({
  kind: "flow",
  name: "complete draft",
  ok: true,
  picks: final.picks.length,
  sources: final.picks.map((p: { source: string }) => p.source),
});
save(`${tag}-final-room.json`, { ...final, catalog: undefined });

// Completed screens and exports.
for (const session of [A, B, D, E]) {
  tab(session, "Board");
  step(session, "complete-board");
}
tab(A, "Roster");
step(A, "complete-roster");
tab(B, "Players");
click(B, /^Select /);
click(B, /^Open details for /);
step(B, "details");
click(B, "Close details");
menu(A, true);
for (const kind of ["order", "picks", "rosters"]) {
  const ref = find(A, "link", `${kind} CSV`)!;
  cli(A, ["download", ref, `${evidence}/${tag}-${kind}.csv`]);
}
record({ kind: "flow", name: "exports downloaded", ok: true });
for (const session of [A, B, C, D, E]) errors(session, "end");
console.log(
  JSON.stringify({
    done: true,
    roomId,
    commissionerCodeSaved: !!commissionerCode,
  }),
);
