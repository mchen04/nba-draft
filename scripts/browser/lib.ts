import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const configured = process.env.EVIDENCE;
if (!configured)
  throw new Error("Set EVIDENCE to a directory outside the checkout.");
export const evidence: string = configured;
export const origin = process.env.ORIGIN ?? "http://localhost:3167";
mkdirSync(`${evidence}/screenshots`, { recursive: true });
const receipt = `${evidence}/browser-commands.jsonl`;
export const results: Record<string, unknown>[] = [];
export function record(entry: Record<string, unknown>) {
  results.push({ at: new Date().toISOString(), ...entry });
  appendFileSync(
    `${evidence}/browser-results.jsonl`,
    JSON.stringify(results.at(-1)) + "\n",
  );
  console.log(JSON.stringify(results.at(-1)));
}
export const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function cli(session: string, args: string[], secret = false) {
  let output: string;
  try {
    output = execFileSync(
      "agent-browser",
      ["--session", session, "--json", ...args],
      {
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch (error) {
    const message = (error as { stdout?: string }).stdout ?? String(error);
    appendFileSync(
      receipt,
      JSON.stringify({
        at: new Date().toISOString(),
        session,
        args: secret ? [args[0], "<private>"] : args,
        failed: secret ? "<private>" : message.slice(0, 500),
      }) + "\n",
    );
    throw new Error(
      `agent-browser ${args.join(" ")} failed: ${message.slice(0, 300)}`,
    );
  }
  const result = JSON.parse(output);
  appendFileSync(
    receipt,
    JSON.stringify({
      at: new Date().toISOString(),
      session,
      args: secret ? [args[0], "<private>"] : args,
      success: result.success,
      ...(args[0] === "snapshot" || secret ? {} : { data: result.data }),
    }) + "\n",
  );
  if (!result.success) throw new Error(`${args.join(" ")}: ${result.error}`);
  return result.data;
}
type Refs = Record<string, { role: string; name: string }>;
export function refs(session: string): Refs {
  return cli(session, ["snapshot", "-i"]).refs;
}
export function find(
  session: string,
  role: string,
  name: string | RegExp,
  required = true,
) {
  const match = Object.entries(refs(session)).find(
    ([, item]) =>
      item.role === role &&
      (typeof name === "string" ? item.name === name : name.test(item.name)),
  );
  if (!match) {
    if (required) throw new Error(`Missing ${role}: ${name}`);
    return null;
  }
  return `@${match[0]}`;
}
export function waitFor(
  session: string,
  label: string,
  check: () => boolean,
  ms = 20000,
) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    sleep(300);
  }
}
export function click(session: string, name: string | RegExp, role = "button") {
  let ref = find(session, role, name)!;
  cli(session, ["scrollintoview", ref]);
  waitFor(session, `enabled ${name}`, () => {
    ref = find(session, role, name)!;
    return cli(session, ["is", "enabled", ref]).enabled;
  });
  cli(session, ["click", ref]);
}
export function fill(
  session: string,
  name: string,
  text: string,
  role = "textbox",
  secret = false,
) {
  const ref = find(session, role, name)!;
  cli(session, ["focus", ref]);
  evaluate(session, "document.activeElement.select(); return true;");
  if (text === "") cli(session, ["press", "Backspace"]);
  else cli(session, ["keyboard", "inserttext", text], secret);
  const value = cli(
    session,
    ["get", "value", find(session, role, name)!],
    secret,
  ).value;
  if (value !== text)
    throw new Error(`Field ${name} has ${secret ? "<private>" : value}`);
}
export function evaluate(session: string, body: string, secret = false) {
  return cli(session, ["eval", `(() => { ${body} })()`], secret).result;
}
export function text(session: string) {
  return evaluate(session, "return document.body.innerText;") as string;
}
export function viewport(session: string, width: number, height: number) {
  cli(session, ["set", "viewport", String(width), String(height)]);
}
// Document must never scroll; report inner scroll regions too.
export function dimensions(session: string, screen: string) {
  const measured = evaluate(
    session,
    `const d = document.documentElement;
     const before = scrollY;
     window.scrollTo(0, 99999);
     const moved = scrollY;
     window.scrollTo(0, before);
     const regions = [...document.querySelectorAll('.scroll, .pick-strip, .tabs, .menu-panel, .alerts')]
       .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('details:not([open])'))
       .map((el) => ({ region: el.className, clientH: el.clientHeight, scrollH: el.scrollHeight, clientW: el.clientWidth, scrollW: el.scrollWidth }));
     const offscreen = [...document.querySelectorAll('button, a, input, select, summary')]
       .filter((el) => { const r = el.getBoundingClientRect(); return r.width && getComputedStyle(el).visibility !== 'hidden' && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1) && !el.closest('.scroll, .pick-strip, .tabs, .menu-panel, .alerts'); })
       .map((el) => el.textContent.trim().slice(0, 30));
     return { viewport: [innerWidth, innerHeight], document: { scrollH: d.scrollHeight, clientH: d.clientHeight, scrollW: d.scrollWidth, clientW: d.clientWidth, bodyScrollH: document.body.scrollHeight }, windowScrollMoved: moved, regions, offscreen };`,
  );
  const ok =
    measured.document.scrollH <= measured.document.clientH &&
    measured.document.scrollW <= measured.document.clientW &&
    measured.windowScrollMoved === 0 &&
    measured.offscreen.length === 0;
  record({ kind: "dimensions", session, screen, ok, ...measured });
  if (!ok)
    throw new Error(
      `Document scroll or clipped control on ${screen}: ${JSON.stringify(measured)}`,
    );
  return measured;
}
export function shot(session: string, name: string) {
  const path = `${evidence}/screenshots/${name}.png`;
  cli(session, ["screenshot", path]);
  record({ kind: "screenshot", session, path });
  return path;
}
export function errors(session: string, screen: string) {
  const consoleLogs = cli(session, ["console"]);
  const pageErrors = cli(session, ["errors"]);
  record({
    kind: "console",
    session,
    screen,
    console: consoleLogs,
    errors: pageErrors,
  });
  return { consoleLogs, pageErrors };
}
export function api(session: string, id: string) {
  return evaluate(
    session,
    `const x = new XMLHttpRequest(); x.open('GET', '/api/rooms/${id}', false); x.send(); return JSON.parse(x.responseText);`,
  );
}
export function save(name: string, data: unknown) {
  writeFileSync(`${evidence}/${name}`, JSON.stringify(data, null, 2));
}
