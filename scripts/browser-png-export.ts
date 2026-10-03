import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickOrder } from "../lib/rules";
import {
  api,
  cli,
  click,
  dimensions,
  errors,
  evaluate,
  evidence,
  fill,
  find,
  origin,
  record,
  save,
  shot,
  viewport,
  waitFor,
} from "./browser/lib";

type BoardCell = {
  name: string;
  number?: string;
  detail?: string;
  playerId?: string;
  current: boolean;
};
type Draw = {
  text: string;
  x: number;
  y: number;
  font: string;
  scale: number;
  width: number;
  height: number;
};
const prefix = process.env.SESSION_PREFIX ?? "nba-png-d7557";
const [A, B, C] = ["desktop", "mobile", "third"].map(
  (name) => `${prefix}-${name}`,
);
let roomId = "";
function tab(session: string, name: string) {
  click(session, new RegExp(`^${name}( \\d+)?$`));
}
function state(session = A) {
  return api(session, roomId);
}
function board(session: string) {
  return evaluate(
    session,
    `return [...document.querySelector('.board-scroll table').rows].map(r => [...r.cells].map(c => ({text: c.textContent, name:c.querySelector('strong')?.textContent ?? c.textContent, number:c.querySelector('small')?.textContent, detail:c.querySelectorAll('small')[1]?.textContent, playerId:c.dataset.playerId, current:c.classList.contains('current')})));`,
  );
}
function capture(session: string, name: string) {
  dimensions(session, name);
  shot(session, name);
}
function instrument(session: string) {
  evaluate(
    session,
    `
    window.pngDraws = []; window.pngPhotos = []; window.pngOutlines=[];
    if (!window.pngOriginalText) {
      window.pngOriginalText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text,x,y,...args) {
        const t=this.getTransform(),m=this.measureText(text); window.pngDraws.push({text,x:x*t.a,y:y*t.d,font:this.font,scale:t.a,width:m.width*t.a,height:(m.fontBoundingBoxAscent+m.fontBoundingBoxDescent)*t.d});
        return window.pngOriginalText.call(this,text,x,y,...args);
      };
      window.pngOriginalStroke = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.strokeRect = function(...args) {
        const t=this.getTransform(); window.pngOutlines.push({x:args[0]*t.a,y:args[1]*t.d,width:args[2]*t.a,height:args[3]*t.d,lineWidth:this.lineWidth,color:this.strokeStyle});
        return window.pngOriginalStroke.apply(this,args);
      };
      window.pngOriginalImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(...args) {
        const t=this.getTransform(); window.pngPhotos.push({x:args[1]*t.a,y:args[2]*t.d,width:args[0].width,height:args[0].height});
        return window.pngOriginalImage.apply(this,args);
      };
    }
    return true;`,
  );
}
function checkDraws(rows: BoardCell[][], draws: Draw[]) {
  const normalize = (s: string) => s.replace(/\s+/g, "");
  const isName = (d: Draw) => /^(700|bold) 14px/.test(d.font);
  const left = Math.min(...draws.filter(isName).map((d) => d.x));
  const anchors = draws.filter((d) => d.x === left && isName(d));
  assert.equal(
    anchors.length,
    rows.length,
    "Every board row has a drawn round label",
  );
  const columns: number[] = [];
  function checkText(value: string, candidates: Draw[], name: boolean) {
    const words = normalize(value);
    const filtered = candidates.filter((d) => isName(d) === name);
    const start = filtered.findIndex(
      (d) => normalize(d.text) && words.startsWith(normalize(d.text)),
    );
    assert.ok(start >= 0, `Missing board text: ${value}`);
    let actual = "",
      index = start;
    while (index < filtered.length && actual.length < words.length)
      actual += normalize(filtered[index++].text);
    assert.equal(actual, words, `Wrapped text differs: ${value}`);
    return filtered[start].x;
  }
  let found = 0;
  for (const [rowIndex, row] of rows.entries()) {
    const rowDraws = draws.filter(
      (d) =>
        d.y >= anchors[rowIndex].y &&
        d.y < (anchors[rowIndex + 1]?.y ?? Infinity),
    );
    if (rowIndex === 0) {
      for (const cell of row)
        columns.push(
          checkText(
            cell.name,
            rowDraws.filter((d) => !columns.length || d.x > columns.at(-1)!),
            true,
          ),
        );
    }
    for (const [column, cell] of row.entries()) {
      const cellDraws = rowDraws.filter(
        (d) =>
          d.x >= columns[column] && d.x < (columns[column + 1] ?? Infinity),
      );
      for (const d of cellDraws)
        assert.ok(
          d.x + d.width <= (columns[column + 1] ?? Infinity),
          `Text crosses a column: ${d.text}`,
        );
      if (cell.name) {
        checkText(cell.name, cellDraws, true);
        found++;
      }
      if (cell.number) {
        checkText(cell.number, cellDraws, false);
        found++;
      }
      if (cell.detail) {
        checkText(cell.detail, cellDraws, false);
        found++;
      }
    }
  }
  return found;
}
function exportPng(session: string, name: string) {
  instrument(session);
  const rows: BoardCell[][] = board(session);
  const before = state(session);
  const ref = find(session, "button", "Export board as PNG")!;
  cli(session, ["scrollintoview", ref]);
  const path = `${evidence}/downloads/${name}.png`;
  const download = cli(session, [
    "download",
    find(session, "button", "Export board as PNG")!,
    path,
  ]);
  waitFor(
    session,
    "export ready again",
    () => !!find(session, "button", "Export board as PNG", false),
  );
  const rendered = evaluate(
    session,
    "return {draws:window.pngDraws,photos:window.pngPhotos,outlines:window.pngOutlines};",
  );
  const checked = checkDraws(rows, rendered.draws);
  const png = readFileSync(path);
  assert.ok(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  );
  assert.ok(png.length > 1000);
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  assert.ok(
    rendered.draws.every(
      (d: Draw) => d.x + d.width <= width && d.y + d.height <= height,
    ),
    "All text stays inside PNG bounds",
  );
  assert.equal(
    rendered.outlines.filter((o: { lineWidth: number }) => o.lineWidth === 2)
      .length,
    rows.flat().filter((c) => c.current).length,
    "Current-pick outline matches board",
  );
  const after = state(session);
  assert.deepEqual(after.picks, before.picks, "Export changes no saved picks");
  assert.equal(after.version, before.version, "Export makes no room write");
  const receipt = {
    name,
    path,
    download,
    width,
    height,
    bytes: png.length,
    board: rows,
    draws: rendered.draws,
    photos: rendered.photos,
    outlines: rendered.outlines,
    state: {
      phase: before.phase,
      version: before.version,
      settings: before.settings,
      picks: before.picks,
    },
    checked,
  };
  save(`${name}-receipt.json`, receipt);
  record({
    kind: "PNG export",
    name,
    path,
    width,
    height,
    checked,
    photoCount: rendered.photos.length,
    unchanged: true,
  });
  // Exercise the oracle with a missing board name. The same check must reject it.
  const missing = structuredClone(rows);
  missing.at(-1)![1].name = `Missing${Date.now()}`;
  assert.throws(() => checkDraws(missing, rendered.draws));
  const swapped = structuredClone(rows);
  [swapped[0][1], swapped[0][2]] = [swapped[0][2], swapped[0][1]];
  assert.throws(() => checkDraws(swapped, rendered.draws));
  return receipt;
}
try {
  if (process.env.LONG_BOARD_URL) {
    const url = process.env.LONG_BOARD_URL;
    roomId = url.split("/room/")[1];
    let first: Buffer | undefined;
    for (const [session, label] of [
      [A, "desktop"],
      [B, "mobile-emulation"],
    ] as const) {
      cli(session, ["open", url]);
      viewport(session, session === A ? 1440 : 390, session === A ? 900 : 844);
      waitFor(
        session,
        "long board loaded",
        () => !!find(session, "button", "Board", false),
        30000,
      );
      tab(session, "Board");
      capture(session, `${label}-long-board-top`);
      const dimensions = evaluate(
        session,
        "const e=document.querySelector('.board-scroll'); return {clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,rows:e.querySelector('table').rows.length,columns:e.querySelector('table').rows[0].cells.length};",
      );
      assert.equal(dimensions.rows, 31);
      assert.equal(dimensions.columns, 21);
      assert.ok(
        dimensions.scrollWidth > dimensions.clientWidth &&
          dimensions.scrollHeight > dimensions.clientHeight,
      );
      evaluate(
        session,
        "const e=document.querySelector('.board-scroll');e.scrollLeft=e.scrollWidth;e.scrollTop=e.scrollHeight;return true;",
      );
      capture(session, `${label}-long-board-bottom-right`);
      const scroll = evaluate(
        session,
        "const e=document.querySelector('.board-scroll');return {left:e.scrollLeft,top:e.scrollTop};",
      );
      const receipt = exportPng(session, `${label}-long-full-board`);
      assert.equal(receipt.state.picks.length, 600);
      assert.ok(receipt.photos.length > 0);
      assert.deepEqual(
        evaluate(
          session,
          "const e=document.querySelector('.board-scroll');return {left:e.scrollLeft,top:e.scrollTop};",
        ),
        scroll,
        "Export preserves scroll position",
      );
      if (first)
        assert.deepEqual(
          readFileSync(receipt.path),
          first,
          "Desktop/mobile export identical current board",
        );
      else first = readFileSync(receipt.path);
      record({
        kind: "off-viewport",
        label,
        ...dimensions,
        scroll,
        all600Picks: true,
        identicalAcrossViewports: true,
      });
      assert.equal(
        errors(session, "long board").pageErrors.errors?.length ?? 0,
        0,
      );
    }
    save("long-board-summary.json", {
      ok: true,
      roomId,
      origin,
      controlledStoredBoard: true,
      picks: 600,
      teams: 20,
      rounds: 30,
      allRowsAndColumnsDrawn: true,
      scrollPreserved: true,
      identicalDesktopMobile: true,
      emulation: "Chromium viewport, not physical mobile or Safari",
    });
  } else {
    cli(A, ["open", origin]);
    viewport(A, 1440, 900);
    fill(A, "Room name", "PNG export acceptance");
    fill(A, "Your name", "Avery");
    fill(A, "Teams", "3", "spinbutton");
    fill(A, "Seconds/pick", "600", "spinbutton");
    fill(A, "First-round order (team numbers)", "3,1,2");
    for (const slot of ["PG", "SG", "SF", "PF", "C", "G", "F", "BN"])
      fill(A, slot, "0", "spinbutton");
    fill(A, "UTIL", "3", "spinbutton");
    click(A, "Create room");
    waitFor(
      A,
      "new controlled room",
      () => /\/room\//.test(cli(A, ["get", "url"]).url),
      30000,
    );
    const url = cli(A, ["get", "url"]).url;
    roomId = url.split("/room/")[1];
    waitFor(
      A,
      "lobby",
      () => !!find(A, "button", "Claim team 1", false),
      30000,
    );
    click(A, "Claim team 1");
    fill(A, "Manager name", "Avery");
    click(A, "Join team 1");
    waitFor(A, "joined", () => state().me?.slot === 0);
    for (const [session, slot, name] of [
      [B, 2, "Blake"],
      [C, 3, "Casey"],
    ] as const) {
      cli(session, ["open", url]);
      viewport(session, session === B ? 390 : 1280, session === B ? 844 : 800);
      waitFor(
        session,
        "join available",
        () => !!find(session, "button", `Claim team ${slot}`, false),
        30000,
      );
      click(session, `Claim team ${slot}`);
      fill(session, "Manager name", name);
      click(session, `Join team ${slot}`);
      waitFor(session, "joined", () => state(session).me?.slot === slot - 1);
    }
    for (const s of [A, B, C]) click(s, "Ready");
    tab(A, "Board");
    capture(A, "desktop-empty-board");
    exportPng(A, "desktop-empty");
    tab(B, "Board");
    capture(B, "mobile-empty-board-emulation");
    exportPng(B, "mobile-empty-emulation");
    tab(A, "Lobby");
    waitFor(A, "all ready visible", () =>
      evaluate(A, "return document.body.innerText.includes('3/3 ready');"),
    );
    click(A, "Start draft");
    waitFor(A, "live", () => state().phase === "live");
    tab(B, "Players");
    waitFor(B, "off-turn queue", () => !!find(B, "button", /^Queue /, false));
    const queued = evaluate(
      B,
      "return document.querySelector('.player-table button.item').getAttribute('aria-label').replace('Select ','');",
    );
    click(B, `Queue ${queued}`);
    waitFor(B, "queue saved", () => state(B).queue.length === 1);
    assert.equal(state(A).queue.length, 0);
    record({
      kind: "draft regression",
      behavior: "off-turn private queue",
      ok: true,
    });
    const owners: Record<number, string> = { 0: A, 1: B, 2: C };
    for (let index = 0; index < 9; index++) {
      const live = state();
      const session = owners[pickOrder(live.settings)[index]];
      tab(session, "Players");
      waitFor(session, "current rendered pick", () =>
        evaluate(
          session,
          `return document.querySelector('.pick-strip button.current')?.getAttribute('aria-label').startsWith('Pick ${index + 1},');`,
        ),
      );
      const names: string[] = evaluate(
        session,
        "return [...document.querySelectorAll('.player-table button.item')].slice(0,20).map(b=>b.getAttribute('aria-label').replace('Select ',''));",
      );
      const chosen = names.find((n) => {
        const r = find(session, "button", `Draft ${n}`, false);
        return r && cli(session, ["is", "enabled", r]).enabled;
      });
      assert.ok(chosen);
      click(session, `Draft ${chosen}`);
      for (const s of [A, B, C])
        waitFor(s, "pick rendered", () =>
          evaluate(
            s,
            `return Number(document.querySelector('.recent-panel .panel-bar span')?.textContent.split(' ')[0])===${index + 1};`,
          ),
        );
      if (index === 2) {
        tab(A, "Board");
        capture(A, "desktop-partial-board");
        const partial = exportPng(A, "desktop-partial");
        assert.ok(
          partial.photos.length > 0,
          "Successful photo appears in actual PNG",
        );
        tab(B, "Board");
        capture(B, "mobile-partial-board-emulation");
        exportPng(B, "mobile-partial-emulation");
        evaluate(
          A,
          "window.pngFetch=window.fetch; window.fetch=(input,init)=>String(input).includes('/api/photos/') ? Promise.reject(new TypeError('Failed to fetch: controlled network failure')) : window.pngFetch(input,init); return true;",
        );
        const failed = exportPng(A, "photo-network-failure");
        assert.equal(failed.photos.length, 0);
        evaluate(A, "window.fetch=window.pngFetch; return true;");
        evaluate(
          A,
          "window.fetch=(input,init)=>String(input).includes('/api/photos/') ? Promise.resolve(new Response('<svg/>',{headers:{'Content-Type':'image/svg+xml'}})) : window.pngFetch(input,init); return true;",
        );
        const missingPhoto = exportPng(A, "photo-missing-cache");
        assert.equal(missingPhoto.photos.length, 0);
        evaluate(
          A,
          "window.fetch=(input,init)=>String(input).includes('/api/photos/') ? Promise.resolve(new Response('',{status:503})) : window.pngFetch(input,init); return true;",
        );
        const unavailable = exportPng(A, "photo-http-failure");
        assert.equal(unavailable.photos.length, 0);
        evaluate(A, "window.fetch=window.pngFetch; return true;");
        evaluate(
          A,
          "window.pngTimeout=false;window.pngBusy=false;window.fetch=(input,init)=>String(input).includes('/api/photos/') ? new Promise((resolve,reject)=>{setTimeout(()=>{window.pngBusy=document.querySelector('.board-panel button').disabled;},100);init.signal.addEventListener('abort',()=>{window.pngTimeout=true;reject(init.signal.reason);},{once:true});}) : window.pngFetch(input,init);return true;",
        );
        const started = Date.now();
        const stalled = exportPng(A, "photo-timeout");
        assert.equal(stalled.photos.length, 0);
        assert.deepEqual(
          evaluate(
            A,
            "return {timeout:window.pngTimeout,busy:window.pngBusy};",
          ),
          { timeout: true, busy: true },
        );
        record({
          kind: "photo timeout",
          elapsedMs: Date.now() - started,
          initials: true,
          disabledDuringExport: true,
        });
        evaluate(A, "window.fetch=window.pngFetch;return true;");
        // Force only photo decodes to fail. Board names and metadata must survive.
        evaluate(
          A,
          "window.pngBitmap=window.createImageBitmap; window.createImageBitmap=async()=>{throw new Error('controlled corrupt photo');}; return true;",
        );
        const corrupt = exportPng(A, "photo-decode-failure");
        assert.equal(corrupt.photos.length, 0);
        evaluate(A, "window.createImageBitmap=window.pngBitmap; return true;");
        // Encoding failure must show an error, allow retry, and preserve drafting state.
        evaluate(
          A,
          "window.pngToBlob=HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob=function(cb){cb(null);}; return true;",
        );
        const unchanged = state();
        click(A, "Export board as PNG");
        waitFor(A, "export error", () =>
          evaluate(
            A,
            "return document.body.innerText.includes('The board image could not be exported. Try again.');",
          ),
        );
        assert.deepEqual(state().picks, unchanged.picks);
        evaluate(
          A,
          "HTMLCanvasElement.prototype.toBlob=window.pngToBlob; return true;",
        );
        exportPng(A, "export-error-retry");
        record({
          kind: "fault injection",
          network: true,
          decode: true,
          encoding: true,
          retry: true,
        });
        // Existing undo previews, pauses, and removes only the latest pick.
        click(A, "Undo");
        click(A, "Confirm undo");
        waitFor(
          A,
          "undo",
          () => state().picks.length === 2 && state().phase === "paused",
        );
        tab(A, "Board");
        exportPng(A, "paused-after-undo");
        click(A, "Resume");
        waitFor(A, "resume", () => state().phase === "live");
        const s = owners[pickOrder(state().settings)[2]];
        tab(s, "Players");
        waitFor(s, "undo visible", () =>
          evaluate(
            s,
            "return document.querySelector('.pick-strip button.current')?.getAttribute('aria-label').startsWith('Pick 3,');",
          ),
        );
        click(s, `Draft ${chosen}`);
        for (const s of [A, B, C])
          waitFor(s, "redraft rendered", () =>
            evaluate(
              s,
              "return Number(document.querySelector('.recent-panel .panel-bar span')?.textContent.split(' ')[0])===3;",
            ),
          );
        record({
          kind: "draft regression",
          behavior: "manual picks, 3RR order, undo, pause, resume, redraft",
          ok: true,
        });
      }
    }
    assert.equal(state().phase, "complete");
    for (const [s, name] of [
      [A, "desktop-populated"],
      [B, "mobile-populated-emulation"],
    ] as const) {
      tab(s, "Board");
      capture(s, `${name}-board`);
      exportPng(s, name);
    }
    tab(A, "Roster");
    capture(A, "desktop-existing-roster");
    assert.ok(
      evaluate(
        A,
        "return document.querySelectorAll('.roster-panel .roster-list .avatar').length>0;",
      ),
    );
    for (const s of [A, B, C])
      assert.equal(errors(s, "final").pageErrors.errors?.length ?? 0, 0);
    save("browser-png-summary.json", {
      ok: true,
      roomId,
      origin,
      actualBackend: true,
      emulation: "Chromium viewport, not physical mobile or Safari",
      checks: [
        "empty, partial, populated desktop/mobile downloads",
        "PNG bytes and all current board text in correct row/column order",
        "photos drawn",
        "network and decode failures use initials",
        "encoding failure and retry",
        "exports do not write room",
        "private queue, manual drafting, 3RR, undo, pause/resume, roster",
        "missing-name oracle rejects corruption",
      ],
    });
  }
} finally {
  for (const s of [A, B, C])
    try {
      cli(s, ["close"]);
    } catch {}
}
