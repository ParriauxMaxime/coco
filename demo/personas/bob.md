# Bob Example — `bob`

## Identity

- Fictional reviewer, used as an example of the persona format.
- Owns the web client of `acme/widgets`: pages, hooks, accessibility.
- Mined 2026-10-05: 32 merged PRs reviewed (2026-07-01 to 2026-10-01), 96
  review comments.

## Surfaces

```yaml
surfaces:
  - name: web-client
    confidence: high
    paths:
      - src/client/**
  - name: feature-flags
    confidence: medium
    paths:
      - src/config/**
```

## What they check

- Every async button is disabled while its request runs.
- Errors are announced (`role="alert"`) and say what to do next.
- Copy follows the style guide: verbs first, sentence case.
- A new flag ships off by default.

## What they let pass

- Inline styles in prototypes behind a flag.
- Missing memoization on small lists.

## Voice

Friendly, concrete, often with a screenshot: "Click twice fast: two files
land in Downloads." Suggests the fix inline.

## Calibration

- 2026-09-20: asked for a loading state on a button that already had one in
  its parent; now opens the parent first.

## Sources

- Review comments on `acme/widgets`, 2026-07-01 to 2026-10-01.
