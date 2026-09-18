import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env['npm_execpath'];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runNode = (args, options = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_update_notifier: 'false' },
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${process.execPath} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
};

const runNpm = (args, options = {}) => {
  assert(npmCli, 'package:smoke must be invoked through npm');
  return runNode([npmCli, ...args], options);
};

class McpClient {
  constructor(entrypoint, cwd, env) {
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.nonProtocolOutput = [];
    this.stderr = '';
    this.child = spawn(process.execPath, [entrypoint], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.exit = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  dispatch(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.nonProtocolOutput.push(line);
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${this.stderr}`));
      }, 30_000);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'doc-rag-package-smoke', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async shutdown() {
    this.child.stdin.end();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Packed stdio entrypoint did not exit')), 15_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exit, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  terminate() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
  }
}

const invokeUntilIndexed = async (client, input) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const invocation = await client.request('tools/call', {
      name: 'search_docs',
      arguments: input,
    });
    const result = invocation.result?.structuredContent;
    if (result?.status !== 'unavailable') return { invocation, result };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Packed capability did not finish indexing the disposable corpus');
};

const stopClient = async (client) => {
  const exit = await client.shutdown();
  assert(exit.code === 0, `Packed entrypoint exited with code ${String(exit.code)}`);
  assert(client.nonProtocolOutput.length === 0, 'Packed entrypoint wrote non-protocol stdout');
  assert(client.stderr === '', `Packed entrypoint wrote to stderr:\n${client.stderr}`);
};

const main = async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const packageName = manifest.name;
  const bins = Object.entries(manifest.bin ?? {});
  assert(typeof packageName === 'string' && packageName.length > 0, 'Package name is missing');
  assert(bins.length === 1, 'Package smoke expects exactly one public executable');
  const [binName, binTarget] = bins[0];

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'doc-rag-package-smoke-'));
  const clients = [];
  try {
    const outside = relative(repositoryRoot, temporaryRoot);
    assert(
      outside.startsWith('..') || isAbsolute(outside),
      'The package consumer must be outside the source checkout',
    );

    runNpm(['run', 'build']);
    const packDirectory = join(temporaryRoot, 'pack');
    await mkdir(packDirectory);
    const packed = JSON.parse(
      runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory]),
    );
    assert(Array.isArray(packed) && packed.length === 1, 'npm pack returned no single candidate');
    const candidate = packed[0];
    assert(candidate.name === packageName, `npm pack selected ${String(candidate.name)}`);

    const packedFiles = candidate.files.map((file) => file.path);
    for (const required of [
      'LICENSE',
      'README.md',
      'dist/public.d.ts',
      'dist/public.js',
      binTarget,
      'package.json',
    ]) {
      assert(packedFiles.includes(required), `Packed package is missing ${required}`);
    }
    for (const forbidden of ['src/', 'tests/', 'scripts/', '.github/', 'coverage/']) {
      assert(
        !packedFiles.some((path) => path.startsWith(forbidden)),
        `Packed package contains ${forbidden}`,
      );
    }

    const tarball = join(packDirectory, candidate.filename);
    const consumer = join(temporaryRoot, 'consumer');
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      `${JSON.stringify(
        { name: 'doc-rag-package-smoke-consumer', private: true, type: 'module' },
        null,
        2,
      )}\n`,
    );
    runNpm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball],
      { cwd: consumer },
    );

    const installed = join(consumer, 'node_modules', ...packageName.split('/'));
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert(installedManifest.name === packageName, 'External consumer installed the wrong package');
    assert(
      installedManifest.version === candidate.version,
      'Installed version differs from the packed candidate',
    );
    assert(installedManifest.bin?.[binName] === binTarget, 'Installed bin target changed');

    await writeFile(
      join(consumer, 'consumer.mjs'),
      `import { capability, capabilityManifest, searchDocsTool } from ${JSON.stringify(
        packageName,
      )};\n` +
        `if (capability.manifest !== capabilityManifest) throw new Error('exports do not compose');\n` +
        `if (searchDocsTool.name !== 'search_docs') throw new Error('tool export failed');\n`,
    );
    runNode(['consumer.mjs'], { cwd: consumer });

    const installedEntry = join(installed, binTarget);
    await access(installedEntry, fsConstants.R_OK);
    const installedBin = join(
      consumer,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? `${binName}.cmd` : binName,
    );
    await access(installedBin, fsConstants.R_OK);
    if (process.platform !== 'win32') {
      assert(((await stat(installedBin)).mode & 0o111) !== 0, 'Installed bin is not executable');
    }

    const corpus = join(temporaryRoot, 'corpus');
    await mkdir(corpus);
    await writeFile(
      join(corpus, 'operations.md'),
      '# Runtime operations\n\nThe PORT configuration must match the listener and TCP probe port.',
    );

    const readyClient = new McpClient(installedEntry, consumer, {
      CORPUS_SOURCE: 'filesystem',
      DOCS_ROOT: corpus,
      CORPUS_WATCH: 'false',
    });
    clients.push(readyClient);
    const initialized = await readyClient.initialize();
    assert(initialized.result?.serverInfo, 'Packed entrypoint returned no MCP server identity');
    assert(
      initialized.result.serverInfo.version === candidate.version,
      `Packed entrypoint reported ${String(
        initialized.result.serverInfo.version,
      )}, expected ${candidate.version}`,
    );

    const listed = await readyClient.request('tools/list');
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    assert(
      JSON.stringify(names) === JSON.stringify(['search_docs']),
      `Packed entrypoint exposed unexpected tools: ${names.join(', ')}`,
    );

    const { invocation, result } = await invokeUntilIndexed(readyClient, {
      query: 'PORT listener TCP probe configuration',
      limit: 3,
    });
    assert(invocation.result?.isError !== true, 'search_docs failed from the packed entrypoint');
    assert(result?.status === 'ok', `Packed retrieval returned ${String(result?.status)}`);
    assert(result.results?.[0]?.source === 'operations.md', 'Packed retrieval lost provenance');
    assert(result.results[0].startLine > 0, 'Packed retrieval returned no citation line');
    assert(
      !JSON.stringify(result).includes(corpus),
      'Packed retrieval exposed an absolute corpus path',
    );
    await stopClient(readyClient);

    const notReadyClient = new McpClient(installedEntry, consumer, {
      CORPUS_SOURCE: 'none',
    });
    clients.push(notReadyClient);
    await notReadyClient.initialize();
    const unavailable = await notReadyClient.request('tools/call', {
      name: 'search_docs',
      arguments: { query: 'PORT listener TCP probe configuration', limit: 3 },
    });
    const unavailableResult = unavailable.result?.structuredContent;
    assert(
      unavailableResult?.status === 'unavailable',
      'Missing corpus did not report unavailable',
    );
    assert(unavailableResult.results?.length === 0, 'Missing corpus returned misleading evidence');
    assert(
      unavailableResult.warnings?.includes('index_not_configured'),
      'Missing corpus omitted its deterministic model-visible warning',
    );
    await stopClient(notReadyClient);

    process.stdout.write(
      `Package smoke passed for ${packageName}@${candidate.version}: ` +
        `${packedFiles.length} files, disposable-corpus retrieval and not-ready behavior verified.\n`,
    );
  } finally {
    for (const client of clients) client.terminate();
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
};

await main();
