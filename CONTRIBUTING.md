# Contributing

Use Node.js 22 and install with `npm ci`.

## Boundaries to preserve

- Keep corpus policy, adapters, ingestion, chunking, ranking, retrieval selection, provenance, and
  domain readiness in this capability.
- Keep generic application startup, transports, authentication, OpenAPI, registry behavior, error
  projection, lifecycle state, readiness aggregation, and shutdown in Agent Tool Platform.
- One process serves one read-only corpus and authorization boundary.
- Document Optimizer prepares agent-native documents; Doc RAG only indexes and retrieves an already
  prepared corpus.

## Non-negotiables

Do not weaken corpus isolation, read-only behavior, input validation, ingestion/retrieval limits,
provenance, insufficient-context behavior, or tests. This capability must never generate, mutate,
fetch arbitrary URLs, accept uploads, or silently call process liveness retrieval readiness.

Every schema field is bounded. Requests cannot raise corpus, index, or retrieval ceilings.

## Changing retrieval

Ranking changes require `npm run eval:retrieval` and must keep
[`tests/retrieval/evaluation.test.ts`](tests/retrieval/evaluation.test.ts) green. Add positive and
`no_match` fixtures together; improving recall by inventing evidence is a regression.

## Before opening a pull request

Run the full validation list in [`README.md`](README.md). Never commit corpora, generated indexes,
deployment outputs, credentials, provider account details, or invented endpoints.
