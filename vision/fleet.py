"""Bus fleet configuration from the transport schedule: seats (capacity) per bus, no personal data."""
import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_FLEET = ROOT / "fleet.json"
FALLBACK_CAPACITY = 40
# Driver names and phone numbers in the schedule are personal data and are never copied.
REQUIRED = ("Bus No.", "Reg. No.", "Shift Timing", "Route", "Seats")


def build(schedule_path):
    """Read the schedule CSV and return {"source", "buses": {bus_no: {...}}}."""
    with open(schedule_path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError("Schedule has no rows")
    missing = [c for c in REQUIRED if c not in rows[0]]
    if missing:
        raise ValueError(f"Schedule is missing columns: {', '.join(missing)}")
    buses = {}
    for row in rows:
        ref = row.get("S.No.", "?").strip()
        bus, seats = row["Bus No."].strip(), row["Seats"].strip()
        if not bus:
            raise ValueError(f"Row {ref}: missing bus number")
        if not seats.isdigit() or not 1 <= int(seats) <= 200:
            raise ValueError(f"Row {ref} (bus {bus}): seats must be a whole number from 1 to 200, got {seats!r}")
        if bus in buses:
            raise ValueError(f"Bus {bus} appears twice in the schedule")
        buses[bus] = {"registration": " ".join(row["Reg. No."].split()),
                      "route": " ".join(row["Route"].split()),
                      "shift": " ".join(row["Shift Timing"].split()),
                      "seats": int(seats)}
    return {"source": Path(schedule_path).name, "buses": buses}


def load_fleet(path=DEFAULT_FLEET):
    """Return the fleet dict, or None when the file does not exist."""
    path = Path(path)
    if not path.is_file():
        return None
    fleet = json.loads(path.read_text(encoding="utf-8"))
    buses = fleet.get("buses")
    if not isinstance(buses, dict) or not all(type(b.get("seats")) is int and b["seats"] > 0 for b in buses.values()):
        raise ValueError(f"{path.name}: every bus needs a positive integer 'seats'")
    return fleet


def capacity_for(fleet, bus):
    return (fleet or {}).get("buses", {}).get(str(bus).strip(), {}).get("seats")


def resolve_capacity(cli, seatmap_capacity, fleet_capacity, bus):
    """Pick the bus capacity and say where it came from.

    --capacity always wins. Otherwise a seat map and the fleet file must agree, so a map
    calibrated for one bus cannot silently be used on a bus with a different seat count.
    """
    if cli:
        return cli, "--capacity"
    if seatmap_capacity and fleet_capacity and seatmap_capacity != fleet_capacity:
        raise ValueError(f"Seat map says capacity {seatmap_capacity}, but the fleet file says bus {bus} has "
                         f"{fleet_capacity} seats. Use the right map, recalibrate, or pass --capacity")
    if seatmap_capacity:
        return seatmap_capacity, "seat map"
    if fleet_capacity:
        return fleet_capacity, f"fleet file (bus {bus})"
    return FALLBACK_CAPACITY, f"default {FALLBACK_CAPACITY} (bus {bus} not in a fleet file)"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    subs = p.add_subparsers(dest="command", required=True)
    b = subs.add_parser("build", help="Create fleet.json from the transport schedule CSV")
    b.add_argument("--schedule", required=True)
    b.add_argument("--output", default=str(DEFAULT_FLEET))
    s = subs.add_parser("show", help="Print one bus (or a summary)")
    s.add_argument("--bus")
    s.add_argument("--fleet", default=str(DEFAULT_FLEET))
    args = p.parse_args()
    try:
        if args.command == "build":
            fleet = build(args.schedule)
            Path(args.output).write_text(json.dumps(fleet, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            seats = [b["seats"] for b in fleet["buses"].values()]
            print(f"Wrote {args.output}: {len(seats)} buses, {min(seats)}-{max(seats)} seats each, {sum(seats)} in total. "
                  "Driver names and phone numbers were not copied.")
        else:
            fleet = load_fleet(args.fleet)
            if fleet is None:
                raise ValueError(f"No fleet file at {args.fleet}; run: python fleet.py build --schedule <csv>")
            if args.bus:
                bus = fleet["buses"].get(args.bus)
                if bus is None:
                    raise ValueError(f"Bus {args.bus} is not in {args.fleet}")
                print(json.dumps({"bus": args.bus, **bus}, indent=2, ensure_ascii=False))
            else:
                for no, bus in sorted(fleet["buses"].items(), key=lambda kv: (len(kv[0]), kv[0])):
                    print(f"bus {no:>4}: {bus['seats']:>3} seats | {bus['shift']} | {bus['route']}")
    except (ValueError, OSError, KeyError) as exc:
        p.error(str(exc))


if __name__ == "__main__":
    main()
