# Operations Runbook

## Runtime port and configuration contract

The runtime reads the `PORT` environment variable and binds its listener to that exact port. The
container port, service target port, and probe port must all agree with `PORT`; changing an HTTP
route cannot repair a listener that is bound to the wrong port or has not started.

## TCP readiness semantics

A TCP readiness probe establishes a socket connection to the configured port. It does not send an
HTTP request, select a URL path, or require any health-handler route. Success proves only that a
process is accepting TCP connections on that port; capability readiness must separately prove that
the corpus index can serve useful retrieval.

## Why the health route rename is not causal

The incident revision used a TCP readiness probe and failed before the application accepted
connections on the configured port. Because TCP probes do not issue HTTP requests, changing the
application route from `/health` to `/healthz` cannot affect that probe. The relevant evidence is
the listener and probe-port configuration, not the name of an HTTP health endpoint.
