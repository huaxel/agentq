'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createMcpServer } = require('../src/interfaces/mcp/protocol.js');

function makeServer() {
  const calls = [];
  const tools = [
    {
      name: 'echo',
      description: 'Echo the given value back.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler(args) {
        calls.push(args);
        return { echoed: args.value ?? null };
      },
    },
    {
      name: 'explode',
      description: 'Always throws.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      handler() {
        throw new Error('boom: capacity source unavailable');
      },
    },
    {
      name: 'async_echo',
      description: 'Resolves asynchronously.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      async handler() {
        return { ok: true };
      },
    },
  ];
  return { server: createMcpServer({ name: 'agentq', version: '9.9.9', tools }), calls };
}

test('initialize echoes a supported protocol version and advertises tools', async () => {
  const { server } = makeServer();
  for (const version of ['2025-06-18', '2025-03-26']) {
    const response = await server.handle({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {} },
    });
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, version);
    assert.deepEqual(response.result.capabilities, { tools: {} });
    assert.deepEqual(response.result.serverInfo, { name: 'agentq', version: '9.9.9' });
  }
});

test('initialize falls back to the latest supported version for unknown requests', async () => {
  const { server } = makeServer();
  const response = await server.handle({
    jsonrpc: '2.0', id: 'abc', method: 'initialize', params: { protocolVersion: '1999-01-01' },
  });
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.equal(response.id, 'abc');

  const noParams = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize' });
  assert.equal(noParams.result.protocolVersion, '2025-06-18');
});

test('notifications/initialized produces no response', async () => {
  const { server } = makeServer();
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
});

test('any message without an id is a notification and is never answered', async () => {
  const { server, calls } = makeServer();
  const idless = [
    { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'ping' },
    { jsonrpc: '2.0', method: 'tools/list' },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: { value: 'x' } } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'explode', arguments: {} } },
    { jsonrpc: '2.0', method: 'resources/list' },
    { jsonrpc: '2.0', id: null, method: 'ping' },
  ];
  for (const message of idless) {
    assert.equal(await server.handle(message), null, `no reply for ${message.method}`);
  }
  assert.deepEqual(calls, [], 'notification tool calls must not run');
});

test('ping returns an empty result', async () => {
  const { server } = makeServer();
  const response = await server.handle({ jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.deepEqual(response, { jsonrpc: '2.0', id: 7, result: {} });
});

test('tools/list exposes schemas and the read-only annotation', async () => {
  const { server } = makeServer();
  const response = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const listed = response.result.tools;
  assert.deepEqual(listed.map((tool) => tool.name), ['echo', 'explode', 'async_echo']);
  for (const tool of listed) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.annotations, { readOnlyHint: true });
    assert.equal(tool.handler, undefined, 'handlers must not leak over the wire');
  }
});

test('tools/call returns JSON text plus structuredContent', async () => {
  const { server, calls } = makeServer();
  const response = await server.handle({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } },
  });
  assert.deepEqual(calls, [{ value: 'hi' }]);
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(response.result.structuredContent, { echoed: 'hi' });
  assert.deepEqual(response.result.content, [{ type: 'text', text: JSON.stringify({ echoed: 'hi' }, null, 2) }]);
});

test('tools/call without arguments passes an empty object', async () => {
  const { server, calls } = makeServer();
  const response = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo' } });
  assert.deepEqual(calls, [{}]);
  assert.deepEqual(response.result.structuredContent, { echoed: null });
});

test('a throwing tool becomes an isError result, not a JSON-RPC error', async () => {
  const { server } = makeServer();
  const response = await server.handle({
    jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'explode', arguments: {} },
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: 'text', text: 'boom: capacity source unavailable' }]);
});

test('async tool handlers are awaited', async () => {
  const { server } = makeServer();
  const response = await server.handle({
    jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'async_echo' },
  });
  assert.deepEqual(response.result.structuredContent, { ok: true });
});

test('unknown tools and malformed tool calls are invalid params', async () => {
  const { server } = makeServer();
  const unknownTool = await server.handle({
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' },
  });
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /Unknown tool: nope/);

  const noName = await server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: {} });
  assert.equal(noName.error.code, -32602);

  const badArgs = await server.handle({
    jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'echo', arguments: ['nope'] },
  });
  assert.equal(badArgs.error.code, -32602);
});

test('unknown methods are method-not-found, and unknown notifications stay silent', async () => {
  const { server } = makeServer();
  const response = await server.handle({ jsonrpc: '2.0', id: 12, method: 'resources/list' });
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /Method not found: resources\/list/);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'resources/list' }), null);
});

test('malformed JSON lines are parse errors', async () => {
  const { server } = makeServer();
  const response = await server.handle('{"jsonrpc":"2.0",');
  assert.equal(response.error.code, -32700);
  assert.equal(response.id, null);
});

test('non-object and non-JSON-RPC messages are invalid requests', async () => {
  const { server } = makeServer();
  assert.equal((await server.handle('[1,2,3]')).error.code, -32600);
  assert.equal((await server.handle('null')).error.code, -32600);
  const wrongVersion = await server.handle({ jsonrpc: '1.0', id: 13, method: 'ping' });
  assert.equal(wrongVersion.error.code, -32600);
});

test('serve() streams newline-delimited responses in request order', async () => {
  const { server } = makeServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = server.serve(stdin, stdout);

  const chunks = [];
  stdout.on('data', (chunk) => chunks.push(String(chunk)));

  // Split a message across chunks to prove line buffering works.
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  stdin.write(init.slice(0, 20));
  stdin.write(`${init.slice(20)}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  stdin.write('\n');
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  stdin.write('not json at all\n');
  await handle.flush();

  const lines = chunks.join('').split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 3, 'one response per request, none for notifications or blank lines');
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((message) => message.id), [1, 2, null]);
  assert.equal(parsed[0].result.protocolVersion, '2025-06-18');
  assert.equal(parsed[1].result.tools.length, 3);
  assert.equal(parsed[2].error.code, -32700);

  handle.close();
  stdin.end();
});

test('serve() reassembles multibyte characters split across chunks', async () => {
  const { server } = makeServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.setEncoding('utf8');
  const handle = server.serve(stdin, stdout);
  const chunks = [];
  stdout.on('data', (chunk) => chunks.push(chunk));

  const value = 'héllo 日本語 🎉 ünïcode';
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { value } } };
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
  // Split one byte into the first two-byte character (é is 0xC3 0xA9).
  const splitAt = bytes.indexOf(Buffer.from('é', 'utf8')) + 1;
  assert.ok(splitAt > 0, 'fixture must contain a multibyte character');
  stdin.write(bytes.subarray(0, splitAt));
  stdin.write(bytes.subarray(splitAt));
  await handle.flush();

  const lines = chunks.join('').split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1);
  const response = JSON.parse(lines[0]);
  assert.equal(response.result.structuredContent.echoed, value);
  assert.equal(chunks.join('').includes('\uFFFD'), false, 'no replacement characters');
});

test('serve() flushes a final line without a trailing newline', async () => {
  const { server } = makeServer();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = server.serve(stdin, stdout);
  const chunks = [];
  stdout.on('data', (chunk) => chunks.push(String(chunk)));
  const ended = new Promise((resolve) => stdin.on('end', resolve));
  stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }));
  await ended;
  await handle.flush();
  const lines = chunks.join('').split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 99, result: {} });
});
