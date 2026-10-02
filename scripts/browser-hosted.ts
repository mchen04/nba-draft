// Bounded hosted check on one controlled room: create, pick, reload, second client,
// offline reconnect, and recovery on a third device. Three picks, then the room is paused.
import assert from "node:assert/strict";
import {
  api,
  cli,
  click,
  errors,
  evaluate,
  fill,
  find,
  origin,
  record,
  save,
  shot,
  text,
  viewport,
  waitFor,
} from "./browser/lib";

const tag = process.env.RUN_TAG ?? "hosted";
const prefix = process.env.SESSION_PREFIX ?? "nba-hosted";
const roomPrefix = process.env.ROOM_PREFIX ?? "t_f192cccc";
const [H1, H2, H3] = ["one", "two", "three"].map((name) => `${prefix}-${name}`);
const sizes: Record<string, [number, number]> = {
  [H1]: [1440, 900],
  [H2]: [390, 844],
  [H3]: [820, 1180],
};
process.on("exit", () => {
  for (const session of [H1, H2, H3])
    try {
      cli(session, ["close"]);
    } catch {}
});
let roomUrl = "",
  roomId = "";
const state = (session: string) => api(session, roomId);
function open(session: string, url: string) {
  viewport(session, ...sizes[session]);
  cli(session, ["open", url]);
}
function menu(session: string, openIt: boolean) {
  const isOpen = evaluate(
    session,
    "return document.querySelector('.menu').open",
  );
  if (isOpen !== openIt) cli(session, ["click", ".menu summary"]);
}
// Narrow layouts show one panel at a time behind tabs.
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
function claim(session: string, slot: number, name: string) {
  click(session, `Claim team ${slot + 1}`);
  fill(session, "Manager name", name);
  click(session, `Join team ${slot + 1}`);
  waitFor(
    session,
    `${name} owns ${slot + 1}`,
    () => state(session).me?.slot === slot,
  );
}
// Drafts the first available player the page lists, then waits for the saved pick.
function draft(session: string) {
  tab(session, "Players");
  const before = state(session).picks.length;
  waitFor(session, `page shows pick ${before + 1}`, () =>
    evaluate(
      session,
      `return !!document.querySelector('.pick-strip button.current')?.getAttribute('aria-label').startsWith('Pick ${before + 1},')`,
    ),
  );
  const name: string = evaluate(
    session,
    "return document.querySelector('.player-table tbody tr:not(.taken) button.item').getAttribute('aria-label').replace(/^Select /, '')",
  );
  click(session, `Select ${name}`);
  click(session, `Draft ${name}`);
  waitFor(
    session,
    `pick ${before + 1} saved`,
    () => state(session).picks.length === before + 1,
  );
  return name;
}
// The page itself must show every drafted name, not just the API.
function shows(session: string, names: string[], label: string) {
  waitFor(
    session,
    `${label} shows ${names.join(", ")}`,
    () => {
      const visible = text(session);
      return names.every((name) => visible.includes(name));
    },
    30000,
  );
  record({ kind: "visible", session, label, names });
  shot(session, `${tag}-${label}`);
}

// Create on desktop and claim team 1.
open(H1, origin);
fill(
  H1,
  "Room name",
  `${roomPrefix} ${tag} ${new Date().toISOString().slice(0, 16)}`,
);
fill(H1, "Your name", "Hana");
fill(H1, "Teams", "2", "spinbutton");
fill(H1, "Seconds/pick", "600", "spinbutton");
click(H1, "Create room");
waitFor(
  H1,
  "room url",
  () => /\/room\//.test(cli(H1, ["get", "url"]).url),
  30000,
);
roomUrl = cli(H1, ["get", "url"]).url;
roomId = roomUrl.split("/room/")[1];
record({ kind: "room", roomId, tag });
waitFor(H1, "lobby", () => /ready/.test(text(H1)), 30000);
claim(H1, 0, "Hana");
// Second client on a phone claims team 2.
open(H2, roomUrl);
waitFor(H2, "second client lobby", () => /ready/.test(text(H2)), 30000);
claim(H2, 1, "Ivo");
for (const session of [H1, H2]) {
  tab(session, "Lobby");
  click(session, "Ready");
}
waitFor(
  H1,
  "both ready",
  () =>
    state(H1).members.filter((m: { ready: boolean }) => m.ready).length === 2,
);
click(H1, "Start draft");
waitFor(H1, "live", () => state(H1).phase === "live");
const dataset = state(H1).catalog.dataset;
record({ kind: "flow", name: "create, claim, start", ok: true, dataset });

// Pick 1 on desktop, then reload: the saved pick is still on the page.
const first = draft(H1);
shows(H1, [first], "desktop-pick-1");
cli(H1, ["reload"]);
shows(H1, [first], "desktop-after-reload");
record({ kind: "flow", name: "pick saves and survives reload", ok: true });

// The second client sees pick 1, goes offline, reconnects, and drafts pick 2.
shows(H2, [first], "phone-sees-pick-1");
cli(H2, ["set", "offline", "on"]);
waitFor(H2, "offline banner", () => /Offline/.test(text(H2)), 20000);
cli(H2, ["set", "offline", "off"]);
waitFor(H2, "back online", () => !/Offline/.test(text(H2)), 20000);
const second = draft(H2);
shows(H1, [first, second], "desktop-sees-pick-2");
record({ kind: "flow", name: "second client and reconnect", ok: true });

// Team 2 recovers on a third device and drafts pick 3 (3RR round 2 starts with team 2).
menu(H2, true);
click(H2, "Show");
const code = evaluate(
  H2,
  "return document.querySelector('.code-row code').textContent",
  true,
);
menu(H2, false);
open(H3, roomUrl);
waitFor(H3, "third device loaded", () => /Players/.test(text(H3)), 30000);
menu(H3, true);
fill(H3, "Recovery code", code, "textbox", true);
click(H3, "Recover team");
waitFor(H3, "recovered team 2", () => state(H3).me?.slot === 1);
menu(H3, false);
const third = draft(H3);
for (const [session, label] of [
  [H1, "desktop-final"],
  [H2, "phone-final"],
  [H3, "tablet-final"],
])
  shows(session, [first, second, third], label);
record({ kind: "flow", name: "recovery on a third device", ok: true });

// Pause so the controlled room stops its clock, then record the saved state.
click(H1, "Pause");
waitFor(H1, "paused", () => state(H1).phase === "paused");
const final = state(H1);
assert.equal(final.picks.length, 3);
assert.deepEqual(
  final.picks.map((pick: { slot: number }) => pick.slot),
  [0, 1, 1],
);
for (const session of [H1, H2, H3]) errors(session, "end");
save(`${tag}-final-room.json`, {
  roomId,
  roomUrl,
  dataset,
  phase: final.phase,
  picks: final.picks.map(
    (pick: {
      index: number;
      slot: number;
      playerId: number;
      source: string;
    }) => ({
      index: pick.index,
      slot: pick.slot,
      playerId: pick.playerId,
      source: pick.source,
    }),
  ),
  names: [first, second, third],
});
record({ done: true, roomId, picks: [first, second, third] });
