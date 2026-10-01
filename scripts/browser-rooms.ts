// Two rooms in one browser: create, join, leave, rejoin, and switch, plus keyboard,
// accessible names, validation errors, and scroll retention.
import assert from "node:assert/strict";
import { pickOrder } from "../lib/rules";
import {
  api,
  cli,
  click,
  dimensions,
  errors,
  evaluate,
  fill,
  find,
  origin,
  record,
  shot,
  text,
  viewport,
  waitFor,
} from "./browser/lib";

const tag = process.env.RUN_TAG ?? "rooms";
const prefix = process.env.SESSION_PREFIX ?? "nba-t167-r";
const roomPrefix = process.env.ROOM_PREFIX ?? "t_167eb983";
const [P, Q] = [`${prefix}-p`, `${prefix}-q`];
const sizes: Record<string, [number, number]> = {
  [P]: [390, 844],
  [Q]: [1440, 900],
};
const label: Record<string, string> = { [P]: "mobile", [Q]: "desktop" };
// Close this run's sessions on every exit path.
process.on("exit", () => {
  for (const session of [P, Q])
    try {
      cli(session, ["close"]);
    } catch {}
});
const step = (session: string, screen: string) => {
  dimensions(session, `${label[session]}-${screen}`);
  unnamedControls(session, screen);
  shot(session, `${tag}-${label[session]}-${screen}`);
};
const url = (session: string) => cli(session, ["get", "url"]).url as string;
const idOf = (session: string) => url(session).split("/room/")[1];
const state = (session: string) => api(session, idOf(session));
const title = (session: string) =>
  evaluate(
    session,
    "return document.querySelector('.topbar .title strong')?.textContent ?? ''",
  ) as string;
