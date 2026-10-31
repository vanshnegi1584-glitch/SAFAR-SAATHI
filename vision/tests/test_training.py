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


def roboflow_export(root, classes=("Occupied", "Unoccupied")):
    """A tiny export laid out like Roboflow's 'YOLOv8' download."""
    for folder, value in (("train", 10), ("valid", 90), ("test", 170)):
        (root / folder / "images").mkdir(parents=True)
        (root / folder / "labels").mkdir(parents=True)
        cv2.imwrite(str(root / folder / "images" / f"bus_{folder}_jpg.rf.abc.jpg"), np.full((32, 32, 3), value, np.uint8))
        (root / folder / "labels" / f"bus_{folder}_jpg.rf.abc.txt").write_text("0 0.5 0.5 0.2 0.2\n1 0.2 0.2 0.1 0.1\n")
    (root / "data.yaml").write_text("train: ../train/images\nval: ../valid/images\ntest: ../test/images\n"
                                    f"nc: {len(classes)}\nnames: {list(classes)}\n")
    return root


def test_import_roboflow_export_remaps_and_merges(tmp_path):
    import zipfile
    from train import check_dataset, import_export, parse_mapping, safe_extract
    export = roboflow_export(tmp_path / "export")
    archive = tmp_path / "inside-bus-view.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in export.rglob("*"):
            zf.write(f, f.relative_to(export))
    folder = safe_extract(archive, tmp_path / "unzipped")
    names, out = ["occupied_seat", "empty_seat"], tmp_path / "seats"
    report = import_export(folder, "insidebus", parse_mapping("Occupied=empty_seat,Unoccupied=occupied_seat"), names, out)
    assert report["images"] == {"train": 1, "val": 1, "test": 1} and report["boxes"] == {"occupied_seat": 3, "empty_seat": 3}
    label = (out / "labels" / "val" / "insidebus__bus_valid_jpg.rf.abc.txt").read_text().splitlines()
    assert label[0].startswith("1 ") and label[1].startswith("0 ")  # classes renamed by name, not by index
    second = roboflow_export(tmp_path / "vista", classes=("Occupied", "Unoccupied"))
    for split, value in (("train", 210), ("valid", 220), ("test", 230)):  # distinct pixels: no false leakage
        img = next((second / split / "images").iterdir())
        cv2.imwrite(str(img), np.full((32, 32, 3), value, np.uint8))
    import_export(second, "vista", parse_mapping("Occupied=occupied_seat,Unoccupied=empty_seat"), names, out)
    assert check_dataset(out / "data.yaml")["splits"]["train"]["images"] == 2
    with pytest.raises(ValueError, match="already contains 'vista'"):
        import_export(second, "vista", parse_mapping("Occupied=occupied_seat,Unoccupied=empty_seat"), names, out)
    with pytest.raises(ValueError, match="No --map entry"):
        import_export(second, "other", parse_mapping("Occupied=occupied_seat"), names, tmp_path / "x")


def test_zip_cannot_write_outside_its_folder(tmp_path):
    import zipfile
    from train import safe_extract
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../escaped.txt", "x")
    with pytest.raises(ValueError, match="escapes"):
        safe_extract(archive, tmp_path / "out")
    assert not (tmp_path / "escaped.txt").exists()


def test_import_converts_polygon_rows_and_leaves_nothing_on_error(tmp_path):
    from train import import_export, parse_mapping, read_export_label
    label = tmp_path / "a.txt"
    label.write_text("1 0.2 0.2 0.4 0.2 0.4 0.6 0.2 0.6\n0 0.5 0.5 0.1 0.1\n")
    rows, converted = read_export_label(label, 2)
    assert converted == 1 and np.allclose(rows[0], (1, 0.3, 0.4, 0.2, 0.4)) and rows[1] == (0, .5, .5, .1, .1)
    export = roboflow_export(tmp_path / "export")
    (export / "test" / "labels" / "bus_test_jpg.rf.abc.txt").write_text("0 0.5 0.5\n")  # broken file, last split
    with pytest.raises(ValueError, match="expected"):
        import_export(export, "x", parse_mapping("Occupied=occupied_seat,Unoccupied=empty_seat"),
                      ["occupied_seat", "empty_seat"], tmp_path / "out")
    assert not (tmp_path / "out").exists()  # validated first: no partial copy


def test_resplit_groups_near_duplicates_and_augmented_copies():
    from train import leakage_report, near_duplicate_groups, original_name
    assert original_name("vista__IMG_0042_jpg.rf.9f8e7d.jpg") == original_name("vista__IMG_0042_jpg.rf.123abc.jpg") == "IMG_0042"
    rng = np.random.default_rng(0)
    a = rng.integers(0, 2, 256).astype(bool)
    a_next = a.copy(); a_next[:5] = ~a_next[:5]           # next video frame: 5 bits differ
    b = rng.integers(0, 2, 256).astype(bool)               # unrelated scene
    flipped = rng.integers(0, 2, 256).astype(bool)         # augmented copy of b: hash unrelated, same original
    hashes = [a, a_next, b, flipped, a.copy()]
    sources = ["insidebus", "insidebus", "vista", "vista", "vista"]
    originals = ["f1", "f2", "IMG_7", "IMG_7", "other"]
    groups = near_duplicate_groups(hashes, sources, 20, originals)
    assert groups[0] == groups[1] and groups[2] == groups[3] and groups[0] != groups[2]
    assert groups[4] != groups[0]  # same pixels but another source: kept apart (different buses)
    report = leakage_report(hashes, ["train", "test", "train", "val", "train"], sources)
    assert report["test/insidebus"]["near_duplicate_of_train_percent"] == 100.0
