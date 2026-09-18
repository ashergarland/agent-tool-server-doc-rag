# D4 migration boundary

This repository migrated from a self-hosted application shell to the thin-capability shape from
`ashergarland/agent-tool-server-template@4b5a5d93c99614a6ca64d65e10f56918c45f1472`.

Agent Tool Platform is pinned to
`ashergarland/agent-tool-platform@98ec8162fb11d5c04aee9e6f7b3625a472a0180d`.

## Preserved capability behavior

- filesystem corpus adapter and shared admission policy;
- shared corpus admission and isolation policy;
- bounded ingestion and format-aware chunking;
- BM25/TF-IDF lexical index and score calibration;
- atomic index swaps, last-good retention, refresh, and safe lifecycle events;
- result selection, deduplication, diversity, deadlines, and output budgets;
- provenance, citations, explicit no-match/unavailable/degraded states;
- deterministic retrieval and routing evaluations.

## Replaced by Platform

- application assembly and entrypoint signal handling;
- custom HTTP, MCP, OpenAPI, authentication, rate limiting, and error adapters;
- custom tool registry and transport-parity machinery;
- generic readiness aggregation and lifecycle state;
- metadata/deployment validators;
- copied CI, security, package, and release job mechanics;
- generic hosted container and infrastructure scaffolding.

The Azure Blob adapter was not retained as an undeclared compatibility path. Platform's
provider-backed profile contract requires named secrets, scoped RBAC, and identity verification;
inventing those for the old `DefaultAzureCredential` behavior would have made the profile
fictional. The truthful working profile is the local filesystem corpus.

Domain readiness remains capability-owned as the `corpus-index` contributor. Platform aggregates
and publishes that result without deciding whether a corpus is useful.
