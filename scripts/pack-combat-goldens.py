"""Pack combat section 5 with Python struct, independently of the TypeScript codec.

The unrelated input/base-snapshot payloads retain their previously packed bytes;
only their one-byte protocol minor header changes here.
"""

import argparse
import copy
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / "test/fixtures/protocol-v3"
PHASES = ["active", "complete", "retired", "failed"]
STATUSES = ["pending", "alive", "resolved"]
PICKUPS = ["dormant", "available", "claimed", "expired", "unsupported"]
RESOLUTIONS = [
    "killed",
    "retreated",
    "crushed",
    "out-of-bounds",
    "ambient-timeout",
    "checkpoint-retired",
]
FAILURES = ["critical-loss", "forbidden-retreat", "invalid-pose"]
CAUSES = [
    "initial-overlap",
    "residual-overlap",
    "contact-limit",
    "unresolved-contact",
    "retreated",
    "crushed",
    "out-of-bounds",
]


def tick(value):
    return 0 if value is None else value + 1


def optional(values, value):
    return 0 if value is None else values.index(value) + 1


def combat_bytes(value):
    failure = value["failure"] or {}
    result = bytearray(
        struct.pack(
            "<HHIIIIIIHHHHHHIIII",
            5,
            56,
            value["scenarioId"],
            value["nextEntityId"],
            value["nextActionId"],
            value["encounterEventCursor"],
            value["encounterId"],
            PHASES.index(value["phase"]),
            len(value["members"]),
            len(value["objectives"]),
            len(value["kills"]),
            len(value["volumes"]),
            len(value["props"]),
            len(value["pickups"]),
            failure.get("id") or 0,
            tick(failure.get("tick")),
            optional(FAILURES, failure.get("reason")),
            optional(CAUSES, failure.get("cause")),
        )
    )
    assert len(result) == 56
    for item in value["pickups"]:
        result.extend(
            struct.pack(
                "<IIII",
                item["id"],
                PICKUPS.index(item["status"]),
                tick(item["resolvedTick"]),
                item["claimedBy"] or 0,
            )
        )
    for prop in value["props"]:
        result.extend(
            struct.pack(
                "<IIIIII",
                prop["id"],
                prop["definitionId"],
                prop["health"],
                tick(prop["destroyedTick"]),
                prop["destroyerId"] or 0,
                prop["destroyActionId"] or 0,
            )
        )
    for member in value["members"]:
        flags = (
            int(member["required"])
            | int(member["critical"]) << 1
            | int(member["retreatAllowed"]) << 2
        )
        result.extend(
            struct.pack(
                "<IIIIIIII",
                member["id"],
                flags,
                STATUSES.index(member["status"]),
                tick(member["activatedTick"]),
                tick(member["resolvedTick"]),
                optional(RESOLUTIONS, member["reason"]),
                member["killerId"] or 0,
                0,
            )
        )
    for objective in value["objectives"]:
        result.extend(
            struct.pack("<II", objective["id"], tick(objective["completedTick"]))
        )
    for credit in value["kills"]:
        result.extend(struct.pack("<II", credit["playerId"], credit["count"]))
    for volume in value["volumes"]:
        result.extend(
            struct.pack(
                "<IIIIIIiiIIIHH",
                volume["id"],
                volume["ownerId"],
                volume["actionInstanceId"],
                volume["definitionId"],
                volume["spawnTick"],
                volume["endTick"],
                volume["rect"]["x"],
                volume["rect"]["y"],
                volume["rect"]["w"],
                volume["rect"]["h"],
                volume["heading"],
                volume["lobe"],
                int(volume["attached"]),
            )
        )
    return bytes(result)


def update(path, entries, write):
    if write:
        path.write_text(json.dumps(entries, indent=2) + "\n")
    else:
        assert json.loads(path.read_text()) == entries, (
            f"Stale protocol fixtures: {path}"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    write = parser.parse_args().write
    path = DIRECTORY / "combat-golden.json"
    cases = json.loads(path.read_text())
    if not any(case["name"] == "material-steel-laser" for case in cases):
        material = copy.deepcopy(cases[0])
        material["name"] = "material-steel-laser"
        material["combat"]["props"] = [
            {
                "id": 200,
                "definitionId": 12,
                "health": 8,
                "destroyedTick": None,
                "destroyerId": None,
                "destroyActionId": None,
            }
        ]
        cases.append(material)
    scenario_ids = {
        "pending": 1,
        "complete": 1,
        "one-attached-flame-lobe": 7,
        "individual-supplies": 14,
        "material-steel-laser": 59,
    }
    for case in cases:
        case["combat"]["scenarioId"] = scenario_ids[case["name"]]
        data = combat_bytes(case["combat"])
        case["hex"] = data.hex()
        case["byteLength"] = len(data)
    update(path, cases, write)
    for filename in ["snapshot-golden.json", "input-golden.json"]:
        path = DIRECTORY / filename
        entries = json.loads(path.read_text())
        for entry in entries:
            data = bytearray.fromhex(entry["hex"])
            assert data[:3] == b"EF\x03"
            assert data[3] in (13, 14)
            assert entry.get("snapshot", {}).get("combat") is None
            data[3] = 14
            entry["hex"] = data.hex()
        update(path, entries, write)
    print(
        json.dumps(
            {
                "combatSections": len(cases),
                "section": 5,
                "protocol": "3.14",
                "status": "written" if write else "pass",
            }
        )
    )


if __name__ == "__main__":
    main()
