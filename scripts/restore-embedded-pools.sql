-- Run only before rolling back to a release older than db/002.sql, in one transaction:
--   psql "$DIRECT_URL" --single-transaction -f scripts/restore-embedded-pools.sql
-- Older code reads each room's own pool and the season snapshot, so copy them back.
-- Rooms keep their dataset id; a later `migrate` strips the copies again.
UPDATE nba_draft.rooms r
SET data = jsonb_set(r.data, '{catalog,players}', d.players)
FROM nba_draft.datasets d
WHERE NOT r.data->'catalog' ? 'players'
  AND d.id = (r.data->'catalog'->>'dataset')::bigint;
UPDATE nba_draft.catalogs c
SET snapshot = d.meta || jsonb_build_object('players', d.players)
FROM nba_draft.datasets d
WHERE c.snapshot IS NULL AND d.id = c.dataset_id;
