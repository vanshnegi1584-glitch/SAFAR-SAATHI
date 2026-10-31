"""Local bridge: Rahul/backend POST numbers; CV POST numbers; backend GET fusion."""
import os
import threading
import time
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from fleet import FALLBACK_CAPACITY, capacity_for, load_fleet
from fusion import FusionConfig, fuse, merge_cameras

app = FastAPI(title="SafarSaathi Vision Fusion", version="0.1.0")
BUS_ID = os.environ.get("VISION_BUS_ID", "14")
# VISION_CAPACITY wins; otherwise this bus's seats from fleet.json (built from the schedule).
CAPACITY = int(os.environ.get("VISION_CAPACITY") or capacity_for(load_fleet(), BUS_ID) or FALLBACK_CAPACITY)
config = FusionConfig(capacity=CAPACITY)
lock = threading.Lock()
state = {"telemetry": None, "visual": {}}  # visual: camera_id -> latest observation


class NumbersOnly(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class GPS(NumbersOnly):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    speed: float = Field(ge=0, le=300)
    sats: int = Field(ge=0, le=100)


class Pax(NumbersOnly):
    in_count: int = Field(ge=0)
    out_count: int = Field(ge=0)
    net_current: int = Field(ge=0, le=CAPACITY * 2)


class Telemetry(NumbersOnly):
    bus_id: str
    timestamp: float
    gps: GPS
    pax: Pax
    sos_active: bool = False


class Visual(NumbersOnly):
    bus_id: str
    timestamp: float
    count: int = Field(ge=0, le=CAPACITY * 2)
    seats_free: int | None = Field(default=None, ge=0)
    seats_total: int | None = Field(default=None, ge=1, le=CAPACITY)
    # Optional, backward-compatible: partial coverage and multi-camera merging.
    camera_id: str = Field(default="main", pattern=r"^[A-Za-z0-9_-]{1,32}$")
    seats_unknown: int | None = Field(default=None, ge=0, le=CAPACITY)
    seats_mapped: int | None = Field(default=None, ge=1, le=CAPACITY)
    seat_states: dict[str, Literal["occupied", "empty", "unknown"]] | None = Field(default=None, max_length=CAPACITY)

    @model_validator(mode="after")
    def seat_pair(self):
        if (self.seats_free is None) != (self.seats_total is None):
            raise ValueError("Send both seat fields or neither")
        if self.seats_free is not None and self.seats_free > self.seats_total:
            raise ValueError("seats_free exceeds seats_total")
        if (self.seats_unknown is None) != (self.seats_mapped is None):
            raise ValueError("Send both seats_unknown and seats_mapped or neither")
        if self.seats_mapped is not None and self.seats_mapped != (self.seats_total or 0) + self.seats_unknown:
            raise ValueError("seats_mapped must equal seats_total + seats_unknown")
        if self.seat_states is not None:
            if self.seats_mapped is None or not all(k.isdigit() and int(k) > 0 for k in self.seat_states):
                raise ValueError("seat_states needs positive integer seat IDs and seats_mapped")
            values = list(self.seat_states.values())
            if (len(values) != self.seats_mapped or values.count("unknown") != self.seats_unknown
                    or values.count("empty") != (self.seats_free or 0)):
                raise ValueError("seat_states disagree with the seat counts")
        return self


def ingest(key, item):
    if item.bus_id != BUS_ID:
        raise HTTPException(400, "Bus ID does not match configured bus")
    if not 0 <= time.time() - item.timestamp <= config.max_age:
        raise HTTPException(400, "Stale or future timestamp; synchronize clocks")
    with lock:
        slots = state["visual"] if key == "visual" else state
        slot = item.camera_id if key == "visual" else key
        previous = slots.get(slot)
        if previous and item.timestamp <= previous["timestamp"]:
            raise HTTPException(409, "Out-of-order observation")
        slots[slot] = item.model_dump(exclude_none=True)
    return {"accepted": True}


@app.post("/telemetry")
def telemetry(item: Telemetry):
    return ingest("telemetry", item)


@app.post("/vision")
def vision(item: Visual):
    return ingest("visual", item)


@app.get("/fusion")
def fusion():
    with lock:
        visual = merge_cameras(list(state["visual"].values()), config.max_age)
        result = fuse(state["telemetry"], visual, config)
    return {"bus_id": BUS_ID, **result, "cameras": visual.get("cameras", 1) if visual else 0}


@app.get("/health")
def health():
    return {"status": "ok", "bus_id": BUS_ID, "capacity": CAPACITY}
