# Authentication

Hosted deployments authenticate every protected route.

## Presenting credentials

Send the credential as a bearer token in the `authorization` header or in the `x-api-key` header.
Requests without a credential receive `401`.

## Rotating keys

Add the replacement secret to `API_KEYS`, deploy the revision, migrate clients, and only then remove
the retired secret. Keys are compared as fixed-width keyed digests, so rotation never leaks timing
information.
