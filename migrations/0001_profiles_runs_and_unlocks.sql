PRAGMA foreign_keys = ON;

-- Pre-1.0 Edgefall reset: the old top-down prototype used an incompatible
-- six-column runs table. The vertical slice intentionally replaces that
-- unpublished schema instead of carrying a compatibility layer.
DROP TABLE IF EXISTS run_players;
DROP TABLE IF EXISTS unlocks;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS profiles;

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unlocks (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  unlock_id TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, unlock_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  result TEXT NOT NULL CHECK (result IN ('victory', 'defeat')),
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 4),
  score INTEGER NOT NULL CHECK (score >= 0),
  seed INTEGER NOT NULL,
  daily INTEGER NOT NULL CHECK (daily IN (0, 1)),
  finished_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_players (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 3),
  PRIMARY KEY (run_id, profile_id)
);

CREATE INDEX IF NOT EXISTS runs_normal_board
  ON runs (party_size, daily, score DESC, elapsed_ms ASC, finished_at ASC)
  WHERE result = 'victory';

CREATE INDEX IF NOT EXISTS runs_daily_board
  ON runs (seed, party_size, score DESC, elapsed_ms ASC, finished_at ASC)
  WHERE result = 'victory' AND daily = 1;

CREATE INDEX IF NOT EXISTS run_players_profile_history
  ON run_players (profile_id, run_id);
