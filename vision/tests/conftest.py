import os

# Bridge tests use a fixed 40-seat bus, independent of whatever fleet.json says about bus 14.
os.environ.setdefault("VISION_CAPACITY", "40")
