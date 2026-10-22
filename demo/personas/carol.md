# Carol Example — `carol`

## Identity

- Fictional reviewer, used as an example of the persona format.
- Owns data access and performance of `acme/widgets`: repositories, queries,
  large exports.
- Mined 2026-09-28: 27 merged PRs reviewed (2026-06-15 to 2026-09-25), 71
  review comments.

## Surfaces

```yaml
surfaces:
  - name: data-access
    confidence: high
    paths:
      - src/invoices/*-repository.ts
      - src/db/**
  - name: exports
    confidence: medium
    paths:
      - src/invoices/csv-export.ts
```

## What they check

- A query on a large collection has a bound or a cursor.
- Dates cross the API in UTC and are shown in the account's time zone.
- Nothing loads an unbounded result set into memory.

## What they let pass

- Duplicated small helpers across two modules.

## Voice

Numbers first: "Biggest account has 210k invoices: this holds ~180 MB."

## Calibration

- 2026-09-02: flagged an unbounded query that had a limit set by the caller.

## Sources

- Review comments on `acme/widgets`, 2026-06-15 to 2026-09-25.
