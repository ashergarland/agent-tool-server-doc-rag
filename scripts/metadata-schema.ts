import { z } from 'zod';

/**
 * Reserved and documentation-only names from RFC 2606 and RFC 6761. A published remote endpoint
 * must not resolve to one of these.
 */
const reservedHostSuffixes = ['example.com', 'example.org', 'example.net', 'example.edu'];
const reservedTopLevelDomains = ['test', 'invalid', 'localhost', 'example', 'local'];

/**
 * Checks the parsed hostname rather than searching the URL text. A substring test is incomplete:
 * `https://attacker.test/?ref=example.com` contains the placeholder without being one, and
 * `https://example.com.attacker.test/` is a real host that merely starts with it.
 */
export const isPlaceholderEndpoint = (value: string): boolean => {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (reservedHostSuffixes.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    return true;
  }
  const topLevelDomain = hostname.slice(hostname.lastIndexOf('.') + 1);
  return reservedTopLevelDomains.includes(topLevelDomain);
};

const repository = z.object({ url: z.url(), source: z.literal('github') });

export const serverSchema = z.object({
  name: z.string().regex(/^[a-z0-9.-]+\/[a-z0-9._-]+$/),
  description: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  repository,
  // Packages and remotes are only valid once something is actually published. Placeholder
  // registry identifiers and example endpoints must never ship as if they resolve.
  packages: z
    .array(
      z.object({
        registryType: z.literal('npm'),
        identifier: z.string().min(1),
        version: z.string(),
        transport: z.object({ type: z.literal('stdio') }),
      }),
    )
    .optional(),
  remotes: z
    .array(
      z.object({
        type: z.literal('streamable-http'),
        url: z
          .url()
          .refine((value) => value.toLowerCase().startsWith('https://'), {
            message: 'Remote endpoints must use https',
          })
          .refine((value) => !isPlaceholderEndpoint(value), {
            message: 'Remote endpoints must be real published endpoints, not placeholders',
          }),
      }),
    )
    .optional(),
});

export const registrySchema = z.object({
  id: z.string().min(1),
  repository: z.url(),
  serverMetadata: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
});

export interface PackageManifest {
  readonly version: string;
  readonly private?: boolean;
}

/** Verifies that published metadata agrees with the package manifest. */
export const assertConsistentMetadata = (
  server: z.output<typeof serverSchema>,
  packageManifest: PackageManifest,
): void => {
  if (packageManifest.version !== server.version) {
    throw new Error(
      `server.json version ${server.version} does not match package.json ${packageManifest.version}`,
    );
  }
  if (packageManifest.private && server.packages && server.packages.length > 0) {
    throw new Error('server.json advertises an npm package while package.json is private');
  }
};
