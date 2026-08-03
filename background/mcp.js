/**
 * mcp.js — a minimal Model Context Protocol client over the Streamable HTTP
 * transport, designed to run in the MV3 service worker (fetch-based, no node
 * deps). This is the "prefer the most precise tool first" capability that
 * Claude Desktop and Gemini Deep Research expose: let the agent call the
 * server's own tools instead of falling back to raw browser input.
 *
 * Implemented subset: initialize / notifications.initialized / tools.list /
 * tools.call. SSE and JSON responses are both handled.
 */
const PROTOCOL_VERSION = '2025-03-26';

let _id = 100;
function nextId() {
  return ++_id;
}

function parseBody(res, text) {
  const ct = res.headers.get('content-type') || '';
  if (/event-stream/i.test(ct)) {
    const payloads = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = payloads[payloads.length - 1] || '{}';
    try {
      return JSON.parse(last);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postJson(url, payload, headers, sessionId) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(headers || {}) };
  if (sessionId) h['mcp-session-id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(payload) });
  const text = await res.text();
  return { res, body: parseBody(res, text) };
}

/** Establish a session with an MCP server over Streamable HTTP. */
export async function connectMcp(url, opts = {}) {
  if (!/^https?:\/\//.test(String(url || ''))) throw new Error('MCP endpoint must be an http(s) URL');
  const headers = { ...(opts.headers || {}) };
  const { res, body } = await postJson(
    url,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'visual-ai-agent', version: '0.1.0' } },
    },
    headers
  );
  if (!res.ok) throw new Error(`MCP initialize HTTP ${res.status}`);
  if (!body) throw new Error('MCP initialize: unparseable response');
  if (body.error) throw new Error('MCP initialize failed: ' + (body.error.message || JSON.stringify(body.error)));
  const result = body.result || {};
  const sessionId = res.headers.get('mcp-session-id') || null;
  const client = {
    url,
    name: opts.name || (() => { try { return new URL(url).host; } catch { return url; } })(),
    sessionId,
    serverInfo: result.serverInfo || {},
    protocolVersion: result.protocolVersion || PROTOCOL_VERSION,
    headers,
  };
  try {
    await postJson(url, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, headers, sessionId);
  } catch {}
  return client;
}

async function rpc(client, method, params) {
  const { res, body } = await postJson(client.url, { jsonrpc: '2.0', id: nextId(), method, params: params || {} }, client.headers, client.sessionId);
  if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}`);
  if (!body) throw new Error(`MCP ${method}: unparseable response`);
  if (body.error) throw new Error('MCP ' + method + ' failed: ' + (body.error.message || JSON.stringify(body.error)));
  return body;
}

/** List the server's tools. */
export async function listTools(client) {
  const body = await rpc(client, 'tools/list');
  return (body.result && body.result.tools) || [];
}

/** Call a server tool. */
export async function callTool(client, name, args) {
  const body = await rpc(client, 'tools/call', { name, arguments: args || {} });
  const r = body.result || {};
  return { content: r.content || [], isError: !!r.isError };
}

/** List resources (best-effort; some servers omit this). */
export async function listResources(client) {
  const body = await rpc(client, 'resources/list');
  return (body.result && body.result.resources) || [];
}
