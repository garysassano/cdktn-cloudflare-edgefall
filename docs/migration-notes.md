# Migration notes

## Edgefall vertical-slice reset

The first Edgefall D1 migration intentionally drops the old top-down prototype's incompatible `runs` table before creating profiles, unlocks, full run history, party membership, and separate normal and Daily leaderboard indexes.

This is a pre-1.0 deployed-state break: any existing prototype leaderboard rows are removed when the migration runs.

No released Edgefall run records use the discarded schema, and the reset avoids retaining a second compatibility path for unpublished data.
