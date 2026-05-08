import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { runReindexFrontmatter } from '../src/commands/reindex-frontmatter.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

describe('reindex-frontmatter source scoping', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('--source only rewrites matching source rows for duplicate slugs', async () => {
    await engine.executeRaw(`DELETE FROM content_chunks`);
    await engine.executeRaw(`DELETE FROM pages`);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('kb-reindex', 'kb-reindex', '{"federated": true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );

    await engine.putPage('meetings/acme', {
      type: 'meeting',
      title: 'Default meeting',
      compiled_truth: 'Default source meeting.',
      timeline: '',
    });
    await engine.putPage('meetings/acme', {
      type: 'meeting',
      title: 'KB meeting',
      compiled_truth: 'KB source meeting.',
      timeline: '',
    }, { sourceId: 'kb-reindex' });

    await engine.executeRaw(
      `UPDATE pages
       SET frontmatter = $1::jsonb,
           effective_date = TIMESTAMPTZ '2020-01-01T00:00:00Z',
           effective_date_source = 'fallback'
       WHERE source_id = 'default' AND slug = 'meetings/acme'`,
      [JSON.stringify({ date: '2024-01-01' })],
    );
    await engine.executeRaw(
      `UPDATE pages
       SET frontmatter = $1::jsonb,
           effective_date = TIMESTAMPTZ '2020-01-01T00:00:00Z',
           effective_date_source = 'fallback'
       WHERE source_id = 'kb-reindex' AND slug = 'meetings/acme'`,
      [JSON.stringify({ date: '2024-02-01' })],
    );

    const result = await runReindexFrontmatter(engine, {
      sourceId: 'kb-reindex',
      slugPrefix: 'meetings/',
      yes: true,
      json: true,
      force: true,
    });

    expect(result.status).toBe('ok');
    expect(result.examined).toBe(1);
    expect(result.updated).toBe(1);

    const rows = await engine.executeRaw<{ source_id: string; effective_date: string }>(
      `SELECT source_id, effective_date::text
       FROM pages
       WHERE slug = 'meetings/acme'
       ORDER BY source_id`,
    );
    expect(rows.find(r => r.source_id === 'default')?.effective_date).toContain('2020-01-01');
    expect(rows.find(r => r.source_id === 'kb-reindex')?.effective_date).toContain('2024-02-01');
  });
});
