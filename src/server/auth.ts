import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { unauthorized } from '../errors.js';

export interface Principal {
  readonly id: string;
  /** Non-reversible key fingerprint that is safe to log. */
  readonly fingerprint: string;
  readonly kind: 'api-key' | 'anonymous';
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<Principal>;
}

const credential = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim() || undefined;
  }
  const apiKey = request.headers['x-api-key'];
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
};

class DisabledAuthenticator implements Authenticator {
  public authenticate(): Promise<Principal> {
    return Promise.resolve({ id: 'anonymous', fingerprint: 'anonymous', kind: 'anonymous' });
  }
}

/**
 * Compares fixed-width keyed digests instead of raw credentials, so comparison time never depends
 * on the presented key's length or content, and only non-reversible fingerprints are retained.
 *
 * This service has no user accounts and no passwords. Credentials are generated API keys, which
 * `buildConfig` requires to encode at least 32 random bytes, so a fast keyed hash is correct and a
 * slow password KDF would be actively worse:
 *
 * - Digests exist only in process memory under a random per-process pepper. They are never
 *   persisted or logged, so there is no stored-hash corpus to attack offline. Guessing is online
 *   only, and is rate limited before and after verification.
 * - Verification runs on an unauthenticated request path. A per-request memory-hard KDF would turn
 *   the credential check into a CPU-exhaustion amplifier on a 0.25 CPU container.
 *
 * CodeQL's js/insufficient-password-hash rule assumes a stored, human-chosen password hash. Neither
 * half of that premise holds here. See .github/codeql/codeql-config.yml.
 */
class ApiKeyAuthenticator implements Authenticator {
  private readonly pepper = randomBytes(32);
  private readonly keys: ReadonlyArray<{
    digest: Buffer;
    principalId: string;
    fingerprint: string;
  }>;

  public constructor(apiKeys: readonly string[]) {
    this.keys = apiKeys.map((value, index) => {
      const digest = this.digestOf(value);
      return {
        digest,
        principalId: `key:${index + 1}`,
        fingerprint: digest.toString('hex').slice(0, 12),
      };
    });
  }

  public authenticate(request: FastifyRequest): Promise<Principal> {
    const presented = credential(request);
    if (!presented) throw unauthorized('Missing bearer token or x-api-key header');
    const presentedDigest = this.digestOf(presented);
    let match: { principalId: string; fingerprint: string } | undefined;
    for (const key of this.keys) {
      if (timingSafeEqual(key.digest, presentedDigest)) match = key;
    }
    if (!match) throw unauthorized('Invalid API key');
    return Promise.resolve({
      id: match.principalId,
      fingerprint: match.fingerprint,
      kind: 'api-key',
    });
  }

  private digestOf(value: string): Buffer {
    return createHmac('sha256', this.pepper).update(value, 'utf8').digest();
  }
}

export const createAuthenticator = (config: AppConfig): Authenticator =>
  config.auth.mode === 'disabled'
    ? new DisabledAuthenticator()
    : new ApiKeyAuthenticator(config.auth.apiKeys);
