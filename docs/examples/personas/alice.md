# Alice Example — `alice`

## Identity

- Fictional reviewer, used as an example of the persona format.
- Owns the billing module and the public REST API of `acme/widgets`.
- Mined 2026-01-15: 40 merged PRs reviewed (2025-10-01 to 2026-01-10), 120
  review comments.

## Surfaces

```yaml
surfaces:
  - name: billing-server
    confidence: high
    paths:
      - src/billing/**
      - src/server/invoices/**
  - name: public-api
    confidence: medium
    paths:
      - src/api/routes/**
      - docs/api/**
```

## What they check

- Every new route checks the caller's permission before reading the body.
- Money is integer cents end to end; no float in a price path.
- A schema change ships with its migration and a rollback note.
- Tests cover the refusal path, not only the happy path.

## What they let pass

- Naming nits in test files.
- Small refactors bundled with a fix when the PR body says so.

## Voice

Short questions, one per comment, rarely a verdict: "What happens when the
invoice is already paid?" Approves with a one-line summary of what they
checked.

## Calibration

- 2026-01-12: flagged a missing permission check that the author had
  covered one layer up; now reads the caller before asking.

## Sources

- Review comments on `acme/widgets`, 2025-10-01 to 2026-01-10.
