# NBA Draft Room

A standalone basketball draft room with ESPN projections, third-round reversal, and CSV export.
The app does not import ESPN rosters or change ESPN accounts.

## Local setup

Use Node 22 or newer.
Run `npm ci`.
Set `DATABASE_URL` to a pooled Neon Postgres connection.
Keep connection values in a private environment file outside the checkout.
Do not prefix database variables with `NEXT_PUBLIC_`.

```sh
node --env-file=/private/path/neon.env --import tsx scripts/database.ts inspect
node --env-file=/private/path/neon.env --import tsx scripts/database.ts migrate
node --env-file=/private/path/neon.env node_modules/next/dist/bin/next dev
```

Inspect database tables before migration.
The migration creates only the `nba_draft` schema and its tables.
It does not replace existing data.
Run migrations once, not inside each server request.
`DIRECT_URL` is optional for a separate migration connection.
The runtime uses the pooled `DATABASE_URL`.
TLS verifies the database certificate.

## Commissioner guide

Create a room, choose rules, and share its room address.
New rooms start with ESPN's H2H Points defaults, except the draft format.

| Setting      | Default                                                                        | Source                            |
| ------------ | ------------------------------------------------------------------------------ | --------------------------------- |
| Teams        | 10                                                                             | ESPN                              |
| Pick clock   | 90 seconds                                                                     | ESPN                              |
| Roster       | PG, SG, SF, PF, C, G, F, 3 UTIL, 3 BN (13 rounds)                              | ESPN                              |
| Scoring      | PTS 1, 3PM 1, FGA −1, FGM 2, FTA −1, FTM 1, REB 1, AST 2, STL 4, BLK 4, TOV −2 | ESPN                              |
| Format       | Third-round reversal (3RR)                                                     | This app. ESPN defaults to snake. |
| Timeout pick | Highest FP per game                                                            | This app                          |

