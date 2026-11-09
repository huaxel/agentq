'use strict';

/**
 * Minimal Model Context Protocol server over newline-delimited JSON-RPC 2.0.
 *
 * Hand-rolled on purpose: the repository takes no new npm dependencies for
 * this, and the surface we need (initialize, ping, tools/list, tools/call) is
 * small enough to keep auditable. Everything is dependency-injected: this
 * module never opens a database, reads config, or requires a core module.
 *
 * Transport contract:
 *   - one JSON-RPC message per line on stdin, one response per line on stdout;
 *   - nothing but protocol messages is ever written to stdout (logs go to
 *     stderr, by the caller);
 *   - notifications (no `id`) never produce a response.
 */

/** Protocol revisions this server can speak. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];

/** Revision used when the client asks for something we do not implement. */
const LATEST_PROTOCOL_VERSION = '2025-06-18';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * @typedef {Object} McpTool
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema
 * @property {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean }} [annotations]
 * @property {(args: Record<string, any>) => unknown} handler
 */

/**
 * @typedef {Object} JsonRpcError
 * @property {number} code
 * @property {string} message
 */

/**
 * @typedef {Object} JsonRpcResponse
 * @property {'2.0'} jsonrpc
 * @property {string|number|null} id
 * @property {unknown} [result]
 * @property {JsonRpcError} [error]
 */

/**
 * @typedef {Object} McpServer
 * @property {(message: unknown) => JsonRpcResponse | null | Promise<JsonRpcResponse | null>} handle
 * @property {(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) => { close: () => void, flush: () => Promise<void> }} serve
 */

/**
 * @param {string|number|null} id
 * @param {unknown} result
 * @returns {JsonRpcResponse}
 */
function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @returns {JsonRpcResponse}
 */
function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Tool execution failed';
}

/**
 * Successful tool result: human-readable JSON text plus the same data as
 * `structuredContent` for clients that can consume it directly.
 * @param {unknown} data
 * @returns {{ content: Array<{ type: 'text', text: string }>, structuredContent: unknown }}
 */
function toolSuccess(data) {
  const payload = data === undefined ? null : data;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Failed tool result. Tool failures are reported inside `result` (with
 * `isError: true`) rather than as a JSON-RPC error, per MCP.
 * @param {unknown} error
 * @returns {{ isError: true, content: Array<{ type: 'text', text: string }> }}
 */
function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
}

/**
 * Public tool descriptor. `readOnlyHint` is always present (clients use it to
 * decide whether to warn before a call); the other hints appear only when the
 * tool declares them, so read-only tools keep their minimal annotation.
 * @param {McpTool} tool
 * @returns {{ name: string, description: string, inputSchema: Record<string, unknown>, annotations: { readOnlyHint: boolean, destructiveHint?: boolean, idempotentHint?: boolean } }}
 */
function publicTool(tool) {
  /** @type {{ readOnlyHint: boolean, destructiveHint?: boolean, idempotentHint?: boolean }} */
  const annotations = { readOnlyHint: tool.annotations?.readOnlyHint === true };
  if (typeof tool.annotations?.destructiveHint === 'boolean') {
    annotations.destructiveHint = tool.annotations.destructiveHint;
  }
  if (typeof tool.annotations?.idempotentHint === 'boolean') {
    annotations.idempotentHint = tool.annotations.idempotentHint;
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations,
  };
}

/**
 * @param {unknown} params
 * @returns {string}
 */
