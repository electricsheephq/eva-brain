import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { saveConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const originalGbrainHome = process.env.GBRAIN_HOME;

async function seedSource(engine: PGLiteEngine, sourceId: string) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ($1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [sourceId, sourceId],
  );
}

describe('migrate-engine source identity', () => {
  afterEach(() => {
    if (originalGbrainHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = originalGbrainHome;
  });

  test('preserves source-scoped metadata, versions, sidecars, and links', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-migrate-source-'));
    process.env.GBRAIN_HOME = home;

    const source = new PGLiteEngine();
    const target = new PGLiteEngine();
    const targetPath = join(home, 'target.pglite');

    try {
      await source.connect({});
      await source.initSchema();
      await seedSource(source, 'kb-source');

      await source.putPage('people/alice', {
        type: 'person',
        title: 'Default Alice',
        compiled_truth: 'Default row should remain separate.',
      });
      await source.putPage('people/alice', {
        type: 'person',
        title: 'KB Alice',
        compiled_truth: 'Alice source row.',
        timeline: 'Timeline body',
        frontmatter: { title: 'KB Alice', type: 'person', custom: 'preserve' },
        page_kind: 'markdown',
        effective_date: new Date('2026-05-01T00:00:00.000Z'),
        effective_date_source: 'date',
        import_filename: 'alice',
        chunker_version: 2,
        source_path: 'people/alice.md',
      }, { sourceId: 'kb-source' });
      await source.putPage('companies/acme', {
        type: 'company',
        title: 'ACME',
        compiled_truth: 'ACME source row.',
        source_path: 'companies/acme.md',
      }, { sourceId: 'kb-source' });

      await source.upsertChunks('people/alice', [{
        chunk_index: 0,
        chunk_text: 'Alice chunk',
        chunk_source: 'compiled_truth',
        model: 'voyage:voyage-4-large',
        token_count: 2,
      }], { sourceId: 'kb-source' });
      await source.addTag('people/alice', 'vip', { sourceId: 'kb-source' });
      await source.addTimelineEntry('people/alice', {
        date: '2026-05-02',
        source: 'fixture',
        summary: 'Shipped',
        detail: 'Source-scoped timeline.',
      }, { sourceId: 'kb-source' });
      await source.putRawData('people/alice', 'fixture', { ok: true }, { sourceId: 'kb-source' });
      await source.createVersion('people/alice', { sourceId: 'kb-source' });
      await source.addLink(
        'people/alice',
        'companies/acme',
        'works at',
        'employment',
        'manual',
        undefined,
        undefined,
        { fromSourceId: 'kb-source', toSourceId: 'kb-source' },
      );

      saveConfig({ engine: 'postgres', database_url: 'postgres://source-placeholder' });
      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath]);

      await target.connect({ engine: 'pglite', database_path: targetPath });
      await target.initSchema();

      expect(await target.getPage('people/alice')).not.toBeNull();
      const migrated = await target.getPage('people/alice', { sourceId: 'kb-source' });
      expect(migrated?.title).toBe('KB Alice');
      expect(migrated?.frontmatter.custom).toBe('preserve');

      const [metadata] = await target.executeRaw<{
        page_kind: string;
        effective_date: string;
        effective_date_source: string;
        import_filename: string;
        chunker_version: number;
        source_path: string;
      }>(
        `SELECT page_kind,
                effective_date::text AS effective_date,
                effective_date_source,
                import_filename,
                chunker_version,
                source_path
           FROM pages
          WHERE slug = 'people/alice' AND source_id = 'kb-source'`,
      );
      expect(metadata.page_kind).toBe('markdown');
      expect(metadata.effective_date).toContain('2026-05-01');
      expect(metadata.effective_date_source).toBe('date');
      expect(metadata.import_filename).toBe('alice');
      expect(Number(metadata.chunker_version)).toBe(2);
      expect(metadata.source_path).toBe('people/alice.md');

      expect(await target.getTags('people/alice', { sourceId: 'kb-source' })).toEqual(['vip']);
      expect(await target.getTimeline('people/alice', { sourceId: 'kb-source' })).toHaveLength(1);
      expect(await target.getRawData('people/alice', 'fixture', { sourceId: 'kb-source' })).toHaveLength(1);
      expect(await target.getChunks('people/alice', { sourceId: 'kb-source' })).toHaveLength(1);
      expect(await target.getVersions('people/alice', { sourceId: 'kb-source' })).toHaveLength(1);

      const links = await target.executeRaw<{ from_source_id: string; to_source_id: string; link_type: string }>(
        `SELECT f.source_id AS from_source_id,
                t.source_id AS to_source_id,
                l.link_type
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE f.slug = 'people/alice' AND t.slug = 'companies/acme'`,
      );
      expect(links).toEqual([{ from_source_id: 'kb-source', to_source_id: 'kb-source', link_type: 'employment' }]);
    } finally {
      await target.disconnect().catch(() => {});
      await source.disconnect().catch(() => {});
      rmSync(home, { recursive: true, force: true });
    }
  });
});
