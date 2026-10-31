"""Pure sensor-fusion policy; does not command hardware or invent unseen seats."""
from dataclasses import dataclass
import math
import time


@dataclass(frozen=True)
class FusionConfig:
    capacity: int = 40
    deviation_threshold: int = 3
    stationary_kmh: float = 1.0
    max_age: float = 10.0


def fuse(telemetry, visual, config=FusionConfig(), now=None):
    now = time.time() if now is None else now
    capacity = config.capacity
    if capacity < 1:
        raise ValueError("capacity must be positive")

    def fresh(item):
        stamp = item.get("timestamp") if isinstance(item, dict) else None
        return type(stamp) in (int, float) and math.isfinite(stamp) and 0 <= now - stamp <= config.max_age

    ir_valid = fresh(telemetry)
    if ir_valid:
        pax = telemetry.get("pax", {}).get("net_current")
        speed = telemetry.get("gps", {}).get("speed")
        sats = telemetry.get("gps", {}).get("sats", 0)
        ir_valid = type(pax) is int and 0 <= pax <= capacity * 2
        motion_known = (type(speed) in (int, float) and math.isfinite(speed)
                        and speed >= 0 and type(sats) is int and sats >= 4)
    else:
        motion_known = False
    cv_valid = fresh(visual)
    if cv_valid:
        free, total = visual.get("seats_free"), visual.get("seats_total")
        cv_valid = type(free) is int and type(total) is int and 0 <= free <= total <= capacity and total > 0
    full_cv = cv_valid and total == capacity
    expected = max(0, capacity - pax) if ir_valid else None
    deviation = abs(expected - free) if ir_valid and full_cv else None
    high = deviation is not None and deviation > config.deviation_threshold
    stationary = motion_known and speed <= config.stationary_kmh
    source, available = "unavailable", None
    if ir_valid:
        source, available = "ir", expected
        if high and stationary:
            source, available = "camera", free
    elif full_cv:
        source, available = "camera", free
    return {"timestamp": now, "seats_free": available, "capacity": capacity,
            "source": source, "expected_empty": expected,
            "visual_empty_seats": free if cv_valid else None,
            "visual_seats_total": total if cv_valid else None,
            "deviation": deviation, "recalibration_required": high,
            "motion": "stationary" if stationary else "moving" if motion_known else "unknown",
            "reason": "partial_camera_coverage" if cv_valid and not full_cv else
                      "sensor_disagreement" if high else "normal" if available is not None else "stale_or_missing_data"}
