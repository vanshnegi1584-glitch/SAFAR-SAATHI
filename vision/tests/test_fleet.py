"""Fleet file from the transport schedule. Uses a small made-up schedule, not the real one."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fleet import FALLBACK_CAPACITY, build, capacity_for, load_fleet, resolve_capacity

SCHEDULE = ('﻿S.No.,Reg. No.,Bus No.,Shift Timing,Driver Name,Contact No.,Route,Seats\n'
            '1,UK00XX0001,18,7.00 AM   11.00 AM,Test Driver,9000000001,A- B- Geu,41\n'
            '2,UK00XX0002,108,6.10 AM             No Service,Other Driver,9000000002,"C- D-\nGeu\n",57\n')


def test_build_keeps_seats_and_drops_personal_data(tmp_path):
    path = tmp_path / "schedule.csv"
    path.write_text(SCHEDULE, encoding="utf-8")
    fleet = build(path)
    assert fleet["buses"]["18"] == {"registration": "UK00XX0001", "route": "A- B- Geu",
                                    "shift": "7.00 AM 11.00 AM", "seats": 41}
    assert fleet["buses"]["108"]["route"] == "C- D- Geu" and fleet["buses"]["108"]["seats"] == 57
    text = json.dumps(fleet)
    assert "Driver" not in text and "9000000001" not in text


@pytest.mark.parametrize("bad, message", [
    (SCHEDULE.replace(",41\n", ",forty\n"), "seats must be"),
    (SCHEDULE.replace(",108,", ",18,"), "appears twice"),
    (SCHEDULE.replace("Seats", "Capacity"), "missing columns"),
])
def test_build_rejects_bad_rows(tmp_path, bad, message):
    path = tmp_path / "schedule.csv"
    path.write_text(bad, encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        build(path)


def test_capacity_lookup_and_precedence(tmp_path):
    path = tmp_path / "fleet.json"
    path.write_text(json.dumps({"buses": {"14": {"seats": 42}}}))
    fleet = load_fleet(path)
    assert capacity_for(fleet, "14") == 42 and capacity_for(fleet, "99") is None
    assert load_fleet(tmp_path / "missing.json") is None
    assert resolve_capacity(None, None, 42, "14")[0] == 42
    assert resolve_capacity(50, 45, 42, "14")[0] == 50  # --capacity always wins
    assert resolve_capacity(None, 42, 42, "14")[0] == 42
    with pytest.raises(ValueError, match="fleet file says bus 14 has 42"):
        resolve_capacity(None, 45, 42, "14")  # map made for another bus
    assert resolve_capacity(None, None, None, "99")[0] == FALLBACK_CAPACITY