ESPN also adds one IR slot. IR is not a draft round, so the app omits it.
Sources, read 2026-10-01:
[ESPN default points-league scoring](https://www.espn.com/fantasy/basketball/story/_/id/30296896/espn-fantasy-default-points-league-scoring-explained),
[ESPN Fantasy Basketball 101: settings](https://www.espn.com/fantasy/basketball/story/_/id/20800285/espn-fantasy-basketball-101-adjusting-settings),
and ESPN's own league-defaults feed for season 2027
(`lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leaguedefaults/2?view=mSettings`, “FBA H2H Points”).
“Use ESPN defaults” restores them and keeps your chosen format.

Every value stays editable in the lobby under League settings.
Supported sizes are 2–20 teams and 1–30 roster slots.
Pick clocks support 5–600 seconds.
Change the first-round order with team numbers separated by commas.
Every team must claim a slot and mark ready before start.
Changing settings clears ready flags.

3RR runs forward, reverse, reverse, forward, reverse, then alternates.
Snake reverses every round.
For four teams, 3RR starts ABCD, DCBA, DCBA, ABCD, DCBA.
See [Sleeper's third-round-reversal explanation](https://support.sleeper.com/en/articles/3896882-what-is-3rd-round-reversal).

Category scoring is also available.
Double-double bonuses and keepers are not supported.
Turnover ranking puts lower values first.

After start, rules, projections, and eligibility stay fixed.
Pause saves the remaining clock. Resume restores it.
Check “Pick for team on clock” to draft for an absent manager.
“Undo” previews the latest pick and requires confirmation.
Undo removes only that pick and pauses the room with a full clock.
If no remaining player fits, the room pauses instead of breaking roster rules.

Hand off the commissioner role from the ☰ menu.
If the commissioner leaves, the longest-standing manager with a team becomes commissioner.
If the commissioner makes no action for 15 minutes, any manager can take over from the ☰ menu.

## Manager guide

The room always fits one screen. Lists, the board, and menus scroll inside their own panels.
On phones, the tabs switch between Lobby, Players, Queue, Roster, and Board.
On wider screens, the queue and roster stay beside the player list.
Each panel keeps its filters, selection, and scroll position when you switch views.

Open the invite address, choose an open team, enter your name, and join.
Before the draft starts, “Switch” moves you to another open team.
“Leave room…” in the ☰ menu releases your team. Join again like a new manager.
After the draft starts, a team that loses its manager keeps drafting by timeout.
Anyone with the invite address can claim that open team and continue.

Your ownership cookie survives refresh and browser reconnect.
Save your private recovery code from the lobby banner or the ☰ menu.
Use the recovery code in the ☰ menu on another device to restore your team and queue.
The commissioner code also restores commissioner controls.
Anyone with a recovery code can control that owner; keep it private.
Recovery supports up to five recent device sessions.
If every ownership code and cookie is lost, there is no unauthenticated takeover route.
Before a claim, the browser saves a private retry credential in session storage.
If the claim response disappears, “Retry saved request” restores ownership.

Search players, filter by position, and open “More” for NBA team, stat mode, and sort.
Tap a name to select a player. Press the button with that player's name to draft.
Selection alone never drafts a player.
Tap the selected player at the bottom for full projections.
Use + beside a player to queue. Use ↑ and ↓ in Queue to reorder.
Queue choices skip drafted players and players that cannot fit your roster.
The tab bar shows your open roster slots.

Rosters use full position matching, not greedy placement.
Roster percentage totals use summed makes divided by summed attempts.

## Clocks and offline behavior

Postgres owns every deadline.
No browser timer makes picks.
Every room read or action locks the room and resolves expired turns first.
Automatic picks use each manager's highest available eligible queue entry, then the frozen ranking.
Each new deadline starts at the previous deadline, not at the reconnect time.

If all browsers close, no worker wakes exactly at the deadline.
The next request catches up every expired turn in one transaction.
It can complete an entire expired draft without the original browser or process.
Pick timestamps represent logical deadlines during catch-up.
This is lazy catch-up, not a continuously running offline feed.
Draft clocks need no cron or background loop. The daily expiry job (below) is separate.
The Next.js handlers use Node functions with a 60-second execution limit.

Manual picks after an expired deadline lose to the server timeout.
Row locking and SQL uniqueness constraints resolve competing requests once.
Pick requests include the expected turn and an idempotency key.
Reuse the same key and payload after an uncertain response.
The UI offers “Retry saved request” after a network failure.
Going offline cancels a pending action without changing its idempotency key.
Actions also stop waiting after 30 seconds and offer the same retry.
The server may already have saved the action; cancellation does not undo it.
Room reads stop waiting after 15 seconds, so polling can recover from a stalled connection.
Rejected commands still commit any deadline catch-up that happened before them.
Disconnected managers can inspect their last loaded room, but cannot draft.

## Projection data

The server reads ESPN's unofficial endpoint without ESPN credentials:

`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/{year}/segments/0/leaguedefaults/1?view=kona_player_info`

Season uses the ending year: 2027 means 2026–27.
ESPN's game feed reported `currentSeasonId` 2027 on 2026-10-01.
The app defaults to the next ending year from July onward.
Only source 1, season split 0, scoring period 0, and the matching year count as forecasts.
On 2026-10-01 ESPN returned 1,095 players; 349 had a 2026–27 projection.
Players without one stay in the pool, sort last, and show — for every stat.
ESPN slot IDs 0–6, 11, and 12 map to PG, SG, SF, PF, C, G, F, UTIL, and BN.
Combined ESPN slots (G/F, F/C, and similar) and IR never add draft capacity.
Team IDs map to standard NBA abbreviations; ESPN's own team list confirms each ID.
Duplicate identities, invalid payloads, and truncated pools do not replace a usable cache.

ESPN leaves zero-valued stats out of a projection line.
For example, a center with 7 projected 3PA and 7 3PA misses has no 3PM entry.
The app restores those zeros only when points and every made/missed/attempted total reconcile.
All 349 current lines reconcile. A line that does not reconcile keeps its gaps as missing.
ESPN's own percentages stay unchanged. The app derives a missing percentage from makes and attempts.
Points scores require every nonzero-weight input.
Counting rates use season totals divided by projected games.

Validated snapshots persist in Postgres and refresh after six hours.
A mapping change also triggers a refresh.
Refresh attempts are limited to one per season per 15 minutes.
Failures keep the old values. A small amber “ESPN” age badge marks stale or failed data.
The ☰ menu shows source, coverage, retrieval time, and any warning.
Stale data never blocks the start of a draft.
Live drafts use their own frozen snapshot, so ESPN outages do not affect picks.

## Room expiry

Rooms expire after seven days without a manager action.
Manager actions are claims, ready changes, settings, queue edits, picks, pauses, undo, recovery, leave, and hand-off.
Page polling, room reads, and timeout picks do not count.
A daily Vercel Cron job calls `/api/cron/expire` at 09:17 UTC (`vercel.json`).
Vercel's free Hobby plan allows one run per day and may run any time within that hour ([Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), read 2026-10-01).
The job first resolves expired turns. A draft that is still live stays.
It then deletes the room, its picks, and its request receipts.
The job requires `CRON_SECRET`; Vercel sends it automatically as a bearer token.
Without it, the route returns 503 and deletes nothing.
`?dryRun=1` reports counts without changes.

## Exports

Authenticated owners can download order, picks, and roster CSV files.
Files use UTF-8 with a BOM and quoted cells.
Picks include player IDs, team slots, order, source, and UTC selection time.
Rosters include every configured slot, including open slots before completion.
CSV escaping protects spreadsheet cells against formula injection.
Enter results into ESPN manually; the app has no ESPN write integration.

## Verification

```sh
npm run check
npm test
node --env-file=/private/path/neon.env --import tsx --test --test-concurrency=1 tests/postgres.integration.ts
npm run build
node --env-file=/private/path/neon.env --env-file=/private/path/cron.env node_modules/next/dist/bin/next start --port 3167
ORIGIN=http://localhost:3167 EVIDENCE=/outside/checkout/evidence node --import tsx scripts/browser-acceptance.ts
node --import tsx scripts/http-acceptance.ts http://localhost:3167 /outside/checkout/evidence
```

Database tests use real cached ESPN players and task-identified rooms.
The expiry test refuses to sweep if any unrelated room is already past seven days.
The outage test uses the 2025 cache row, which the app never offers.
Browser acceptance drives a complete three-manager draft on phone, tablet, and desktop sizes.
It records document and panel scroll sizes for every screen and fails on any document scroll.
Open every screenshot before claiming visual proof.
Chromium viewport emulation does not prove Safari or an actual iPhone.

## Vercel publication

The live app deploys from `main` through the connected Vercel project.

1. Set pooled `DATABASE_URL` as a server-only environment value.
2. Set `CRON_SECRET` (any long random string) as a server-only value. Expiry stays off without it.
3. Push a branch, open a PR, and merge after checks. Vercel builds `main` and registers the cron job from `vercel.json`.
4. Confirm the production deployment matches the merged commit.
5. Run browser acceptance against the deployment and inspect fresh screenshots.
6. Confirm the cron job in the Vercel project settings, then read its daily log.

The schema needs no migration for this release. Activity time lives in each room's JSON data.
Do not print connection values or put them in URLs, screenshots, source, or client bundles.
Do not buy services or change unrelated infrastructure.

## Recovery and boundaries

Room state, ownership hashes, queues, frozen player data, and clocks persist in Postgres.
Restarting Next.js does not reset the draft.
SQL pick rows mirror committed board state, with unique room/player and room/pick constraints.
All mutations serialize on the room row.
There is no in-memory authority, WebSocket daemon, or SQLite file.
Database failures show an error and preserve the last loaded UI.
The database URL never enters a response.
Standard Neon restore tools remain separate infrastructure work.

This personal-project app uses unguessable invite addresses and private ownership cookies.
An invite holder can inspect public rosters and board state, but cannot read another manager's queue.
It does not add enterprise authentication, chat, trades, keepers, schedules, or scoring contests.
