import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runIngestMedia } from '../src/commands/import-media.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

describe('ingest-media normalized integration', () => {
  const engine = new PGLiteEngine();

  beforeAll(async () => {
    await engine.connect({});
    await engine.initSchema();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('routes ingest-media through normalized evidence and materializes page/raw_data/chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-'));
    const mediaPath = join(dir, 'receipt.png');
    const extractionPath = join(dir, 'receipt.extraction.json');
    writeFileSync(mediaPath, 'fake-image-binary');
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8'));

    try {
      await runIngestMedia(engine, [
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt',
        '--title', 'Store receipt',
      ]);

      const versionsBefore = await engine.getVersions('media/evidence/receipt');
      const ingestLogBefore = await engine.getIngestLog({ limit: 10 });
      await runIngestMedia(engine, [
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt',
        '--title', 'Store receipt',
      ]);
      const versionsAfter = await engine.getVersions('media/evidence/receipt');
      const ingestLogAfter = await engine.getIngestLog({ limit: 10 });
      expect(versionsAfter.length).toBe(versionsBefore.length);
      expect(ingestLogAfter.length).toBe(ingestLogBefore.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const page = await engine.getPage('media/evidence/receipt');
    expect(page).toBeTruthy();
    expect(page?.type).toBe('media');
    expect(page?.title).toBe('Store receipt');
    expect(page?.frontmatter.evidence_schema).toBe('gbrain.media-evidence.v1');
    expect(page?.frontmatter.media_type).toBe('image');
    expect(page?.compiled_truth).toContain('Stripe API key invalid');

    const raw = await engine.getRawData('media/evidence/receipt', 'gbrain.media-evidence.v1');
    expect(raw.length).toBe(1);
    const data = raw[0]?.data as any;
    expect(data.schemaVersion).toBe('gbrain.media-evidence.v1');
    expect(data.kind).toBe('image');
    expect(data.sourceRef).toContain('receipt.png');
    expect(data.segments.length).toBeGreaterThan(0);
    expect(data.segments[0].locator.bbox).toEqual([0.1, 0.2, 0.8, 0.35]);

    const chunks = await engine.getChunks('media/evidence/receipt');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some(c => c.chunk_text.includes('Stripe API key invalid'))).toBe(true);
    expect(chunks.every(c => c.embedding === null)).toBe(true);

    const filesTableAvailable = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='files') AS exists`,
    );
    if (!filesTableAvailable[0]?.exists) {
      expect(page?.frontmatter.filename).toBe('receipt.png');
      expect(page?.frontmatter.mime_type).toBe('image/png');
    }
  }, 30000);

  test('can generate text-only extraction through GBRAIN_OPENCLAW_COMPLETION_COMMAND', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-openclaw-'));
    const mediaPath = join(dir, 'help-doc.md');
    const capturePath = join(dir, 'openclaw-request.json');
    const prevCommand = process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
    writeFileSync(mediaPath, '# Help Doc\n\nOpenClaw supports host-routed Codex extraction.');
    process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = `node -e "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{fs.writeFileSync(process.env.CAPTURE,s);process.stdout.write(JSON.stringify({schemaVersion:'gbrain.media-extraction.v1',kind:'pdf',title:'Help Doc',summary:'Host-routed extraction.',segments:[{id:'segment-0',kind:'page',summary:'Codex extraction works',transcriptText:'OpenClaw supports host-routed Codex extraction.'}]}));});"`;
    process.env.CAPTURE = capturePath;

    let payload: any;
    try {
      await runIngestMedia(engine, [
        mediaPath,
        '--extract', 'openclaw',
        '--slug', 'media/evidence/help-doc',
        '--title', 'Help Doc',
        '--no-file',
      ]);
      payload = JSON.parse(readFileSync(capturePath, 'utf-8'));
    } finally {
      if (prevCommand === undefined) delete process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND;
      else process.env.GBRAIN_OPENCLAW_COMPLETION_COMMAND = prevCommand;
      delete process.env.CAPTURE;
      rmSync(dir, { recursive: true, force: true });
    }

    const page = await engine.getPage('media/evidence/help-doc');
    expect(page?.compiled_truth).toContain('OpenClaw supports host-routed Codex extraction.');
    expect(payload.modelRef).toBe('openai-codex/gpt-5.4-mini');
    expect(payload.prompt).toContain('Help Doc');
    expect(payload.apiKey).toBeUndefined();
  }, 30000);

  test('updates page when frontmatter changes even if evidence and body are unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-frontmatter-'));
    const mediaPath = join(dir, 'receipt.png');
    const extractionPath = join(dir, 'receipt.extraction.json');
    const firstContent = join(dir, 'first.md');
    const secondContent = join(dir, 'second.md');
    writeFileSync(mediaPath, 'fake-image-binary');
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8'));
    writeFileSync(firstContent, '---\ntitle: Store receipt\nreviewed: false\n---\n\nSame curated receipt narrative.\n');
    writeFileSync(secondContent, '---\ntitle: Store receipt\nreviewed: true\n---\n\nSame curated receipt narrative.\n');

    try {
      await runIngestMedia(engine, [
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt',
        '--title', 'Store receipt',
        '--content-file', firstContent,
      ]);
      const before = await engine.getPage('media/evidence/receipt');
      expect(before?.frontmatter.reviewed).toBe(false);

      await runIngestMedia(engine, [
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt',
        '--title', 'Store receipt',
        '--content-file', secondContent,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const after = await engine.getPage('media/evidence/receipt');
    expect(after?.frontmatter.reviewed).toBe(true);
    const versions = await engine.getVersions('media/evidence/receipt');
    expect(versions.length).toBe(1);
  }, 30000);

  test('re-import without content-file preserves existing frontmatter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-media-preserve-frontmatter-'));
    const mediaPath = join(dir, 'receipt.png');
    const extractionPath = join(dir, 'receipt.extraction.json');
    const contentPath = join(dir, 'first.md');
    writeFileSync(mediaPath, 'fake-image-binary');
    writeFileSync(extractionPath, readFileSync(join(FIXTURES, 'media-extraction-image.json'), 'utf-8'));
    writeFileSync(contentPath, '---\ntitle: Store receipt\nreviewed: false\nowner: support\n---\n\nSame curated receipt narrative.\n');

    try {
      await runIngestMedia(engine, [
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt',
        '--content-file', contentPath,
      ]);
      await runIngestMedia(engine, [
        mediaPath,
        '--extract', extractionPath,
        '--slug', 'media/evidence/receipt',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const after = await engine.getPage('media/evidence/receipt');
    expect(after?.frontmatter.reviewed).toBe(false);
    expect(after?.frontmatter.owner).toBe('support');
  }, 30000);
});
