# AI Agent Room — Example Workflow

## User Prompt

```text
@planner Build a small Python CLI that reads a CSV file and prints total revenue by product.
```

## Agent Handoffs

1. `@planner` writes a plan and hands off to `@coder`
2. `@coder` creates the CLI files in `src/`
3. `@reviewer` checks the implementation and writes review notes
4. `@scribe` summarizes the result for the user

## Example Workspace Output

```text
README.md
plan.md
src/
  revenue_cli.py
  sample.csv
notes/
  review.md
  summary.md
```

## Example File Contents

### `plan.md`

```md
# Revenue CLI Plan

1. Parse a CSV file with `csv.DictReader`
2. Aggregate revenue by product name
3. Print sorted totals to stdout
4. Include a sample CSV for quick verification

@coder Implement the CLI in `src/revenue_cli.py` and add `src/sample.csv`.
```

### `src/revenue_cli.py`

```python
import csv
import sys
from collections import defaultdict


def main(path: str) -> None:
    totals = defaultdict(float)
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            totals[row["product"]] += float(row["revenue"])

    for product, total in sorted(totals.items()):
        print(f"{product}: {total:.2f}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python revenue_cli.py <csv-file>")
    main(sys.argv[1])
```

### `notes/review.md`

```md
# Review Notes

- The CLI uses standard library only.
- Input columns expected: `product`, `revenue`.
- A next improvement would be handling malformed numeric values more gracefully.
```

### `notes/summary.md`

```md
# Summary

The room produced a working revenue aggregation CLI, a sample CSV, and review notes.
Use `python src/revenue_cli.py src/sample.csv` to test the output.
```