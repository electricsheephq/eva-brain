import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

const REPO = join(import.meta.dir, '..');
const PLUGIN_ROOT = join(REPO, 'plugins', 'gbrain-codex');

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function parseToolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  const first = Array.isArray(content) ? content[0] : null;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
}

function createWrapper(): string {
  const wrapperDir = tempDir('gbrain-codex-wrapper-');
  const wrapperPath = join(wrapperDir, 'gbrain');
  writeFileSync(
    wrapperPath,
    `#!/bin/sh
cd ${JSON.stringify(REPO)}
exec bun run src/cli.ts "$@"
`,
  );
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function runInit(gbrainPath: string, home: string): void {
  const proc = Bun.spawnSync([gbrainPath, 'init', '--pglite', '--non-interactive', '--json'], {
    env: {
      ...process.env,
      GBRAIN_HOME: home,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(proc.exitCode).toBe(0);
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugins/gbrain-codex stdio MCP', () => {
  test('tools/list matches upstream tool defs and sample calls inherit remote behavior', async () => {
    const gbrainPath = createWrapper();
    const home = tempDir('gbrain-codex-home-');
    runInit(gbrainPath, home);

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['./scripts/launch-gbrain-serve.mjs'],
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        GBRAIN_CODEX_BIN: gbrainPath,
        GBRAIN_HOME: home,
      },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'gbrain-codex-test', version: '1.0.0' },
      { capabilities: {} },
    );

      await client.connect(transport);
    try {
      const list = await client.listTools();
      expect(JSON.stringify(list.tools)).toBe(JSON.stringify(buildToolDefs(operations)));
      expect(list.tools.map(tool => tool.name)).toEqual(operations.map(op => op.name));
      expect(list.tools.length).toBe(operations.length);

      const put = await client.callTool({
        name: 'put_page',
        arguments: {
          slug: 'notes/codex-plugin-stdio-test',
          content: [
            '---',
            'title: Codex Plugin Stdio Test',
            'type: note',
            '---',
            '',
            'This page exists so the Codex plugin stdio smoke can find it.',
          ].join('\n'),
        },
      });
      expect(put.isError).not.toBe(true);

      const get = await client.callTool({
        name: 'get_page',
        arguments: { slug: 'notes/codex-plugin-stdio-test' },
      });
      expect(get.isError).not.toBe(true);
      expect(parseToolText(get)).toContain('codex-plugin-stdio-test');

      const search = await client.callTool({
        name: 'search',
        arguments: { query: 'Codex plugin stdio smoke' },
      });
      expect(search.isError).not.toBe(true);
      expect(parseToolText(search)).toContain('notes/codex-plugin-stdio-test');

      const query = await client.callTool({
        name: 'query',
        arguments: { query: 'Which page mentions the Codex plugin stdio smoke?' },
      });
      expect(query.isError).not.toBe(true);
      expect(() => JSON.parse(parseToolText(query))).not.toThrow();

      const sync = await client.callTool({
        name: 'sync_brain',
        arguments: {
          repo: REPO,
          dry_run: true,
          no_pull: true,
          no_embed: true,
        },
      });
      expect(sync.isError).not.toBe(true);

      const recent = await client.callTool({
        name: 'get_recent_transcripts',
        arguments: {},
      });
      expect(recent.isError).toBe(true);
      expect(parseToolText(recent)).toContain('permission_denied');
    } finally {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    }
  }, 120000);
});
