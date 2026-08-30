"""Build Edgefall's architecture diagram in both repository themes."""

import pathlib
import sys

SKILL = pathlib.Path.home() / ".agents/skills/cloudflare-diagrams/assets"
sys.path.insert(0, str(SKILL))

from cfdiagram import LABEL_PX, Diagram, Flow, Node  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / "src/assets"
BROWSER, WORKER, ROOM, RUNS = 0, 1, 2, 3


def nodes():
    return [
        Node("browser", "globe", "Browser party", inside=False, external=True),
        Node("worker", "workers", "Workers", "edgefall"),
        Node("room", "durable-objects", "Durable Objects", "one per room"),
        # The shared Cloudflare glyph set has no D1-specific mark, so the
        # generic API/data product glyph accompanies the explicit D1 title.
        Node("runs", "api", "D1", "edgefall-runs"),
    ]


FLOWS = [
    Flow(BROWSER, WORKER, "join + input", "HTTP / WebSocket"),
    Flow(WORKER, ROOM, "route by code", "authoritative 20 Hz"),
    Flow(ROOM, RUNS, "index victory", "leaderboard"),
]


def build(theme):
    replay = Node("replays", "r2", "R2 replays", "edgefall-replays")
    diagram = Diagram(
        nodes(),
        FLOWS,
        theme,
        boundary_note="edgefall",
        branch=(ROOM, replay, "finished run"),
        per_row=4,
    )
    diagram.render()
    return diagram


OUT.mkdir(parents=True, exist_ok=True)
for theme in ("light", "dark"):
    diagram = build(theme)
    path = OUT / f"arch-diagram{'' if theme == 'light' else '-dark'}.svg"
    path.write_text(diagram.finish())
    print(
        f"  {path.name}: {diagram.W:.0f}x{diagram.H:.0f} "
        f"aspect {diagram.W / diagram.H:.2f} "
        f"label {LABEL_PX * 830 / diagram.W:.1f}px at README width"
    )
