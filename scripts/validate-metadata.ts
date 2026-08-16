import { readFile } from 'node:fs/promises';
import {
  assertConsistentMetadata,
  registrySchema,
  serverSchema,
  type PackageManifest,
} from './metadata-schema.js';

const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const server = serverSchema.parse(await load('server.json'));
registrySchema.parse(await load('examples/central-registry-entry.json'));
assertConsistentMetadata(server, (await load('package.json')) as PackageManifest);

process.stdout.write('Metadata examples are valid.\n');
