import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const repository = z.object({ url: z.url(), source: z.literal('github') });
const serverSchema = z.object({
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
        url: z.url().refine((value) => !value.includes('example.com'), {
          message: 'Remote endpoints must be real published endpoints, not placeholders',
        }),
      }),
    )
    .optional(),
});
const registrySchema = z.object({
  id: z.string().min(1),
  repository: z.url(),
  serverMetadata: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
});

const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const server = serverSchema.parse(await load('server.json'));
registrySchema.parse(await load('examples/central-registry-entry.json'));

const packageManifest = (await load('package.json')) as { version: string; private?: boolean };
if (packageManifest.version !== server.version) {
  throw new Error(
    `server.json version ${server.version} does not match package.json ${packageManifest.version}`,
  );
}
if (packageManifest.private && server.packages && server.packages.length > 0) {
  throw new Error('server.json advertises an npm package while package.json is private');
}

process.stdout.write('Metadata examples are valid.\n');
