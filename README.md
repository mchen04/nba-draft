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
Defaults are examples, not facts about your league.
Supported sizes are 2–20 teams and 1–30 roster slots.
Pick clocks support 5–600 seconds.
Change roster size through the position counts.
Change the first-round order with team numbers separated by commas.
Every team must claim a slot and mark ready before start.
Changing settings clears ready flags.

3RR runs forward, reverse, reverse, forward, reverse, then alternates.
Snake reverses every round.
For four teams, 3RR starts ABCD, DCBA, DCBA, ABCD, DCBA.
See [Sleeper's third-round-reversal explanation](https://support.sleeper.com/en/articles/3896882-what-is-3rd-round-reversal).

Choose categories or custom points weights.
Supported points inputs appear in setup.
Double-double bonuses and keepers are not supported.
Timeout ranking is configurable and stays separate from each manager's table sort.
Turnover ranking puts lower values first.
Category ranking is not a balanced category recommendation.

After start, rules, projections, and eligibility stay fixed.
Pause saves the remaining clock.
Resume restores it.
Enable “Pick for on-clock team” to draft for an absent manager.
“Undo latest” previews the latest pick and requires confirmation.
If another device changes the draft, review the latest pick again before undoing.
Undo removes only that pick and pauses the room with a full clock.
Review the roster before resuming.
If no remaining player fits, the room pauses instead of breaking roster rules.
Undo can also reopen a completed room.

## Manager guide

Open the invite address, enter your name, and claim an open team.
Your ownership cookie survives refresh and browser reconnect.
Save your private recovery code after creation or claim.
Before a claim, the browser saves a private retry credential in session storage.
If the complete response disappears, retry restores ownership and the recovery code, even after reloading that tab.
The database stores only credential hashes. Closing the tab before recovery discards its saved retry.
Use “Recover your team on another device” to restore ownership and your queue.
The commissioner code also restores commissioner controls.
Anyone with a recovery code can control that owner; keep it private.
Recovery supports up to five recent device sessions.
There is no email service or password reset.
If every ownership code and cookie is lost, there is no unauthenticated takeover route.

Use search, position, and NBA team filters to find players.
On phones, open “Filters” to show position and NBA team choices.
Select a player, then press the button with that player's name to draft.
Selection alone never drafts a player.
Use “Player details” to inspect full projections and missing inputs.
Use + Queue to add one player. On phones, use + beside the player.
Move up/down controls save your private queue order.
Queue choices skip drafted players and players that cannot fit your roster.
Open other teams through the pick strip, roster selector, or board team buttons.
Filters, selection, and list scroll stay when you change views.

Rosters use full position matching, not greedy placement.
Earlier flexible players can move when a later pick requires their old slot.
Open slots show needs; each player fills only one slot.
Roster percentage totals use summed makes divided by summed attempts.
Partial coverage is shown beside each total.

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
No cron subscription or unsupported background loop is required.
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
Only source 1, season split 0, scoring period 0, and the matching year count as forecasts.
ESPN slot IDs map separately from primary-position IDs.
IR never adds draft capacity.
Unrecognized-only eligibility is excluded and disclosed.
Duplicate identities, invalid payloads, and truncated pools do not replace a usable cache.

The UI shows retrieval time, season, missing counts, and current projection coverage.
ESPN's revision time and rate limits are unknown.
Missing values stay missing; zero stays zero.
Counting rates use season totals divided by projected games.
Percentages use source ratios, or labeled makes/attempts derivation.
Points scores require every nonzero-weight input.
Decimal arithmetic applies weights before presentation rounding.

Validated snapshots persist in Postgres.
Setup reuses them for six hours.
Refresh attempts are shared and limited to one per season per 15 minutes.
Failures keep the old values and display a cache warning.
The app does not bypass source restrictions or make repeated automatic retries.
Snapshots over 24 hours old require commissioner acknowledgment.
Snapshots over seven days old cannot start a draft.
Starting with no forecasts also requires acknowledgment.
Live drafts use their own frozen snapshot during ESPN outages.

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
node --env-file=/private/path/neon.env node_modules/next/dist/bin/next start --port 3104
node --import tsx scripts/browser-acceptance.ts http://localhost:3104 /outside/checkout/evidence
node --import tsx scripts/edge-acceptance.ts http://localhost:3104 /outside/checkout/evidence
node --import tsx scripts/http-acceptance.ts http://localhost:3104 /outside/checkout/evidence
node --env-file=/private/path/neon.env --import tsx scripts/ui-extra-acceptance.ts http://localhost:3104 /outside/checkout/evidence
node --import tsx scripts/offline-acceptance.ts prepare http://localhost:3104 /outside/checkout/evidence
```

Database tests use real cached ESPN players and task-identified rooms.
They leave these rooms as evidence and never delete unrelated data.
Do not run test outage simulation against a database serving a user draft setup.
The test restores shared cache status after the injected failure.
Browser acceptance uses the installed Agent Browser CLI with isolated sessions.
Open every screenshot before claiming visual proof.
The offline check closes its originating browsers after start.
Stop the server, wait past all deadlines, and inspect stored state without calling the room API.
Start a new server process, then run the offline script with `verify` instead of `prepare`.
The check requires queued picks at the original deadlines, not the reconnect time.
Extra browser checks require the private database environment for controlled row contention and source outage.
`CAPTURE_TRANSPORT=none` permits functional checks when screenshot capture fails.
It records unavailable captures and never proves visual acceptance.
Chromium viewport emulation does not prove Safari or an actual iPhone.

## Vercel publication

Publication follows independent review, verification, and cleanup gates.
Do not push, open a PR, merge, or deploy during the build-only stage.
During the authorized publication stage:

1. Connect this GitHub repository to a task-scoped Vercel project.
2. Set pooled `DATABASE_URL` as a server-only environment value.
3. Inspect and migrate the selected database before the first deployment.
4. Use `npm ci` and the default Next.js build command.
5. Push the approved feature commit, open a PR, and merge after exact-head checks.
6. Confirm the production deployment matches the merged commit.
7. Run browser acceptance against the actual deployment and inspect fresh screenshots.
8. Repeat persistence, ownership, timeout, and export checks on the deployed room.

Do not print connection values or put them in URLs, screenshots, source, or client bundles.
Do not buy services or change unrelated infrastructure.
No live URL or deployed acceptance is claimed by the local build.

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
