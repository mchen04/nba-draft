import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const mode = process.argv[2],
  origin = process.argv[3] ?? "http://127.0.0.1:3104",
  evidence = resolve(process.argv[4]);
mkdirSync(`${evidence}/screenshots`, { recursive: true });
const sessions = ["nba-t_d4c47e94-offline-a", "nba-t_d4c47e94-offline-b"];
function cli(session: string, args: string[]) {
  const result = JSON.parse(
    execFileSync("agent-browser", ["--session", session, "--json", ...args], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  appendFileSync(
    `${evidence}/offline-commands.jsonl`,
    JSON.stringify({ at: new Date().toISOString(), session, args, result }) +
      "\n",
  );
  assert.equal(result.success, true);
  return result.data;
}
function ref(session: string, role: string, name: string | RegExp) {
  const refs = cli(session, ["snapshot", "-i"]).refs;
  const entry = Object.entries(
    refs as Record<string, { role: string; name: string }>,
  ).find(
    ([, item]) =>
      item.role === role &&
      (typeof name === "string" ? item.name === name : name.test(item.name)),
  );
  assert.ok(entry, `Missing ${role}: ${name}`);
  return `@${entry[0]}`;
}
function click(session: string, name: string | RegExp) {
  cli(session, ["scrollintoview", ref(session, "button", name)]);
  const deadline = Date.now() + 15000;
  while (
    !cli(session, ["is", "enabled", ref(session, "button", name)]).enabled
  ) {
    assert.ok(Date.now() < deadline);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  cli(session, ["click", ref(session, "button", name)]);
}
function fill(session: string, name: string, value: string, role = "textbox") {
  cli(session, ["fill", ref(session, role, name), value]);
}
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 30000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Browser state did not arrive.");
    await wait(300);
  }
}
function evaluate(session: string, source: string) {
  return cli(session, ["eval", `(() => { ${source} })()`]).result;
}
async function main() {
  const [first, second] = sessions;
  try {
    if (mode === "prepare") {
      cli(first, ["open", origin]);
      cli(first, ["set", "viewport", "1440", "1000"]);
      fill(first, "Room name", "t_d4c47e94 offline deadline proof");
      fill(first, "Commissioner name", "Offline A");
      fill(first, "Teams", "2", "spinbutton");
      fill(first, "Seconds per pick", "5", "spinbutton");
      for (const slot of ["PG", "SG", "SF", "PF", "C", "G", "F", "BN"])
        fill(first, slot, "0", "spinbutton");
      fill(first, "UTIL", "1", "spinbutton");
      click(first, "Create draft room");
      await until(() =>
        evaluate(first, "return location.pathname.startsWith('/room/');"),
      );
      const url = evaluate(first, "return location.href;"),
        id = url.split("/").at(-1);
      const state = () =>
        evaluate(first, `return fetch('/api/rooms/${id}').then(response=>response.json());`);
      await until(() => !!state().me);
      fill(first, "Manager name", "Offline A");
      click(first, "Claim team 1");
      await until(() => state().me?.slot === 0);
      click(first, "Ready to draft");
      cli(second, ["open", url]);
      cli(second, ["set", "viewport", "320", "568"]);
      await until(() =>
        cli(second, ["snapshot"]).snapshot.includes("Draft lobby"),
      );
      click(second, /Team 2.*Open slot/);
      fill(second, "Manager name", "Offline B");
      click(second, "Claim team 2");
      await until(
        () =>
          evaluate(
            second,
            `return fetch('/api/rooms/${id}').then(response=>response.json()).then(state=>state.me?.slot);`,
          ) === 1,
      );
      click(second, "Ready to draft");
      for (const [session, name] of [
        [first, "Luka Doncic"],
        [second, "Shai Gilgeous-Alexander"],
      ]) {
        fill(session, "Search players", name, "searchbox");
        click(session, `Queue ${name}`);
        await until(
          () =>
            evaluate(
              session,
              `return fetch('/api/rooms/${id}').then(response=>response.json()).then(state=>state.queue.length);`,
            ) === 1,
        );
      }
      const source = evaluate(
        first,
        `return fetch('/api/rooms/${id}?catalog=1').then(response=>response.json());`,
      );
      const expected = ["Luka Doncic", "Shai Gilgeous-Alexander"].map(
        (name) =>
          source.players.find(
            (player: { name: string; id: number }) => player.name === name,
          ).id,
      );
      click(first, "Start draft");
      await until(() => state().phase === "live");
      const started = state();
      assert.equal(started.picks.length, 0);
      writeFileSync(
        `${evidence}/offline-room.json`,
        JSON.stringify(
          {
            id,
            url,
            deadline: started.deadline,
            expected,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.log(
        "Prepared a five-second room with two real queued players. Close the originating browsers and restart the server before verification.",
      );
    } else if (mode === "verify") {
      const proof = JSON.parse(
        readFileSync(`${evidence}/offline-room.json`, "utf8"),
      );
      assert.ok(Date.now() > proof.deadline + 5000);
      cli(first, ["open", proof.url]);
      cli(first, ["set", "viewport", "320", "568"]);
      await until(() =>
        cli(first, ["snapshot"]).snapshot.includes("Draft complete"),
      );
      const result = evaluate(
        first,
        `return fetch('/api/rooms/${proof.id}').then(response=>response.json());`,
      );
      assert.equal(result.phase, "complete");
      assert.deepEqual(
        result.picks.map((pick: { playerId: number }) => pick.playerId),
        proof.expected,
      );
      assert.deepEqual(
        result.picks.map((pick: { source: string }) => pick.source),
        ["queue", "queue"],
      );
      assert.equal(new Date(result.picks[0].at).getTime(), proof.deadline);
      assert.equal(
        new Date(result.picks[1].at).getTime(),
        proof.deadline + 5000,
      );
      click(first, "Board");
      if (process.env.CAPTURE_TRANSPORT === "none") {
        appendFileSync(
          `${evidence}/capture-unavailable.jsonl`,
          JSON.stringify({
            requestedAt: new Date().toISOString(),
            session: first,
            name: "offline-catchup-phone",
            reason: "Screenshot unavailable. No image or visual pass is claimed.",
          }) + "\n",
        );
      } else
        cli(first, ["screenshot", `${evidence}/screenshots/offline-catchup-phone.png`]);
      assert.deepEqual(cli(first, ["errors"]).errors, []);
      assert.deepEqual(cli(first, ["console"]).messages ?? [], []);
      const dimensions = evaluate(
        first,
        "return {width:innerWidth,scroll:document.documentElement.scrollWidth};",
      );
      assert.ok(dimensions.scroll <= dimensions.width);
      writeFileSync(
        `${evidence}/offline-result.json`,
        JSON.stringify(
          {
            result: "PASS",
            visualCapture: process.env.CAPTURE_TRANSPORT === "none"
              ? "UNPROVEN: extra screenshot unavailable; see capture-unavailable.jsonl"
              : "Captured; inspect the image",
            observedAt: new Date().toISOString(),
            id: proof.id,
            picks: result.picks,
            dimensions,
          },
          null,
          2,
        ),
      );
      console.log(
        "A fresh server and browser catch up both queued picks at their original deadlines.",
      );
    } else throw new Error("Use prepare or verify.");
  } finally {
    for (const session of sessions) {
      try {
        cli(session, ["close"]);
      } catch {}
    }
    writeFileSync(
      `${evidence}/offline-sessions-${mode}.txt`,
      execFileSync("agent-browser", ["session", "list"], { encoding: "utf8" }),
    );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