function negotiateProtocolVersion(params) {
  const requested = params && typeof params === 'object'
    ? /** @type {Record<string, unknown>} */ (params).protocolVersion
    : undefined;
  if (typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LATEST_PROTOCOL_VERSION;
}

/**
 * Build a protocol handler over a fixed tool list.
 *
 * `handle` returns a Promise when a tool handler returns a thenable. `serve()`
 * processes one message at a time, so a handler must answer promptly: long work
 * (a quota collection, an executor) is started in the background and bounded,
 * never awaited to completion, or every other request (ping, tools/list) waits
 * behind it.
 *
 * @param {{ name: string, version: string, tools: McpTool[] }} options
 * @returns {McpServer}
 */
function createMcpServer({ name, version, tools }) {
  const toolList = Array.isArray(tools) ? tools.slice() : [];
  /** @type {Map<string, McpTool>} */
  const toolMap = new Map(toolList.map((tool) => [tool.name, tool]));

  /**
   * @param {string|number|null} id
   * @param {unknown} params
   * @returns {JsonRpcResponse | Promise<JsonRpcResponse>}
   */
  function callTool(id, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || typeof (/** @type {Record<string, unknown>} */ (params).name) !== 'string') {
      return errorResponse(id, INVALID_PARAMS, 'Invalid params: tools/call requires a tool name');
    }
    const call = /** @type {{ name: string, arguments?: unknown }} */ (params);
    const tool = toolMap.get(call.name);
    if (!tool) return errorResponse(id, INVALID_PARAMS, `Unknown tool: ${call.name}`);
    const args = call.arguments === undefined || call.arguments === null ? {} : call.arguments;
    if (typeof args !== 'object' || Array.isArray(args)) {
      return errorResponse(id, INVALID_PARAMS, 'Invalid params: tool arguments must be an object');
    }

    let outcome;
    try {
      outcome = tool.handler(/** @type {Record<string, any>} */ (args));
    } catch (error) {
      return ok(id, toolError(error));
    }
    if (outcome && typeof (/** @type {any} */ (outcome)).then === 'function') {
      return Promise.resolve(outcome).then(
        (data) => ok(id, toolSuccess(data)),
        (error) => ok(id, toolError(error)),
      );
    }
    return ok(id, toolSuccess(outcome));
  }

  /**
   * @param {unknown} message parsed message, or a raw JSON line
   * @returns {JsonRpcResponse | null | Promise<JsonRpcResponse | null>}
   */
  function handle(message) {
    /** @type {any} */
    let msg = message;
    if (typeof msg === 'string') {
      try {
        msg = JSON.parse(msg);
      } catch {
        return errorResponse(null, PARSE_ERROR, 'Parse error: invalid JSON');
      }
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return errorResponse(null, INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
    }

    // A message without an id is a notification: it is never answered, for
    // any method, including initialize/ping/tools/*. JSON-RPC has no way to
    // correlate a reply with a notification, and replying to one confuses
    // clients that are not reading for a response.
    if (msg.id === undefined || msg.id === null) return null;
    const id = msg.id;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return errorResponse(id, INVALID_REQUEST, 'Invalid Request: expected jsonrpc "2.0" and a method string');
    }

    const method = msg.method;
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: negotiateProtocolVersion(msg.params),
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: toolList.map(publicTool) });
      case 'tools/call':
        return callTool(id, msg.params);
      default:
        return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /**
   * Pump newline-delimited messages from `stdin` to `stdout`. Responses keep
   * input order even when a handler is asynchronous.
   * @param {NodeJS.ReadableStream} stdin
   * @param {NodeJS.WritableStream} stdout
   * @returns {{ close: () => void, flush: () => Promise<void> }}
   */
  function serve(stdin, stdout) {
    let buffer = '';
    /** @type {Promise<void>} */
    let queue = Promise.resolve();

    // Decode as a stream, not per chunk: a UTF-8 character split across two
    // chunks must not be mangled into replacement characters.
    if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');

    /** @param {JsonRpcResponse | null} response */
    const emit = (response) => {
      if (!response) return;
      stdout.write(`${JSON.stringify(response)}\n`);
    };

    /** @param {string} line */
    const dispatch = (line) => {
      queue = queue
        .then(() => handle(line))
        .then(emit, (error) => {
          emit(errorResponse(null, INTERNAL_ERROR, `Internal error: ${errorMessage(error)}`));
        });
    };

    /** @param {unknown} chunk */
    const onData = (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : String(chunk);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') dispatch(line);
        index = buffer.indexOf('\n');
      }
    };

    const onEnd = () => {
      const rest = buffer;
      buffer = '';
      if (rest.trim() !== '') dispatch(rest);
    };

    stdin.on('data', onData);
    stdin.on('end', onEnd);

    return {
      close() {
        stdin.off('data', onData);
        stdin.off('end', onEnd);
      },
      flush() {
        return queue;
      },
    };
  }

  return { handle, serve };
}

module.exports = {
  createMcpServer,
  PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
};
