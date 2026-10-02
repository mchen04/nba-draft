import assert from "node:assert/strict";
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
  save,
  shot,
  text,
  viewport,
  waitFor,
} from "./browser/lib";

const prefix = process.env.SESSION_PREFIX ?? "nba-avatar-queue";
const [A, B, V] = ["a", "b", "viewer"].map((name) => `${prefix}-${name}`);
let roomId = "";
const state = (session: string) => api(session, roomId);
const renderedCount = (session: string) =>
  evaluate(
    session,
    "return Number(document.querySelector('.recent-panel .panel-bar span')?.textContent.split(' ')[0])",
  );
const feed = (session: string) =>
  evaluate(
    session,
    "return [...document.querySelectorAll('.recent-list button')].map(b => b.getAttribute('aria-label'))",
  ) as string[];
const action = (session: string, name: string, mode: string) => {
  waitFor(
    session,
    `${mode} ${name} rendered`,
    () => !!find(session, "button", `${mode} ${name}`, false),
  );
  click(session, `${mode} ${name}`);
};
function tab(session: string, name: string) {
  const ref = find(session, "button", new RegExp(`^${name}( \\d+)?$`), false);
  if (ref) cli(session, ["click", ref]);
}
function capture(session: string, name: string) {
  dimensions(session, name);
  shot(session, name);
}
function receipt(session: string) {
  const room = state(session);
  return {
    id: room.id,
    phase: room.phase,
    version: room.version,
    me: room.me,
    picks: room.picks,
    queue: room.queue,
    dataset: room.catalog.dataset,
    digest: room.catalog.digest,
    visibleFeed: feed(session),
  };
}
try {
  cli(A, ["open", origin]);
  viewport(A, 1440, 900);
  fill(A, "Room name", `t_a6e2a463 avatar queue ${Date.now()}`);
  fill(A, "Your name", "Manager A");
  fill(A, "Teams", "2", "spinbutton");
  fill(A, "Seconds/pick", "600", "spinbutton");
  click(A, "Create room");
  waitFor(
    A,
    "room opens",
    () => /\/room\//.test(cli(A, ["get", "url"]).url),
    30000,
  );
  const url = cli(A, ["get", "url"]).url;
  roomId = url.split("/room/")[1];
  record({ kind: "room", roomId });
  waitFor(A, "lobby", () => !!find(A, "button", "Claim team 1", false), 30000);
  click(A, "Claim team 1");
  fill(A, "Manager name", "Manager A");
  click(A, "Join team 1");
  waitFor(A, "A owns team", () => state(A).me?.slot === 0);
  cli(B, ["open", url]);
  viewport(B, 390, 844);
  waitFor(
    B,
    "B lobby",
    () => !!find(B, "button", "Claim team 2", false),
    30000,
  );
  click(B, "Claim team 2");
  fill(B, "Manager name", "Manager B");
  click(B, "Join team 2");
  waitFor(B, "B owns team", () => state(B).me?.slot === 1);
  for (const session of [A, B]) click(session, "Ready");
  waitFor(A, "both ready", () => /2\/2/.test(text(A)));
  click(A, "Start draft");
  waitFor(A, "draft starts", () => !!find(A, "button", /^Draft /, false));
  tab(B, "Players");
  waitFor(B, "B off-turn queue", () => !!find(B, "button", /^Queue /, false));
  const names: string[] = evaluate(
    A,
    "return [...document.querySelectorAll('.player-table tbody button.item')].slice(0,4).map(b=>b.getAttribute('aria-label').replace('Select ',''))",
  );
  const [first, second, third] = names;
  action(B, second, "Queue");
  waitFor(B, "B queue saved", () => state(B).queue.length === 1);
  assert.equal(state(A).queue.length, 0);
  action(A, first, "Draft");
  for (const session of [A, B])
    waitFor(session, "pick one visible", () => renderedCount(session) === 1);
  assert.equal(
    state(A).picks.length,
    1,
    "direct + DRAFT click saves without selection",
  );
  assert.equal(state(A).queue.length, 0);
  waitFor(
    A,
    "A switched to queue",
    () => !!find(A, "button", `Queue ${third}`, false),
  );
  waitFor(
    B,
    "B queued player becomes draft",
    () => !!find(B, "button", `Draft ${second}`, false),
  );
  action(A, third, "Queue");
  waitFor(A, "A private queue saved", () => state(A).queue.length === 1);
  assert.notDeepEqual(state(A).queue, state(B).queue);
  capture(A, "desktop-off-turn-queue-shared-feed");
  capture(B, "mobile-on-turn-draft");
  action(B, second, "Draft");
  for (const session of [A, B])
    waitFor(session, "pick two visible", () => renderedCount(session) === 2);
  assert.deepEqual(feed(A), feed(B));
  cli(V, ["open", url]);
  viewport(V, 1440, 900);
  waitFor(V, "viewer feed visible", () => renderedCount(V) === 2, 30000);
  assert.equal(state(V).queue.length, 0);
  assert.equal(state(V).me, null);
  assert.deepEqual(feed(V), feed(A));
  capture(V, "viewer-shared-feed-private-queue");
  const halves = evaluate(
    A,
    `const q=document.querySelector('.queue-panel').getBoundingClientRect();
    const r=document.querySelector('.recent-panel').getBoundingClientRect();
    return {queue:q.height,recent:r.height,queueTop:q.top,recentTop:r.top}`,
  );
  assert.ok(Math.abs(halves.queue - halves.recent) <= 1);
  assert.ok(halves.queueTop < halves.recentTop);
  record({ kind: "layout", equalHalves: true, ...halves });
  tab(B, "Queue");
  capture(B, "mobile-queue-above-recent");
  tab(A, "Roster");
  waitFor(A, "roster photo loads", () =>
    evaluate(
      A,
      "return [...document.querySelectorAll('.roster-panel img')].some(i=>i.complete&&i.naturalWidth>0)",
    ),
  );
  assert.equal(
    evaluate(A, "return !!document.querySelector('.totals')"),
    false,
  );
  click(A, new RegExp(`^${first} `));
  waitFor(
    A,
    "roster opens details",
    () => !!find(A, "button", "Close details", false),
  );
  assert.ok(
    !evaluate(
      A,
      "return document.querySelector('.selection').innerText",
    ).includes(first),
  );
  click(A, "Close details");
  capture(A, "desktop-roster-cached-photo");
  tab(A, "Board");
  assert.equal(
    evaluate(A, "return document.querySelectorAll('.board-panel img').length"),
    0,
  );
  assert.ok(text(A).includes(first) && text(A).includes(second));
  capture(A, "desktop-text-only-board-history");
  tab(A, "Players");
  const media = evaluate(
    A,
    `return [...document.querySelectorAll('.player-table img')].filter(i=>i.complete&&i.naturalWidth>0).map(i=>({src:i.getAttribute('src'),width:i.naturalWidth}));`,
  );
  assert.ok(media.length > 0);
  assert.ok(
    media.every((image: { src: string }) =>
      image.src.startsWith("/api/photos/"),
    ),
  );
  const resources = evaluate(
    A,
    "return performance.getEntriesByType('resource').map(r=>({name:r.name,transferSize:r.transferSize})).filter(r=>/photos|catalog|espncdn/.test(r.name))",
  );
  assert.ok(
    resources.every((r: { name: string }) => !r.name.includes("espncdn")),
  );
  save("browser-photo-resources.json", resources);
  // Prove the layout check can reject a visible overflow.
  evaluate(B, "document.body.style.minWidth='1200px'; return true;");
  assert.throws(() => dimensions(B, "negative-overflow-control"));
  evaluate(B, "document.body.style.minWidth=''; return true;");
  dimensions(B, "restored-mobile-layout");
  cli(B, ["set", "offline", "on"]);
  waitFor(B, "offline", () => /Offline/.test(text(B)), 20000);
  assert.equal(
    cli(B, [
      "is",
      "enabled",
      find(B, "button", "Remove " + second + " from queue")!,
    ]).enabled,
    false,
  );
  cli(B, ["set", "offline", "off"]);
  waitFor(B, "reconnected", () => !/Offline/.test(text(B)), 20000);
  cli(A, ["reload"]);
  waitFor(A, "saved history after reload", () => renderedCount(A) === 2, 30000);
  assert.equal(state(A).queue.length, 1);
  // Replay a forbidden off-turn action without recording a cookie or request body.
  const forbidden = evaluate(
    A,
    `const x=new XMLHttpRequest();x.open('POST','/api/rooms/${roomId}',false);x.setRequestHeader('Content-Type','application/json');x.send(JSON.stringify({type:'pick',playerId:${state(A).queue[0]},expectedIndex:2,requestId:crypto.randomUUID()}));return {status:x.status,error:JSON.parse(x.responseText).error};`,
  );
  assert.equal(forbidden.status, 403);
  record({ kind: "authorization", ...forbidden });
  for (const [width, height] of [
    [320, 568],
    [390, 844],
    [820, 1180],
  ]) {
    viewport(B, width, height);
    tab(B, "Players");
    dimensions(B, `players-${width}`);
    click(B, `Select ${third}`);
    cli(B, ["focus", find(B, "button", `Open details for ${third}`)!]);
    cli(B, ["press", "Tab"]);
    assert.equal(
      evaluate(
        B,
        "return document.activeElement.classList.contains('draft-button')",
      ),
      true,
    );
    const labelFits = evaluate(
      B,
      "const s=document.querySelector('.draft-button > span:first-child'); return s.scrollWidth <= s.clientWidth;",
    );
    assert.equal(
      labelFits,
      true,
      "Action label stays readable on a narrow screen",
    );
    tab(B, "Queue");
    capture(B, `queue-feed-${width}`);
    tab(B, "Roster");
    dimensions(B, `roster-${width}`);
    tab(B, "Board");
    dimensions(B, `board-${width}`);
  }
  click(A, "Pause");
  waitFor(A, "paused for handoff", () => state(A).phase === "paused");
  save("browser-two-manager-receipt.json", {
    A: receipt(A),
    B: receipt(B),
    viewer: receipt(V),
    media,
    halves,
  });
  for (const session of [A, B, V]) {
    const result = errors(session, "end");
    assert.equal(result.pageErrors.errors?.length ?? 0, 0);
  }
  record({
    kind: "acceptance",
    ok: true,
    roomId,
    modes: ["Draft", "Queue"],
    privateQueues: true,
    sharedLiveFeed: true,
    historyPreserved: true,
    browser: "Chromium viewport emulation",
  });
} finally {
  if (roomId)
    try {
      if (state(A).phase === "live") click(A, "Pause");
    } catch {}
  for (const session of [A, B, V])
    try {
      cli(session, ["close"]);
    } catch {}
}
