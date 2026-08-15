# Contributing

Use Node.js 22 and install with `npm ci`.

## Boundaries to preserve

- Transports contain no retrieval or corpus logic; every transport uses the shared `ToolRegistry`.
- The corpus port, index lifecycle, and measurement helpers contain no ranking-specific code. These
  boundaries are evidence for a later cross-repository extraction, so keep them clean.
- Services never import SDK types; corpus adapters translate external failures into safe errors.
- One process serves one corpus and one authorization boundary.

## Non-negotiables

Do not weaken corpus isolation, read-only behavior, input validation, ingestion or retrieval limits,
authentication, provenance, or tests. This server retrieves evidence and must never generate,
mutate, fetch arbitrary URLs, or accept uploads.

Every new schema field must be bounded. Every new limit must be deployment-configured and impossible
to raise from a request.

## Changing retrieval

Ranking changes must be justified by `npm run eval:retrieval` and must keep the gates in
`tests/retrieval/evaluation.test.ts` passing. Add fixture cases for new behavior, including
`no_match` cases — a change that improves recall while inventing evidence is a regression.

## Before opening a pull request

Run the full validation list in `README.md`. Never commit `.env` files, corpora, generated indexes,
deployment outputs, credentials, tenant or subscription identifiers, or invented package and
endpoint metadata.
