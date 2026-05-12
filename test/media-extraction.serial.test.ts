import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { importMediaEvidence } from '../src/core/import-file.ts';
import { mediaExtractionToEvidence, normalizeMediaExtraction } from '../src/core/media-extraction.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runImportMedia } from '../src/commands/import-media.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

describe('media extraction normalization', () => {
  test('normalizes screenshot/pdf/video fixtures into evidence text', () => {
    for (const name of ['media-extraction-image.json', 'media-extraction-pdf.json', 'media-extraction-video.json']) {
      const raw = JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'));
      const extraction = normalizeMediaExtraction(raw);
      const evidence = mediaExtractionToEvidence(extraction);
      expect(extraction.schemaVersion).toBe('gbrain.media-extraction.v1');
      expect(evidence.schemaVersion).toBe('gbrain.media-evidence.v1');
      expect(evidence.segments.length).toBeGreaterThan(0);
      expect(evidence.text.length).toBeGreaterThan(10);
    }
  });

  test('rejects payloads without segments', () => {
    expect(() => normalizeMediaExtraction({ kind: 'image', segments: [] })).toThrow(/at least one segment/);
  });
});

describe('media evidence import', () => {
  const engine = new PGLiteEngine();

  beforeAll(async () => {
    await engine.connect({});
    await engine.initSchema();
  }, 30000);

  beforeEach(async () => {
    await resetPgliteState(engine);
  }, 30000);

  afterAll(async () => {
    await engine.disconnect();
  }, 30000);

  test('stores normalized media evidence as raw_data sidecar', async () => {
    const content = `---\ntype: media\ntitle: Stripe login screenshot\n---\n\nStripe login screenshot evidence.`;
    const extraction = JSON.parse(readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8'));

    const result = await importMediaEvidence(engine, 'media/stripe-login-screenshot', content, extraction, { noEmbed: true });
    expect(result.status).toBe('imported');

    const rows = await engine.getRawData('media/stripe-login-screenshot', 'media-extraction');
    expect(rows.length).toBe(1);
    const data = rows[0]?.data as any;
    expect(data.schemaVersion).toBe('gbrain.media-evidence.v1');
    expect(data.kind).toBe('image');
    expect(data.text).toContain('Stripe API key invalid');
    expect(data.segments[0].locator.bbox).toEqual([0.1, 0.2, 0.8, 0.35]);
  });

  test('CLI import-media ingests extraction fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-media-import-'));
    const contentPath = join(dir, 'page.md');
    const extractionPath = join(dir, 'evidence.json');
    writeFileSync(contentPath, `---\ntype: media\ntitle: Demo video\n---\n\nDemo video evidence page.`);
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-video.json'), 'utf-8'));

    try {
      await runImportMedia(engine, [
        '--slug', 'media/demo-video',
        '--content-file', contentPath,
        '--extraction', extractionPath,
        '--no-embed',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const page = await engine.getPage('media/demo-video');
    expect(page?.title).toBe('Demo video');
    expect(page?.compiled_truth).toBe('Demo video evidence page.');
    expect(page?.frontmatter.evidence_schema).toBe('gbrain.media-evidence.v1');

    const raw = await engine.getRawData('media/demo-video', 'gbrain.media-evidence.v1');
    expect(raw.length).toBe(1);
    const data = raw[0]?.data as any;
    expect(data.kind).toBe('video');
    expect(data.segments.some((segment: any) => segment.kind === 'transcript_segment')).toBe(true);
  });

  test('CLI import-media --source writes page, raw data, chunks, and ingest log to that source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-media-import-source-'));
    const contentPath = join(dir, 'page.md');
    const extractionPath = join(dir, 'evidence.json');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('media-corpus', 'Media Corpus', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    );
    writeFileSync(contentPath, `---\ntype: media\ntitle: Source-scoped media\ncustom_flag: keep-me\n---\n\nSource-scoped media evidence page.`);
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8'));

    try {
      await runImportMedia(engine, [
        '--slug', 'media/source-scoped',
        '--content-file', contentPath,
        '--extraction', extractionPath,
        '--source', 'media-corpus',
        '--source-ref', 'fixture:stripe-screenshot',
        '--no-embed',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(await engine.getPage('media/source-scoped')).toBeNull();
    const page = await engine.getPage('media/source-scoped', { sourceId: 'media-corpus' });
    expect(page?.frontmatter.custom_flag).toBe('keep-me');
    expect(page?.frontmatter.source_ref).toBe('fixture:stripe-screenshot');

    expect(await engine.getRawData('media/source-scoped', 'gbrain.media-evidence.v1', { sourceId: 'default' })).toHaveLength(0);
    const raw = await engine.getRawData('media/source-scoped', 'gbrain.media-evidence.v1', { sourceId: 'media-corpus' });
    expect(raw).toHaveLength(1);
    const chunks = await engine.getChunks('media/source-scoped', { sourceId: 'media-corpus' });
    expect(chunks.some(c => c.chunk_text.includes('Stripe API key invalid'))).toBe(true);
    const log = await engine.getIngestLog({ limit: 5 });
    expect(log.find(entry => entry.source_ref === 'media/source-scoped')?.source_id).toBe('media-corpus');
  });
});