function menu(session: string, openIt: boolean) {
  const isOpen = evaluate(
    session,
    "return document.querySelector('.menu').open",
  );
  if (isOpen !== openIt) cli(session, ["click", ".menu summary"]);
}
function tab(session: string, name: string) {
  cli(session, [
    "click",
    find(session, "button", new RegExp(`^${name}( \\d+)?$`))!,
  ]);
}
function alertText(session: string) {
  return evaluate(
    session,
    "return [...document.querySelectorAll('[role=alert]')].map((a) => a.textContent).join(' | ')",
  ) as string;
}
// Every visible control must have a readable name, not just a glyph.
function unnamedControls(session: string, screen: string) {
  const unnamed = evaluate(
    session,
    `return [...document.querySelectorAll('button, a, summary, input, select')]
      .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('details:not([open]) > :not(summary)'))
      .map((el) => {
        const labelled = el.getAttribute('aria-label') || [...(el.labels ?? [])].map((l) => l.textContent).join(' ') || el.getAttribute('placeholder') || el.textContent;
        return { tag: el.tagName, text: el.textContent.trim().slice(0, 20), name: (labelled ?? '').trim() };
      })
      .filter((c) => !/[A-Za-z0-9]/.test(c.name));`,
  );
  record({ kind: "accessible-names", session, screen, unnamed });
  assert.equal(
    unnamed.length,
    0,
    `${screen} unnamed: ${JSON.stringify(unnamed)}`,
  );
}
function createRoom(
  session: string,
  name: string,
  teams: string,
  seconds = "60",
) {
  fill(session, "Room name", name);
  fill(session, "Your name", "Pia");
  fill(session, "Teams", teams, "spinbutton");
  fill(session, "Seconds/pick", seconds, "spinbutton");
  click(session, "Create room");
  waitFor(
    session,
    `${name} created`,
    () => /\/room\//.test(url(session)),
    30000,
  );
  waitFor(session, `${name} lobby`, () => /ready/.test(text(session)), 30000);
  return idOf(session);
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
function queueNth(session: string, index: number) {
  tab(session, "Players");
  const name: string = evaluate(
    session,
    `return [...document.querySelectorAll('.player-table tbody button.item')][${index}].getAttribute('aria-label').replace(/^Select /, '')`,
  );
  click(session, `Queue ${name}`);
  waitFor(session, `queued ${name}`, () => state(session).queue.length > 0);
  return state(session).queue as number[];
}
function switchTo(session: string, roomName: string) {
  menu(session, true);
  const link = find(session, "link", new RegExp(`^${roomName} · `))!;
  cli(session, ["click", link]);
  waitFor(session, `in ${roomName}`, () => title(session) === roomName, 30000);
}

// --- Validation errors on the home page (phone) ------------------------------
viewport(P, ...sizes[P]);
cli(P, ["open", origin]);
click(P, "Open");
waitFor(P, "join error", () =>
  /Paste an invite link or room ID/.test(alertText(P)),
);
fill(P, "Invite link or room ID", "not-a-room");
click(P, "Open");
assert.match(alertText(P), /Paste an invite link or room ID/);
assert.equal(new URL(url(P)).pathname, "/");
step(P, "join-error");
fill(P, "Invite link or room ID", "");
click(P, "Create room");
const required = evaluate(
  P,
  "return document.querySelector('#create-room input:invalid')?.validationMessage ?? ''",
);
assert.ok(required, "empty room name is blocked by the browser");
assert.equal(new URL(url(P)).pathname, "/");
fill(P, "Room name", `${roomPrefix} ${tag} invalid`);
fill(P, "Your name", "Pia");
fill(P, "Teams", "1", "spinbutton");
click(P, "Create room");
const teamsNative = evaluate(
  P,
  "return [...document.querySelectorAll('#create-room input:invalid')].map((i) => i.validationMessage)",
);
assert.equal(new URL(url(P)).pathname, "/");
fill(P, "Teams", "3", "spinbutton");
fill(P, "First-round order (team numbers)", "1,2");
click(P, "Create room");
waitFor(P, "order error", () => /every team once/.test(alertText(P)));
const teamsError = { native: teamsNative, app: alertText(P) };
assert.ok(teamsNative.length > 0);
assert.ok(!/invite/.test(alertText(P)), "stale join error cleared");
assert.equal(new URL(url(P)).pathname, "/");
step(P, "create-error");
record({
  kind: "flow",
  name: "home validation errors",
  ok: true,
  required,
  teamsError,
});

// --- Two rooms, two managers ------------------------------------------------
const nameA = `${roomPrefix} ${tag} A`,
  nameB = `${roomPrefix} ${tag} B`;
cli(P, ["open", origin]);
const roomA = createRoom(P, nameA, "3");
claim(P, 0, "Pia");
const queueA = queueNth(P, 0);
menu(P, true);
cli(P, ["click", find(P, "link", "New or join room")!]);
waitFor(P, "home", () => new URL(url(P)).pathname === "/");
waitFor(
  P,
  "recent A listed",
  () => !!find(P, "link", new RegExp(`^${nameA}`), false),
);
step(P, "home-rooms");
// A long clock keeps room B from auto-picking while the checks run.
const roomB = createRoom(P, nameB, "2", "600");
claim(P, 1, "Pia");
const queueB = queueNth(P, 4);
assert.notDeepEqual(queueA, queueB);

viewport(Q, ...sizes[Q]);
cli(Q, ["open", origin]);
fill(Q, "Invite link or room ID", `${origin}/room/${roomA}`);
click(Q, "Open");
waitFor(Q, "Q in A", () => title(Q) === nameA, 30000);
claim(Q, 1, "Quinn");
menu(Q, true);
cli(Q, ["click", find(Q, "link", "New or join room")!]);
waitFor(Q, "Q home", () => new URL(url(Q)).pathname === "/");
fill(Q, "Invite link or room ID", roomB);
click(Q, "Open");
waitFor(Q, "Q in B", () => title(Q) === nameB, 30000);
claim(Q, 0, "Quinn");
record({ kind: "flow", name: "join two rooms by link and by ID", ok: true });

// Start room B; room A stays in the lobby.
for (const session of [P, Q]) {
  tab(session, "Lobby");
  click(session, "Ready");
}
waitFor(
  P,
  "B all ready",
  () =>
    state(P).members.filter((m: { ready: boolean }) => m.ready).length === 2,
);
click(P, "Start draft");
waitFor(P, "B live", () => state(P).phase === "live");
waitFor(
  Q,
  "Q sees B live",
  () => /Players/.test(text(Q)) && state(Q).phase === "live",
);
step(P, "room-b-live");

// --- Switch, back, forward, reload -------------------------------------------
switchTo(P, nameA);
let a = state(P);
assert.equal(a.me.slot, 0);
assert.deepEqual(a.queue, queueA);
assert.equal(a.phase, "lobby");
step(P, "room-a-after-switch");
cli(P, ["back"]);
waitFor(P, "back to B", () => title(P) === nameB, 30000);
let b = state(P);
assert.equal(b.me.slot, 1);
assert.deepEqual(b.queue, queueB);
assert.equal(b.phase, "live");
cli(P, ["forward"]);
waitFor(P, "forward to A", () => title(P) === nameA, 30000);
cli(P, ["reload"]);
waitFor(P, "reloaded A", () => title(P) === nameA, 30000);
assert.equal(state(P).me.slot, 0);
record({
  kind: "flow",
  name: "switch rooms with menu, back, forward, reload",
  ok: true,
  roomA,
  roomB,
});

// Reconnect inside room A keeps identity.
cli(P, ["set", "offline", "on"]);
waitFor(P, "offline", () => /Offline/.test(text(P)));
cli(P, ["set", "offline", "off"]);
waitFor(P, "online", () => !/Offline/.test(text(P)));
assert.equal(state(P).me.slot, 0);
record({ kind: "flow", name: "reconnect keeps room identity", ok: true });

// Leave room A; room B ownership is untouched. Rejoin A from the home list.
menu(P, true);
click(P, "Leave room…");
click(P, "Leave room");
waitFor(P, "left A", () => state(P).me === null);
switchTo(P, nameB);
b = state(P);
assert.equal(b.me.slot, 1, "leaving A keeps B");
assert.deepEqual(b.queue, queueB);
menu(P, true);
cli(P, ["click", find(P, "link", "New or join room")!]);
waitFor(P, "home again", () => new URL(url(P)).pathname === "/");
const listed = evaluate(
  P,
  "return [...document.querySelectorAll('nav.rooms a')].map((a) => a.innerText.replace(/\\n/g, ' · '))",
);
cli(P, ["click", find(P, "link", new RegExp(`^${nameA}`))!]);
waitFor(P, "A from list", () => title(P) === nameA, 30000);
claim(P, 0, "Pia");
a = state(P);
assert.equal(a.me.slot, 0);
const qa = state(Q);
record({
  kind: "flow",
  name: "leave A, B unaffected, rejoin A from home list",
  ok: true,
  listed,
  queueAfterRejoin: a.queue,
});
assert.equal(qa.me?.slot, 0, "Q still owns team 1 in B");

// Only names are stored client-side; credentials stay in HttpOnly cookies.
const stored = evaluate(P, "return localStorage.getItem('nba_recent_rooms')");
const readableCookies = evaluate(
  P,
  "return document.cookie ? document.cookie.split(';').length : 0",
);
assert.equal(readableCookies, 0);
assert.ok(!/token|recovery|code/i.test(stored));
record({
  kind: "flow",
  name: "no credentials in client storage",
  ok: true,
  stored: JSON.parse(stored),
  readableCookies,
});

// --- Keyboard (desktop, room B live) ------------------------------------------
switchTo(Q, nameA);
cli(Q, ["back"]);
waitFor(Q, "Q back in B", () => title(Q) === nameB, 30000);
evaluate(Q, "document.activeElement?.blur(); return true;");
const stops: { name: string; outline: string }[] = [];
for (let i = 0; i < 14; i++) {
  cli(Q, ["press", "Tab"]);
  stops.push(
    evaluate(
      Q,
      `const el = document.activeElement; return { name: (el.getAttribute('aria-label') || el.textContent).trim().slice(0, 40), outline: getComputedStyle(el).outlineStyle };`,
    ),
  );
}
record({ kind: "keyboard", session: Q, stops });
assert.ok(
  stops.every((s) => s.outline !== "none"),
  "focus is visible",
);
// Open the menu with Enter, close with Escape; focus returns to the menu button.
evaluate(Q, "document.querySelector('.menu summary').focus(); return true;");
cli(Q, ["press", "Enter"]);
assert.equal(evaluate(Q, "return document.querySelector('.menu').open"), true);
step(Q, "keyboard-menu");
cli(Q, ["press", "Escape"]);
assert.equal(evaluate(Q, "return document.querySelector('.menu').open"), false);
assert.equal(
  evaluate(Q, "return document.activeElement.getAttribute('aria-label')"),
  "Room menu",
);
// Change view, select a player, and draft with the keyboard only.
evaluate(
  Q,
  "[...document.querySelectorAll('.tabs button')].find((b) => b.textContent === 'Board').focus(); return true;",
);
cli(Q, ["press", "Enter"]);
assert.match(
  evaluate(Q, "return document.querySelector('.workspace').className"),
  /view-board/,
);
evaluate(
  Q,
  "[...document.querySelectorAll('.tabs button')].find((b) => b.textContent === 'Players').focus(); return true;",
);
cli(Q, ["press", "Enter"]);
const live = state(Q),
  before = live.picks.length;
assert.equal(
  pickOrder(live.settings)[before],
  live.me.slot,
  "Quinn is on the clock",
);
evaluate(
  Q,
  "document.querySelector('.player-table tbody tr:not(.taken) button.item').focus(); return true;",
);
cli(Q, ["press", "Enter"]);
waitFor(Q, "keyboard select", () => !!find(Q, "button", /^Draft .+/, false));
evaluate(Q, "document.querySelector('.draft-button').focus(); return true;");
cli(Q, ["press", "Enter"]);
waitFor(Q, "keyboard pick", () => state(Q).picks.length === before + 1);
record({
  kind: "flow",
  name: "keyboard: menu Enter/Escape, tab view, select, draft",
  ok: true,
});

// --- Scroll and filter context (phone, room B) ---------------------------------
switchTo(P, nameB);
tab(P, "Players");
fill(P, "Search players", "a", "searchbox");
cli(P, ["select", find(P, "combobox", "Position")!, "C"]);
evaluate(
  P,
  "document.querySelector('.players-panel .scroll').scrollTop = 600; return true;",
);
// Select a row that is already in view, as a thumb would.
const visible: string = evaluate(
  P,
  `const r = document.querySelector('.players-panel .scroll').getBoundingClientRect();
   return [...document.querySelectorAll('.player-table tbody button.item')].find((b) => { const t = b.getBoundingClientRect().top; return t > r.top + 60 && t < r.bottom - 60; }).getAttribute('aria-label');`,
);
click(P, visible);
const scrolled = evaluate(
  P,
  "return document.querySelector('.players-panel .scroll').scrollTop",
);
assert.ok(scrolled > 300, "list is scrolled before switching tabs");
tab(P, "Board");
tab(P, "Queue");
tab(P, "Players");
const kept = evaluate(
  P,
  `return { top: document.querySelector('.players-panel .scroll').scrollTop, search: document.querySelector('input[type=search]').value, position: document.querySelector('select[aria-label=Position]').value, selected: document.querySelector('.selection strong').textContent };`,
);
record({
  kind: "flow",
  name: "players scroll, filters, selection kept across tabs",
  ok: kept.top === scrolled && kept.search === "a" && kept.position === "C",
  scrolled,
  kept,
});
assert.equal(kept.top, scrolled);
assert.equal(kept.search, "a");
assert.equal(kept.position, "C");
assert.notEqual(kept.selected, "No player selected");
step(P, "players-context");

// --- Lobby settings on a phone: reach, change, and save the last field ----------
switchTo(P, nameA);
tab(P, "Lobby");
// Pia is not commissioner after leaving A; use room A only if she is, otherwise create C.
let settingsRoom = nameA;
if (!state(P).me.commissioner) {
  menu(P, true);
  cli(P, ["click", find(P, "link", "New or join room")!]);
  waitFor(P, "home for C", () => new URL(url(P)).pathname === "/");
  settingsRoom = `${roomPrefix} ${tag} C`;
  createRoom(P, settingsRoom, "2");
}
click(P, "League settings");
fill(P, "First-round order (team numbers)", "1,1");
click(P, "Save");
waitFor(P, "order error", () => alertText(P).length > 0);
const orderError = alertText(P);
step(P, "settings-error");
fill(
  P,
  "First-round order (team numbers)",
  state(P)
    .settings.order.map((s: number) => s + 1)
    .join(","),
);
const last = find(P, "spinbutton", "GP")!;
cli(P, ["scrollintoview", last]);
const reach = evaluate(
  P,
  `const s = document.querySelector('.sheet .scroll'), r = s.getBoundingClientRect();
   const input = [...s.querySelectorAll('label')].find((l) => l.textContent === 'GP').querySelector('input').getBoundingClientRect();
   const bar = document.querySelector('.actionbar').getBoundingClientRect();
   return { last: [...s.querySelectorAll('label')].at(-1).textContent, scrollTop: s.scrollTop, maxScroll: s.scrollHeight - s.clientHeight, region: [r.top, r.bottom], input: [input.top, input.bottom], footerTop: bar.top };`,
);
record({ kind: "settings-reach", session: P, reach });
assert.equal(reach.last, "GP", "GP is the final settings field");
assert.ok(
  reach.input[1] <= reach.region[1] && reach.region[1] <= reach.footerTop,
  "last field (GP) fully above footer",
);
step(P, "settings-bottom");
fill(P, "GP", "0.5", "spinbutton");
click(P, "Save");
waitFor(P, "GP saved", () => state(P).settings.weights.GP === 0.5);
record({
  kind: "flow",
  name: "phone settings: invalid order error, last field reached and saved",
  ok: true,
  settingsRoom,
  orderError,
});

for (const session of [P, Q]) {
  const { pageErrors } = errors(session, "end");
  assert.equal(pageErrors.errors.length, 0);
}
console.log(JSON.stringify({ done: true, roomA, roomB }));
