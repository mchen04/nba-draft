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
On wider screens, Your Queue sits above Recently Drafted beside the player list.
Each half scrolls on its own. The shared feed shows the latest 20 picks.
On phones, Queue opens both halves. Roster opens from its own tab.
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

Each browser lists the rooms it opened on the home page and in the ☰ menu.
Pick one to switch rooms; each room keeps its own team, queue, and cookie.
The home page also opens a room from a pasted invite link or room ID.
The list stores room names and team labels only, never codes or cookies.

Search players, filter by position, and open “More” for NBA team, stat mode, and sort.
Tap + DRAFT during your turn to draft a player at once.
Off-turn, the same button reads + QUEUE and adds to your private queue.
Tap a name to select a player. The bottom button uses the same action.
Selection alone never drafts a player.
Tap the selected player at the bottom for full projections.
Roster names open full projections directly. Drafted players do not stay in the bottom selection.
The top strip shows upcoming picks only. The board and exports keep the full pick history.
Queued players show ✓ QUEUED off-turn. Remove them with × in Your Queue.
Use ↑ and ↓ in Your Queue to reorder.
Queue choices skip drafted players and players that cannot fit your roster.
The tab bar shows your open roster slots.

Rosters use full position matching, not greedy placement.
Roster percentage totals use summed makes divided by summed attempts.

## Clocks and offline behavior

Postgres owns every deadline.
No browser timer makes picks.
Every action locks the room and resolves expired turns first.
A poll reads the room row without a lock. Only a poll that finds a due turn takes the lock and catches up.
A tab sends the room version it shows. An unchanged room answers with its version and clock only.
Automatic picks use each manager's highest available eligible queue entry, then the frozen ranking.
Each new deadline starts at the previous deadline, not at the reconnect time.

If all browsers close, no worker wakes exactly at the deadline.
The next request catches up every expired turn in one transaction.
It can complete an entire expired draft without the original browser or process.
Pick timestamps represent logical deadlines during catch-up.
This is lazy catch-up, not a continuously running offline feed.
Draft clocks need no cron or background loop. The scheduled jobs (below) are separate.
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

Each validated ESPN pool is stored once in `nba_draft.datasets` and never changes.
Its metadata records the source URL, the player count ESPN reported and returned, season, mapping version, and retrieval time.
Rooms store only the dataset id and its metadata, not the players.
Browsers load players from `/api/catalog/{id}/{digest}`. The digest is the pool's sha256, so the URL names its content. The response sends `Cache-Control` and `CDN-Cache-Control` as `public, max-age=31536000, immutable`, so browsers and the Vercel CDN keep it for a year. A wrong digest returns an uncached 404.
Each server instance also keeps the last few datasets in memory.

The current dataset is checked against ESPN once a week: by the weekly cron job, or by the first room creation after a week.
A changed pool becomes a new dataset. An unchanged pool keeps its dataset and first retrieval time.
A mapping change also triggers a refresh.
Refresh attempts are limited to one per season per 15 minutes.
Failures keep the last good dataset and record the error. A small amber “ESPN” age badge marks data older than eight days or a failed check.
The ☰ menu shows source, season, dataset version, coverage, update time, last check time, and any warning.
Stale data never blocks the start of a draft.
A room keeps the dataset it was created with. The commissioner can switch a lobby to the newest dataset with refresh.
Live drafts keep their dataset, so a refresh or an ESPN outage never changes a draft in progress.

Weekly checks suit season projections and positions.
Injury status and NBA team can change daily, so they may lag by up to a week. A lobby refresh picks up the latest values.

## Player photos

Run the additive `db/003.sql` migration before publishing the photo route.
It creates `nba_draft.player_photos`. It changes no room, pick, or dataset.

```sh
node --env-file=/private/path/neon.env --import tsx scripts/database.ts migrate 003.sql
node --env-file=/private/path/neon.env --import tsx scripts/photos.ts
```

The ingestion script reads every stored dataset and saves each player's image bytes once.
It requests small profile thumbnails and saves PNG or JPEG bytes in Postgres.
Each record has a MIME type, SHA-256, and ingestion time.
A missing upstream image gets a stored missing marker. Temporary failures remain retryable.
Run the script again after a failure. Cached and missing entries cause no upstream request.
Jobs use per-player database locks to prevent duplicate downloads.
The existing weekly catalog job also ingests new players within a bounded time budget.

An existing Vercel production secret can run the release without exposing its connection.
Use a task-local `vercel.json` copy with this deployment-specific build command:

```json
{"buildCommand":"node --import tsx scripts/release.ts migrate && npm run build"}
```

Keep the existing configuration fields in that copy.
Deploy it with `vercel deploy --prod --skip-domain --local-config /private/path/release.json`.
This uses the hosted production environment and leaves the live domain on its current deployment.
The release applies only `003.sql` and prints schema, counts, and row fingerprints.
It ingests photos, retries temporary failures, and checks reuse in a fresh process with upstream requests disabled.
It logs no room rows or connection values. It never writes rooms, picks, requests, catalogs, or datasets.
For a later read-only capture, use `scripts/release.ts inspect` as the build command instead.
Normal GitHub deployments retain the normal build command.

All photos load from `/api/photos/{playerId}`. Page reads never fetch upstream photos.
Cached images and missing markers have one-year browser and CDN cache headers.
Players awaiting ingestion use an uncached placeholder, so later ingestion can appear.
Database failures also show a placeholder. Browser image failures show the player's initials.
Player lists, queues, recent picks, and rosters use this route. The board stays text-only.

