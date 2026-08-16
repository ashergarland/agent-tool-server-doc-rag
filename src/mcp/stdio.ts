import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/index.js';
import { createCorpusSource } from '../corpus/index.js';
import { createIndexManager } from '../app.js';
import { InMemoryMetrics } from '../observability/metrics.js';
import { DocumentationSearchService } from '../search/service.js';
import { createServices } from '../services/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './server.js';

// Local stdio use: authentication belongs to the client process boundary, and the corpus is the
// single configured filesystem root.
const config = loadConfig({ ...process.env, AUTH_MODE: 'disabled', NODE_ENV: 'development' });
const metrics = new InMemoryMetrics();
const index = createIndexManager(config, createCorpusSource(config), metrics);
index.start();

const services = createServices(
  index,
  new DocumentationSearchService(index, config.search, metrics),
);
const server = createMcpServer(config, createToolRegistry(), services, {
  requestId: `stdio-${process.pid}`,
  principal: 'stdio-client',
});

const shutdown = (): void => {
  void index.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
