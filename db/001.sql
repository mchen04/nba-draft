CREATE SCHEMA IF NOT EXISTS nba_draft;
CREATE TABLE IF NOT EXISTS nba_draft.catalogs (
  season integer PRIMARY KEY,
  snapshot jsonb,
  attempted_at timestamptz,
  error text
);
CREATE TABLE IF NOT EXISTS nba_draft.rooms (
  id uuid PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nba_draft.picks (
  room_id uuid NOT NULL REFERENCES nba_draft.rooms(id),
  pick_index integer NOT NULL CHECK (pick_index >= 0),
  player_id bigint NOT NULL,
  team_slot integer NOT NULL CHECK (team_slot >= 0),
  source text NOT NULL,
  picked_at timestamptz NOT NULL,
  PRIMARY KEY (room_id, pick_index),
  UNIQUE (room_id, player_id)
);
CREATE TABLE IF NOT EXISTS nba_draft.requests (
  room_id uuid NOT NULL REFERENCES nba_draft.rooms(id),
  request_id uuid NOT NULL,
  actor text NOT NULL,
  payload_hash text NOT NULL,
  PRIMARY KEY (room_id, request_id)
);
