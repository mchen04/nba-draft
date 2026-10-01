import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import {
  cli,
  click,
  fill,
  evaluate,
  waitFor,
  snapshot,
  shot,
} from "./browser-acceptance";

const origin = process.argv[2],
  evidence = process.argv[3];
const sessions = ["nba-fix-edge-a", "nba-fix-edge-b", "nba-fix-edge-c"];

async function main() {
  const [owner, manager, otherOwner] = sessions;
  try {
    cli(owner, ["open", origin]);
    cli(owner, ["set", "viewport", "1440", "1000"]);
    fill(owner, "Room name", "t_d4c47e94 Edge regression");
    fill(owner, "Commissioner name", "Edge A");
    fill(owner, "Teams", "2", "spinbutton");
    fill(owner, "Seconds per pick", "600", "spinbutton");
    for (const slot of ["PG", "SG", "SF", "PF", "C", "G", "F", "BN"])
      fill(owner, slot, "0", "spinbutton");
    fill(owner, "UTIL", "3", "spinbutton");
    evaluate(
      owner,
      `
      window.createPosts = 0;
      const original = window.fetch.bind(window);
      window.fetch = (url, options) => {
        if (url === '/api/rooms' && options?.method === 'POST') window.createPosts++;
        return original(url, options);
      }; return true;
    `,
    );
    fill(owner, "Draft order (team numbers, separated by commas)", "1,1");
    cli(owner, ["press", "Enter"]);
    await waitFor(
      () =>
        snapshot(owner).includes("Draft order must contain every team once."),
      "Enter validates current invalid text",
    );
    assert.equal(evaluate(owner, "return window.createPosts;"), 0);
    fill(owner, "Draft order (team numbers, separated by commas)", "2,1");
    cli(owner, ["press", "Enter"]);
    await waitFor(
      () => evaluate(owner, "return location.pathname.startsWith('/room/');"),
      "Enter creates actual reversed-order room",
    );
    const url = evaluate(owner, "return location.href;"),
      id = url.split("/").at(-1);
    const state = () =>
      evaluate(
        owner,
        `return fetch('/api/rooms/${id}').then(response => response.json());`,
      );
    await waitFor(() => snapshot(owner).includes("Draft lobby"), "lobby");
    assert.deepEqual(state().settings.order, [1, 0]);
    const recovery = evaluate(
      owner,
      `return sessionStorage.getItem('recovery_${id}');`,
      true,
    );
    click(owner, "League settings");
    fill(owner, "Draft order (team numbers, separated by commas)", "1,2");
    click(owner, "Save league settings");
    await waitFor(
      () => state().settings.order[0] === 0,
      "lobby order saves current text",
    );
    fill(owner, "Manager name", "Edge A");
    click(owner, "Claim team 1");
    await waitFor(
      () => snapshot(owner).includes("Ready to draft"),
      "owner claim",
    );
    click(owner, "Ready to draft");

    cli(manager, ["open", url]);
    cli(manager, ["set", "viewport", "320", "568"]);
    await waitFor(
      () => snapshot(manager).includes("Draft lobby"),
      "anonymous lobby",
    );
    evaluate(
      manager,
      `
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if (options?.method === 'POST' && JSON.parse(options.body).type === 'claim') {
          // Ignore cookies and discard the complete successful server response.
          await original(url, { ...options, credentials: 'omit' });
          throw new TypeError('Task-scoped complete response loss');
        }
        return original(url, options);
      }; return true;
    `,
    );
    click(manager, /Team 2.*Open slot/);
    fill(manager, "Manager name", "Edge B");
    click(manager, "Claim team 2");
    await waitFor(
      () => snapshot(manager).includes("Retry saved request"),
      "lost claim retry",
    );
    assert.equal(
      evaluate(
        manager,
        `return fetch('/api/rooms/${id}').then(response => response.json()).then(view => view.me);`,
      ),
      null,
    );
    assert.equal(
      state().members.filter((member: { slot: number }) => member.slot === 1)
        .length,
      1,
    );
    cli(manager, ["reload"]);
    await waitFor(
      () =>
        snapshot(manager).includes("Retry saved request") &&
        snapshot(manager).includes("Connected"),
      "private claim retry survives reload",
    );
    cli(manager, ["set", "viewport", "1440", "1000"]);
    shot(manager, "claim-retry-desktop");
    cli(manager, ["set", "viewport", "320", "568"]);
    shot(manager, "claim-retry-phone");
    click(manager, "Retry saved request");
    await waitFor(
      () => snapshot(manager).includes("Ready to draft"),
      "retry restores ownership",
    );
    assert.equal(
      evaluate(
        manager,
        `return !!sessionStorage.getItem('recovery_${id}') && !sessionStorage.getItem('claim_retry_${id}');`,
      ),
      true,
    );
    click(manager, "Ready to draft");
    await waitFor(
      () =>
        state().members.filter((member: { ready: boolean }) => member.ready)
          .length === 2,
      "both ready",
    );
    click(owner, "Start draft");
    await waitFor(() => state().phase === "live", "live");
    fill(owner, "Search players", "Luka Doncic");
    click(owner, "Select Luka Doncic");
    click(owner, "Draft Luka Doncic");
    await waitFor(() => state().picks.length === 1, "first pick");
    click(owner, "Undo latest");

    cli(otherOwner, ["open", url]);
    await waitFor(
      () => snapshot(otherOwner).includes("Recover your team"),
      "other commissioner device",
    );
    cli(otherOwner, ["scrollintoview", ".recovery-panel summary"]);
    cli(otherOwner, ["click", ".recovery-panel summary"]);
    fill(otherOwner, "Recovery code", recovery, "textbox", true);
    click(otherOwner, "Recover team");
    await waitFor(
      () => snapshot(otherOwner).includes("Undo latest"),
      "commissioner recovered",
    );
    click(otherOwner, "Undo latest");
    click(otherOwner, "Confirm undo");
    await waitFor(
      () => state().picks.length === 0,
      "second device undoes original",
    );
    click(otherOwner, "Resume");
    fill(otherOwner, "Search players", "Giannis Antetokounmpo");
    click(otherOwner, "Select Giannis Antetokounmpo");
    click(otherOwner, "Draft Giannis Antetokounmpo");
    await waitFor(() => state().picks.length === 1, "replacement same count");
    await waitFor(
      () => snapshot(owner).includes("Giannis Antetokounmpo"),
      "first device receives replacement",
    );
    assert.equal(
      evaluate(
        owner,
        "return [...document.querySelectorAll('.banner.warning')].some(element => element.textContent.includes('Undo Luka Doncic (pick 1)?'));",
      ),
      true,
    );
    click(owner, "Confirm undo");
    await waitFor(
      () => snapshot(owner).includes("Latest pick changed. Review it again."),
      "stale displayed confirmation rejects",
    );
    assert.equal(state().picks.length, 1);
    for (const session of sessions)
      assert.deepEqual(cli(session, ["errors"]).errors ?? [], []);
    writeFileSync(
      `${evidence}/edge-results.json`,
      JSON.stringify(
        {
          result: "PASS",
          room: id,
          checks: [
            "Enter rejects visible invalid order before POST",
            "Enter persists visible reversed order",
            "lobby saves edited order",
            "complete claim response loss preserves occupied slot",
            "no ownership cookie arrives",
            "private retry survives reload",
            "retry restores cookie and recovery code",
            "displayed undo stays bound to original player",
            "same-count replacement remains after stale confirmation",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    for (const session of sessions) {
      try {
        cli(session, ["close"]);
      } catch {}
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
