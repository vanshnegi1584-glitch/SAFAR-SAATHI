"""Training pipeline checks on tiny generated files (no model training here)."""
from pathlib import Path
import sys

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from train import assign_splits, check_dataset, labels_for, match, parse_label, scores, trip_of, write_data_yaml


def test_whole_trips_go_to_one_split():
    groups = {f"trip{i}": 10 for i in range(10)}
    assignment, counts = assign_splits(groups, val=0.15, test=0.15, seed=1)
    assert set(assignment) == set(groups) and sum(counts.values()) == 100
    assert all(counts[s] > 0 for s in ("train", "val", "test"))
    assert assign_splits(groups, seed=1) == (assignment, counts)  # reproducible
    with pytest.raises(ValueError, match="Not enough trips"):
        assign_splits({"only_trip": 50})
    assert trip_of("busA_morning__f0000120.jpg") == "busA_morning" and trip_of("IMG_001.jpg") is None


def test_label_parsing_rejects_bad_lines(tmp_path):
    good = tmp_path / "a.txt"
    good.write_text("0 0.5 0.5 0.2 0.4\n\n1 0.1 0.9 0.05 0.1\n")
    assert parse_label(good, 2) == [(0, .5, .5, .2, .4), (1, .1, .9, .05, .1)]
    for text, message in [("2 0.5 0.5 0.1 0.1", "class 2"), ("0 1.5 0.5 0.1 0.1", "normalised"),
                          ("0 0.5 0.5 0.1", "expected"), ("x 0.5 0.5 0.1 0.1", "not numbers")]:
        bad = tmp_path / "b.txt"
        bad.write_text(text)
        with pytest.raises(ValueError, match=message):
            parse_label(bad, 2)


def make_dataset(root, duplicate=False, no_seats=False):
    for split, trip in (("train", 0), ("val", 1), ("test", 2)):
        (root / "images" / split).mkdir(parents=True)
        (root / "labels" / split).mkdir(parents=True)
        image = np.full((40, 40, 3), 0 if duplicate else 50 * trip, np.uint8)
        cv2.imwrite(str(root / "images" / split / f"trip{trip}__f0.png"), image)
        label = "0 0.5 0.5 0.4 0.8" if no_seats else "0 0.5 0.5 0.4 0.8\n1 0.2 0.8 0.2 0.2"
        (root / "labels" / split / f"trip{trip}__f0.txt").write_text(label)
    write_data_yaml(root, ["person", "seat"])
    return root / "data.yaml"


def test_check_passes_and_counts(tmp_path):
    report = check_dataset(make_dataset(tmp_path))
    assert report["splits"]["train"]["instances"] == {"person": 1, "seat": 1}


@pytest.mark.parametrize("kwargs, message", [({"duplicate": True}, "leakage"), ({"no_seats": True}, "no 'seat' boxes")])
def test_check_finds_leakage_and_missing_classes(tmp_path, kwargs, message):
    with pytest.raises(ValueError, match=message):
        check_dataset(make_dataset(tmp_path, **kwargs))


def test_labels_folder_and_matching():
    assert labels_for(Path("D:/images/x/datasets/bus/images/train")) == Path("D:/images/x/datasets/bus/labels/train")
    preds = [(0, [0, 0, 10, 10], .9), (0, [0, 0, 10, 10], .8), (1, [50, 50, 60, 60], .7)]
    truths = [(0, [1, 1, 10, 10]), (1, [0, 0, 5, 5])]
    assert match(preds, truths) == {0: [1, 1, 0], 1: [0, 1, 1]}  # duplicate box is a false positive
    assert scores(1, 1, 0) == {"tp": 1, "fp": 1, "fn": 0, "precision": .5, "recall": 1.0, "f1": .667}
