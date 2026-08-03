/**
 * test/unit/mcp.test.mjs — MCP Streamable HTTP client against a local server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectMcp, listTools, callTool, listResources } from '../../background/mcp.js';

const TOOLS = [
  { name: 'get_weather', description: 'Look up weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
  { name: 'get_time', description: 'Current time', inputSchema: { type: 'object' } },
];

function makeServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => handler(req, res));
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    srv.on('error', reject);
  });
}

function json(res, code, payload, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

test('connectMcp initializes, lists tools and calls a tool (JSON transport)', async () => {
  const seen = [];
  const { srv, port } = await makeServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const msg = JSON.parse(text);
    seen.push(msg);
    if (msg.method === 'initialize') {
      json(res, 200, rpcOk(msg.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } }), { 'mcp-session-id': 'sess-1' });
      return;
    }
    if (msg.method === 'tools/list') {
      json(res, 200, rpcOk(msg.id, { tools: TOOLS }));
      return;
    }
    if (msg.method === 'tools/call') {
      json(res, 200, rpcOk(msg.id, { content: [{ type: 'text', text: 'sunny in ' + msg.params.arguments.city }], isError: false }));
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end();
      return;
    }
    json(res, 200, rpcOk(msg.id, { resources: [{ uri: 'mock://1', name: 'r1' }] }));
  });
  try {
    const client = await connectMcp(`http://127.0.0.1:${port}/mcp`, { name: 'echo' });
    assert.equal(client.name, 'echo');
    assert.equal(client.sessionId, 'sess-1');
    assert.equal(client.serverInfo.name, 'echo');
    assert.equal(client.protocolVersion, '2025-03-26');
    const init = seen.find((m) => m.method === 'initialize');
    assert.equal(init.params.protocolVersion, '2025-03-26');
    assert.equal(init.params.clientInfo.name, 'visual-ai-agent');
    const initialized = seen.find((m) => m.method === 'notifications/initialized');
    assert.ok(initialized, 'sends notifications/initialized after handshake');
    const tools = await listTools(client);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, 'get_weather');
    const out = await callTool(client, 'get_weather', { city: 'Tokyo' });
    assert.equal(out.isError, false);
    assert.match(out.content[0].text, /Tokyo/);
    const resources = await listResources(client);
    assert.equal(resources.length, 1);
  } finally {
    srv.close();
  }
});

test('mcp parses SSE responses (text/event-stream)', async () => {
  const { srv, port } = await makeServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const msg = JSON.parse(text);
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify(rpcOk(msg.id, { protocolVersion: '2025-03-26', serverInfo: { name: 'sse' } }))}\n\n`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(rpcOk(msg.id, { tools: TOOLS }))}\n\n`);
  });
  try {
    const client = await connectMcp(`http://127.0.0.1:${port}/mcp`);
    assert.equal(client.serverInfo.name, 'sse');
    const tools = await listTools(client);
    assert.equal(tools.length, 2);
  } finally {
    srv.close();
  }
});

test('mcp surfaces HTTP and JSON-RPC errors', async () => {
  const { srv, port } = await makeServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const msg = JSON.parse(text);
    if (msg.method === 'initialize') {
      json(res, 500, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } });
      return;
    }
  });
  try {
    await assert.rejects(() => connectMcp(`http://127.0.0.1:${port}/mcp`), /HTTP 500|failed: boom/);
  } finally {
    srv.close();
  }
});

test('mcp rejects non-http urls and garbage bodies', async () => {
  await assert.rejects(() => connectMcp('file:///etc/passwd'), /http\(s\) URL/);
  const { srv, port } = await makeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('this is not json');
  });
  try {
    await assert.rejects(() => connectMcp(`http://127.0.0.1:${port}/mcp`), /unparseable/);
  } finally {
    srv.close();
  }
});
