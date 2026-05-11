import { describe, expect, test } from 'bun:test';

function extractMcpRoute(source: string): string {
  const routeStart = source.indexOf("app.post('/mcp'");
  const routeEnd = source.indexOf('// ---------------------------------------------------------------------------\n  // Start server', routeStart);
  expect(routeStart).toBeGreaterThan(-1);
  expect(routeEnd).toBeGreaterThan(routeStart);
  return source.slice(routeStart, routeEnd);
}

describe('serve-http security wiring', () => {
  test('HTTP MCP operation context is marked remote/untrusted', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    const mcpRoute = extractMcpRoute(source);
    expect(mcpRoute).toMatch(/dispatchToolCall\([\s\S]*\{[\s\S]*remote: true,/);
  });

  test('admin cookies use Secure on HTTPS/public-proxy requests', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    expect(source).toContain("secure: req.secure || issuerUrl.protocol === 'https:'");
  });

  test('MCP request logging stores only redacted argument summaries', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    const mcpRoute = extractMcpRoute(source);

    expect(source).toContain("from '../mcp/dispatch.ts'");
    expect(mcpRoute).toContain('const safeParamsSummary = summarizeMcpParams(name, params)');
    expect(mcpRoute).toContain(': (safeParamsSummary || null)');
    expect(mcpRoute).toContain('const broadcastParams = logFullParams ? (params || {}) : safeParamsSummary');
    expect(mcpRoute).not.toContain('params: params || {}');
  });

  test('MCP operation failures use the shared structured error envelope', async () => {
    const source = await Bun.file(new URL('../src/commands/serve-http.ts', import.meta.url)).text();
    const mcpRoute = extractMcpRoute(source);
    const operationErrorStart = mcpRoute.indexOf('const errorPayload = serializeError(e)');
    const operationErrorEnd = mcpRoute.indexOf('// F14: wrap transport setup + handleRequest in try/catch', operationErrorStart);
    expect(operationErrorStart).toBeGreaterThan(-1);
    expect(operationErrorEnd).toBeGreaterThan(operationErrorStart);
    const operationErrorBlock = mcpRoute.slice(operationErrorStart, operationErrorEnd);

    expect(source).toContain("from '../core/errors.ts'");
    expect(operationErrorBlock).toContain('serializeError(e)');
    expect(operationErrorBlock).toContain('JSON.stringify({ error: errorPayload })');
    expect(operationErrorBlock).not.toContain('e.toJSON()');
    expect(operationErrorBlock).not.toContain("error: 'internal_error'");
    expect(mcpRoute).toContain("error: 'internal_error'");
  });
});
