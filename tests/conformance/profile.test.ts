import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { capability } from '../../src/capability.js';

interface Declaration {
  readonly capability: {
    readonly id: string;
    readonly displayName: string;
    readonly repository: string;
  };
  readonly profiles: readonly [
    {
      readonly id: string;
      readonly dimensions: Record<string, string>;
      readonly delivery: {
        readonly publication: { readonly identifier: string };
        readonly entrypoint: { readonly reference: string; readonly interface: string };
      };
      readonly configuration: {
        readonly schema: {
          readonly id: string;
          readonly capabilityId: string;
          readonly path: string;
        };
        readonly bounded: boolean;
      };
      readonly requiredSecrets: readonly string[];
      readonly providerPrerequisites: readonly unknown[];
      readonly workload: {
        readonly interface: { readonly kind: string };
        readonly notReady: { readonly whenAbsent: string; readonly reason: string };
      };
    },
  ];
}

const load = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

describe('local capability profile truthfulness', () => {
  it('matches repository, package, capability, and schema identity', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const server = (await load('../../server.json')) as {
      readonly name: string;
      readonly repository: { readonly url: string };
    };
    const manifest = (await load('../../package.json')) as {
      readonly name: string;
      readonly version: string;
    };
    const configurationSchema = (await load('../../schemas/local-configuration.schema.json')) as {
      readonly $id: string;
    };
    const profile = declaration.profiles[0];

    expect(declaration.capability).toEqual({
      id: server.name,
      displayName: capability.manifest.title,
      repository: server.repository.url,
    });
    expect(capability.manifest.version).toBe(manifest.version);
    expect(profile.delivery.publication.identifier).toBe(manifest.name);
    expect(profile.delivery.entrypoint).toEqual({
      reference: 'dist/stdio.js',
      interface: 'stdio',
    });
    expect(profile.configuration).toEqual({
      schema: {
        id: configurationSchema.$id,
        capabilityId: declaration.capability.id,
        path: 'schemas/local-configuration.schema.json',
      },
      bounded: true,
    });
  });

  it('declares one local, filesystem, read-only profile', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const profile = declaration.profiles[0];

    expect(profile.id).toBe('local-filesystem-package');
    expect(profile.dimensions).toEqual({
      execution: 'local',
      delivery: 'package',
      access: 'local-process',
      workload: 'filesystem',
      provider: 'none',
      mutation: 'read-only',
    });
    expect(profile.requiredSecrets).toEqual([]);
    expect(profile.providerPrerequisites).toEqual([]);
    expect(profile.workload.interface.kind).toBe('filesystem');
    expect(profile.workload.notReady.whenAbsent).toBe('not-ready');
    expect(capability.tools.every((tool) => tool.kind === 'read')).toBe(true);
  });

  it('contains no hosted posture, provider, remote access, or operator instance', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const serialized = JSON.stringify(declaration);

    expect(declaration.profiles).toHaveLength(1);
    expect(serialized).not.toMatch(
      /subscription|tenant|provider prerequisite|key.?vault|resource.?group|container.?app|production endpoint/iu,
    );
    expect(serialized).not.toContain('secretValue');
  });
});
