#!/usr/bin/env python
"""
Export ModelBenchmark_v4.xlsx -> the pipeline's JSON inputs (and golden snapshots).

This is the bridge that makes manual edits in the spreadsheet flow into the
dashboard: fill in cells (e.g. the sparse AA-Omni / APEX / AA-Coding columns for
the models you care about), then run this and `npm run refresh`.

Run via uv (system pip is PEP-668 blocked here):
    uvx --with openpyxl python scripts/export-from-xlsx.py
or just:
    npm run export

Writes:
    data/benchmark-inputs.json   (Inputs sheet  -> Score v2 raw benches)
    data/values-inputs.json      (Values sheet  -> PERF/COST raw benches)
    data/golden.json             (Score v2 + Values computed cells, frozen check)

NOTE on golden: the golden files snapshot the xlsx's OWN computed formula cells,
so `npm run verify` proves the JS port still reproduces them. openpyxl can only
read those if Excel/LibreOffice cached them on save — if you edit with something
that doesn't recompute, the golden cells come back blank and we warn instead of
writing zeros.
"""
import json
import os
import sys
import glob

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl not available — run via `uvx --with openpyxl python scripts/export-from-xlsx.py`")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = next(iter(glob.glob(os.path.join(ROOT, "ModelBenchmark_v4.xlsx"))), None)
if not XLSX:
    sys.exit("ModelBenchmark_v4.xlsx not found at repo root")


def cell(ws, r, c):
    return ws.cell(r, c).value


def all_rows(ws, key_col, start=2):
    """Yield all row indices with non-empty key_col (handles gaps)."""
    found = 0
    for r in range(start, ws.max_row + 1):
        v = cell(ws, r, key_col)
        if v is not None and v != "":
            found += 1
            yield r
    # Warn if we found fewer than max_row - start would suggest (formulas not cached)
    if found == 0:
        pass  # caller will warn


def write(rel, obj):
    path = os.path.join(ROOT, rel)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
        f.write("\n")
    print(f"  wrote {rel}")


def main():
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    warnings = []

    # ---- Inputs sheet (cols A..P, V..X) -> benchmark-inputs.json ----
    # Columns Q..U (the per-subscription on* availability flags) are not
    # exported: coverage lives in config.paths[].models, see
    # scripts/migrate-path-coverage.js and src/lib/path-coverage.js.
    ws = wb["Inputs"]
    INPUT_COLS = [
        ("model", 1), ("gdpval", 2), ("terminalBench", 3), ("tau3Banking", 4),
        ("aaLcr", 5), ("aaOmni", 6), ("hle", 7), ("gpqa", 8), ("sciCode", 9),
        ("critPt", 10), ("apexAgents", 11), ("intRef", 12), ("cachePrice", 13),
        ("inputPrice", 14), ("outputPrice", 15), ("speed", 16),
        ("aaSlug", 22), ("aaCoding", 23), ("aaAgentic", 24),
    ]
    models = [{k: cell(ws, r, c) for k, c in INPUT_COLS} for r in all_rows(ws, 1)]
    write("data/benchmark-inputs.json", {"models": models})

    # ---- Values sheet -> values-inputs.json (+ golden cells, merged below) ----
    ws = wb["Values"]
    VAL_COLS = [
        ("model", 2), ("speed", 5), ("cache", 7), ("input", 8), ("output", 9),
        ("INT", 14), ("COD", 15), ("AGE", 16), ("GPQA", 17), ("HLE", 18),
        ("IFBench", 19), ("AA-LCR", 20), ("GDPval-AA", 21), ("SciCode", 22),
        ("Terminal", 23), ("AA-Omni", 24),
    ]
    values_inputs, values_golden = [], []
    for r in all_rows(ws, 2):
        values_inputs.append({k: cell(ws, r, c) for k, c in VAL_COLS})
        g = {"model": cell(ws, r, 2), "mtok": cell(ws, r, 10),
             "cost": cell(ws, r, 11), "perf": cell(ws, r, 12), "aver": cell(ws, r, 13)}
        values_golden.append(g)
        if g["perf"] is None:
            warnings.append(f"Values row {r} ({g['model']}): computed cells blank")
    write("data/values-inputs.json", values_inputs)

    # ---- Score v2 sheet -> golden.json (single golden file: Score v2 + Values) ----
    ws = wb["Score v2"]
    score_golden = []
    for r in all_rows(ws, 2):
        score_golden.append({
            "model": cell(ws, r, 2),
            "capTax": cell(ws, r, 14), "capHobby": cell(ws, r, 15),
            "valTax": cell(ws, r, 19), "valHobby": cell(ws, r, 22),
            "minCost": cell(ws, r, 17), "bestPath": cell(ws, r, 18),
            "tierTax": cell(ws, r, 21),
        })
        if score_golden[-1]["capTax"] is None:
            warnings.append(f"Score v2 row {r}: computed cells blank")
    write("data/golden.json", {"score": score_golden, "values": values_golden})

    print(f"exported {len(models)} input models, {len(values_inputs)} values rows, "
          f"{len(score_golden)} score-golden rows")
    if warnings:
        print("\n⚠ formula cells came back blank — open the xlsx in Excel/LibreOffice and "
              "Save once so cached values refresh, then re-run:")
        for w in warnings[:6]:
            print("   " + w)


if __name__ == "__main__":
    main()