## Scheduled jobs

`vercel.json` registers two jobs. Both require `CRON_SECRET`; Vercel sends it as a bearer token.

- `/api/cron/catalog`, Mondays 10:41 UTC: checks ESPN and stores a new dataset when the pool changed.
- `/api/cron/expire`, daily 09:17 UTC: room expiry, below.

Vercel's Cron Jobs switch covers the whole project.
Expiry runs only when the server sets `ROOM_EXPIRY=on`; otherwise it returns `{"paused":true}` and reads nothing.
So enabling cron jobs for the weekly check does not delete rooms.

## Room expiry

Rooms expire after seven days without a manager action.
Manager actions are claims, ready changes, settings, queue edits, picks, pauses, undo, recovery, leave, and hand-off.
Page polling, room reads, and timeout picks do not count.
A daily Vercel Cron job calls `/api/cron/expire` at 09:17 UTC (`vercel.json`).
Vercel's free Hobby plan allows one run per day and may run any time within that hour ([Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), read 2026-10-01).
The job first resolves expired turns. A draft that is still live stays.
It then deletes the room, its picks, and its request receipts.
The job requires `CRON_SECRET` and `ROOM_EXPIRY=on`.
Without the secret, the route returns 503 and deletes nothing.
`?dryRun=1` reports counts without changes.

Catch-up limits:

- A room can outlive seven days by up to one day, because the job runs daily.
- One run deletes at most 100 rooms. A larger backlog clears over the next days.
- Vercel does not replay a missed run. The next daily run catches up.
- `vercel crons run /api/cron/expire` triggers the job at once from the CLI.

## Exports

Open Board and choose “Export board as PNG” to download the complete current board.
The image includes all rounds and teams, even outside the viewport.
It keeps the displayed order, pick details, position colors, and current-pick highlight.
Player photos use the existing cache. Missing or failed photos show initials.
The image adds the room name and draft summary, without other app controls.
Long names wrap in the image. The on-screen board keeps its existing layout.
Export uses the board loaded in your browser and does not change saved picks.

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
ORIGIN=http://localhost:3167 EVIDENCE=/outside/checkout/evidence node --import tsx scripts/browser-rooms.ts
ORIGIN=https://your-deployment EVIDENCE=/outside/checkout/evidence node --import tsx scripts/browser-hosted.ts
node --import tsx scripts/http-acceptance.ts http://localhost:3167 /outside/checkout/evidence
```

Database tests use real cached ESPN players and task-identified rooms.
The expiry test refuses to sweep if any unrelated room is already past seven days.
The outage test uses the 2025 cache row, which the app never offers.
Browser acceptance drives a complete three-manager draft on phone, tablet, and desktop sizes.
The rooms script switches one browser between two rooms and checks keyboard use, control names, errors, and scroll retention.
The avatar/queue script checks two managers, both action modes, shared picks, private queues, photo loads, mobile layout, and reconnect.
The hosted script is bounded for a live deployment: one room, three sessions, three picks, reload, offline reconnect, and recovery on a third device. It pauses the room at the end.
It records document and panel scroll sizes for every screen and fails on any document scroll.
Open every screenshot before claiming visual proof.
Chromium viewport emulation does not prove Safari or an actual iPhone.

## Vercel publication

The live app deploys from `main` through the connected Vercel project.

1. Set pooled `DATABASE_URL` as a server-only environment value.
2. Set `CRON_SECRET` (any long random string) as a server-only value. Scheduled jobs stay off without it. Set `ROOM_EXPIRY=on` only when room expiry should delete rooms.
3. Push a branch, open a PR, and merge after checks. Vercel builds `main` and registers the cron job from `vercel.json`.
4. Confirm the production deployment matches the merged commit.
5. Run browser acceptance against the deployment and inspect fresh screenshots.
6. Turn on the project's Cron Jobs only after this release serves production. Older releases run expiry without the `ROOM_EXPIRY` guard.
   - Confirm production has no `ROOM_EXPIRY`, or a value other than `on`.
   - Call `/api/cron/expire?dryRun=1` with `Authorization: Bearer $CRON_SECRET`. It must answer `{"paused":true,"expired":0}`.
   - Then turn on Cron Jobs, call `/api/cron/catalog` the same way once, and read both jobs' logs.

This release adds `db/002.sql`, which moves player pools out of rooms into shared datasets.
Older code cannot read a migrated room: every action on it fails until this release serves it.
So never run the migration while an older deployment still serves the same database.

- **Existing database:** deploy first, then run `scripts/database.ts migrate` with the direct connection at once. In between, existing rooms keep working on their embedded pools. Only room creation, player-data refresh, and a lobby season change fail until the migration runs.
- **New, empty database:** migrate it first. Then switch `DATABASE_URL` to it and redeploy this release in the same step. An older deployment must never point at it.

Rolling back past this release breaks every migrated room.
Before such a rollback, run `scripts/restore-embedded-pools.sql` in one transaction (the command is in the file).
It copies each pool back into its rooms and the season cache. A later `migrate` strips the copies again.
Do not print connection values or put them in URLs, screenshots, source, or client bundles.
Do not buy services or change unrelated infrastructure.

## Recovery and boundaries

Room state, ownership hashes, queues, pinned player datasets, and clocks persist in Postgres.
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
