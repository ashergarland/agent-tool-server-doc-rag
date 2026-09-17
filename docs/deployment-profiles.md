# Capability profile

The canonical declaration is [`../capability-profiles.json`](../capability-profiles.json). It uses
Agent Tool Platform deployment contract v1 at revision
`98ec8162fb11d5c04aee9e6f7b3625a472a0180d`.

## Local filesystem profile

`local-filesystem-package` runs the published package over stdio and reads one selected filesystem
root. The process opens no listener, needs no cloud account or provider credential, and changes no
state.

The corpus is a session workload. Indexing starts asynchronously, filesystem watching is optional,
and shutdown releases the watcher and index build. A missing, unreadable, empty, or still-building
corpus deterministically reports not-ready.

## No hosted or provider profile

This repository declares no hosted execution, container delivery, authenticated remote service,
external provider, operator instance, or cloud infrastructure. The previous Azure/container posture
is intentionally not represented: satisfying the provider contract would require inventing secret
and scoped-identity requirements that the local `DefaultAzureCredential` behavior did not have.

A future hosted or provider-backed profile requires a real usable corpus source plus truthful
authentication, bounded configuration, identity scope, source/artifact evidence, rollout gates,
readiness, and rollback. Those requirements must not be invented merely to preserve an old posture.
