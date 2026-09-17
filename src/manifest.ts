import type { CapabilityManifest } from '@agent-tool-platform/runtime/capability';
import packageManifest from '../package.json' with { type: 'json' };

export const capabilityManifest: CapabilityManifest = {
  name: 'agent-tool-server-doc-rag',
  version: packageManifest.version,
  title: 'Documentation RAG',
  description:
    'Retrieve bounded, provenance-rich evidence from one configured documentation corpus.',
  documentationUrl: 'https://github.com/ashergarland/agent-tool-server-doc-rag#readme',
};
