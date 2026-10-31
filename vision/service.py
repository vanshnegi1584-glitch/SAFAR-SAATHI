"""Local bridge: Rahul/backend POST numbers; CV POST numbers; backend GET fusion."""
import os
import threading
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from fusion import FusionConfig, fuse

app = FastAPI(title="SafarSaathi Vision Fusion", version="0.1.0")
CAPACITY = int(os.environ.get("VISION_CAPACITY", "40"))
BUS_ID = os.environ.get("VISION_BUS_ID", "14")
config = FusionConfig(capacity=CAPACITY)
lock = threading.Lock()
state = {"telemetry": None, "visual": None}


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

    @model_validator(mode="after")
    def seat_pair(self):
        if (self.seats_free is None) != (self.seats_total is None):
            raise ValueError("Send both seat fields or neither")
        if self.seats_free is not None and self.seats_free > self.seats_total:
            raise ValueError("seats_free exceeds seats_total")
        return self


def ingest(key, item):
    if item.bus_id != BUS_ID:
        raise HTTPException(400, "Bus ID does not match configured bus")
    if not 0 <= time.time() - item.timestamp <= config.max_age:
        raise HTTPException(400, "Stale or future timestamp; synchronize clocks")
    with lock:
        previous = state[key]
        if previous and item.timestamp <= previous["timestamp"]:
            raise HTTPException(409, "Out-of-order observation")
        state[key] = item.model_dump(exclude_none=True)
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
        result = fuse(state["telemetry"], state["visual"], config)
    return {"bus_id": BUS_ID, **result}


@app.get("/health")
def health():
    return {"status": "ok", "bus_id": BUS_ID, "capacity": CAPACITY}
