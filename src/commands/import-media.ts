import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../core/engine.ts';
import type { ChunkInput, PageInput } from '../core/types.ts';
import { normalizeMediaExtraction, mediaExtractionToEvidence, type MediaEvidence, type MediaExtraction, type MediaExtractionKind } from '../core/media-extraction.ts';
import { chunkText } from '../core/chunkers/recursive.ts';
import { parseMarkdown, serializeMarkdown } from '../core/markdown.ts';
import { getMimeType, canAttachFiles, attachFileRecordWithEngine, type IngestMediaResult } from './files.ts';
import { createConfiguredCodexExtractionClient } from '../core/ai/codex-extraction-client.ts';

function usage(): never {
  console.error('Usage: gbrain import-media --slug <slug> --content-file <file.md> --extraction <file.json> [--source <source-id>] [--source-ref <ref>] [--raw-data-source <name>] [--media-file <path>] [--title <title>] [--type <kind>] [--no-file] [--no-embed]');
  process.exit(1);
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function defaultMediaSlug(filename: string): string {
  const stem = basename(filename, extname(filename))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
  return `media/evidence/${stem}`;
}

const MAX_OPENCLAW_IMAGE_BYTES = 8_000_000;

function defaultContent(title: string, evidence: MediaEvidence): string {
  const fmType = evidence.kind === 'pdf' ? 'media' : 'media';
  return `---\ntype: ${fmType}\ntitle: ${title}\n---\n\n${evidence.text}\n`;
}

function chunkMediaPage(page: PageInput, evidence: MediaEvidence): ChunkInput[] {
  const parts = [page.compiled_truth, evidence.text]
    .map(part => part.trim())
    .filter(Boolean);
  const searchableText = Array.from(new Set(parts)).join('\n\n');
  return chunkText(searchableText).map((c, idx) => ({
    chunk_index: idx,
    chunk_text: c.text,
    chunk_source: 'compiled_truth',
  }));
}

function mediaEvidenceHash(page: PageInput, evidence: MediaEvidence): string {
  return createHash('sha256')
    .update(stableStringify({
      title: page.title,
      type: page.type,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline || '',
      frontmatter: page.frontmatter || {},
      evidence,
    }))
    .digest('hex');
}

function parseMediaPageContent(content: string, slug: string, fallbackTitle: string, evidence: MediaEvidence): PageInput {
  const parsed = parseMarkdown(content, `${slug}.md`);
  return {
    title: parsed.title || fallbackTitle,
    type: 'media',
    compiled_truth: parsed.compiled_truth || evidence.text,
    timeline: parsed.timeline || '',
    frontmatter: {
      ...parsed.frontmatter,
      media_type: evidence.kind,
      source_ref: evidence.sourceRef,
      evidence_schema: evidence.schemaVersion,
      ingestion: 'media-evidence-mvp',
    },
  };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rawDataEqualsExisting(rows: Array<{ data: unknown }>, evidence: MediaEvidence): boolean {
  if (rows.length !== 1) return false;
  const existing = typeof rows[0]?.data === 'string'
    ? JSON.parse(rows[0].data as string)
    : rows[0]?.data;
  return stableStringify(existing) === stableStringify(evidence);
}

function pageMatchesExisting(existing: Awaited<ReturnType<BrainEngine['getPage']>>, page: PageInput): boolean {
  if (!existing) return false;
  return existing.content_hash === page.content_hash;
}

function fileKindOverride(explicit: string | undefined, extraction: MediaExtraction, mimeType: string | null): MediaExtractionKind {
  if (explicit && ['image', 'pdf', 'video', 'audio'].includes(explicit)) return explicit as MediaExtractionKind;
  if (mimeType === 'application/pdf') return 'pdf';
  return extraction.kind;
}

export async function importNormalizedMediaEvidence(
  engine: BrainEngine,
  opts: {
    slug: string;
    content: string;
    evidence: MediaEvidence;
    rawDataSource?: string;
    mediaFilePath?: string;
    pageTitle?: string;
    sourceId?: string;
    noFile?: boolean;
  },
): Promise<IngestMediaResult> {
  const pageTitle = opts.pageTitle || opts.evidence.sourceRef || opts.slug;
  const compiledTruth = opts.evidence.text;
  if (!compiledTruth.trim()) throw new Error('Normalized evidence text is empty.');

  const filePath = opts.mediaFilePath;
  const mimeType = filePath ? getMimeType(filePath) : null;
  const stat = filePath && existsSync(filePath) ? statSync(filePath) : null;
  const filename = filePath ? basename(filePath) : undefined;

  const fileFrontmatter: Record<string, unknown> = {
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(stat ? { size_bytes: stat.size } : {}),
  };

  const rawDataSource = opts.rawDataSource ?? 'media-extraction';
  const sourceId = opts.sourceId ?? 'default';
  const sourceOpts = { sourceId };
  const page: PageInput = parseMediaPageContent(opts.content, opts.slug, pageTitle, opts.evidence);
  page.frontmatter = {
    ...(page.frontmatter || {}),
    ...fileFrontmatter,
  };
  const contentHash = mediaEvidenceHash(page, opts.evidence);
  page.content_hash = contentHash;

  const existing = await engine.getPage(opts.slug, sourceOpts);
  const existingRawData = existing ? await engine.getRawData(opts.slug, rawDataSource, sourceOpts) : [];
  const filesTableAvailable = filePath && !opts.noFile ? await canAttachFiles(engine) : false;
  const unchanged = pageMatchesExisting(existing, page) && rawDataEqualsExisting(existingRawData, opts.evidence);
  if (!unchanged) {
    await engine.transaction(async (tx) => {
      if (existing && !unchanged) await tx.createVersion(opts.slug, sourceOpts);
      await tx.putPage(opts.slug, page, sourceOpts);
      await tx.putRawData(opts.slug, rawDataSource, opts.evidence as unknown as object, sourceOpts);
      const chunks = chunkMediaPage(page, opts.evidence);
      if (chunks.length > 0) await tx.upsertChunks(opts.slug, chunks, sourceOpts);
      else await tx.deleteChunks(opts.slug, sourceOpts);
    });
  }

  let storagePath: string | null = null;
  let fileAttached = false;
  if (filePath && !opts.noFile) {
    storagePath = `${opts.slug}/${basename(filePath)}`;
    if (filesTableAvailable) {
      await attachFileRecordWithEngine(engine, opts.slug, filePath, mimeType, stat?.size ?? 0, sourceId);
      fileAttached = true;
    }
  }

  if (!unchanged) {
    await engine.logIngest({
      source_id: sourceId,
      source_type: 'media',
      source_ref: filePath || opts.slug,
      pages_updated: [opts.slug],
      summary: `Imported normalized ${opts.evidence.kind} evidence for ${opts.slug}`,
    });
  }

  return {
    slug: opts.slug,
    fileAttached,
    storagePath,
    rawDataSource,
    chunksExpected: chunkMediaPage(page, opts.evidence).length,
  };
}

export async function runImportMedia(engine: BrainEngine, args: string[]) {
  const slug = getFlag(args, '--slug');
  const contentFile = getFlag(args, '--content-file');
  const extractionFile = getFlag(args, '--extraction');
  const sourceId = getFlag(args, '--source-id') ?? getFlag(args, '--source');
  const sourceRef = getFlag(args, '--source-ref');
  const rawDataSource = getFlag(args, '--raw-data-source');
  const mediaFilePath = getFlag(args, '--media-file');
  const title = getFlag(args, '--title');
  const type = getFlag(args, '--type');
  const noEmbed = args.includes('--no-embed');
  const noFile = args.includes('--no-file');

  if (!slug || !extractionFile) usage();
  if ((contentFile && !existsSync(contentFile)) || !existsSync(extractionFile) || (mediaFilePath && !existsSync(mediaFilePath))) usage();

  const extractionJson = JSON.parse(readFileSync(extractionFile, 'utf-8')) as unknown;
  const normalized = normalizeMediaExtraction(extractionJson);
  const evidence = mediaExtractionToEvidence({
    ...normalized,
    kind: fileKindOverride(type, normalized, mediaFilePath ? getMimeType(mediaFilePath) : null),
    sourceRef: sourceRef || mediaFilePath || normalized.sourceRef || normalized.title,
  });

  const finalTitle = title || normalized.title || (mediaFilePath ? basename(mediaFilePath) : slug);
  const existing = await engine.getPage(slug, { sourceId: sourceId ?? 'default' });
  const content = contentFile
    ? readFileSync(contentFile, 'utf-8')
    : existing
      ? serializeMarkdown(existing.frontmatter || {}, existing.compiled_truth || '', existing.timeline || '', {
          type: existing.type,
          title: existing.title,
          tags: [],
        })
      : defaultContent(finalTitle, evidence);

  const result = await importNormalizedMediaEvidence(engine, {
    slug,
    content,
    evidence,
    rawDataSource: rawDataSource ?? 'gbrain.media-evidence.v1',
    mediaFilePath,
    pageTitle: finalTitle,
    sourceId,
    noFile,
  });

  console.log(JSON.stringify({
    status: 'imported',
    slug: result.slug,
    source_id: sourceId ?? 'default',
    source_ref: evidence.sourceRef,
    raw_data_source: result.rawDataSource,
    segment_count: evidence.segments.length,
    evidence_text_length: evidence.text.length,
    file_attached: result.fileAttached,
    storage_path: result.storagePath,
    no_embed: noEmbed,
  }, null, 2));
}

async function resolveIngestExtractionFile(
  mediaFile: string,
  extractionFile: string,
  kindHint: string | undefined,
  title: string | undefined,
): Promise<{ extractionFile: string; cleanupDir?: string }> {
  if (extractionFile !== 'openclaw') return { extractionFile };

  const client = createConfiguredCodexExtractionClient();
  if (!client) {
    throw new Error('gbrain ingest-media --extract openclaw requires GBRAIN_OPENCLAW_GATEWAY_URL/OPENCLAW_GATEWAY_URL or GBRAIN_OPENCLAW_COMPLETION_COMMAND');
  }

  const size = statSync(mediaFile).size;
  const mimeType = getMimeType(mediaFile);
  const inferredKind = inferOpenClawExtractionKind(mediaFile, mimeType, kindHint);
  if (inferredKind === 'image' && size > MAX_OPENCLAW_IMAGE_BYTES) {
    throw new Error(`gbrain ingest-media --extract openclaw only supports image inputs up to ${MAX_OPENCLAW_IMAGE_BYTES} bytes; got ${size}`);
  }
  if (inferredKind === 'image' && !client.supportsFileMedia) {
    throw new Error('gbrain ingest-media --extract openclaw image extraction requires GBRAIN_OPENCLAW_GATEWAY_URL/OPENCLAW_GATEWAY_URL; command fallback only supports text-backed media');
  }
  const sourceRef = mediaFile;
  const extraction = await client.extractMedia<MediaExtraction>({
    kind: inferredKind,
    sourceRef,
    title,
    ...(inferredKind === 'image'
      ? {
          file: {
            name: basename(mediaFile),
            ...(mimeType ? { mime: mimeType } : {}),
            base64: readFileSync(mediaFile).toString('base64'),
          },
        }
      : { text: readTextBackedMedia(mediaFile, size, inferredKind) }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-extraction-'));
  const out = join(dir, 'extraction.json');
  writeFileSync(out, JSON.stringify(extraction, null, 2) + '\n');
  return { extractionFile: out, cleanupDir: dir };
}

function inferOpenClawExtractionKind(mediaFile: string, mimeType: string | null, kindHint: string | undefined): MediaExtractionKind {
  const ext = extname(mediaFile).toLowerCase();
  if (kindHint && ['image', 'pdf', 'video', 'audio'].includes(kindHint)) return kindHint as MediaExtractionKind;
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (isTextBackedExtension(ext)) return 'pdf';
  throw new Error(`gbrain ingest-media --extract openclaw does not support ${ext || 'unknown'} files yet; pass text/markdown/transcript content or an image`);
}

function isTextBackedExtension(ext: string): boolean {
  return ['', '.txt', '.md', '.markdown', '.srt', '.vtt', '.json'].includes(ext);
}

function assertTextBackedDocumentExtension(mediaFile: string, kind: MediaExtractionKind): void {
  const ext = extname(mediaFile).toLowerCase();
  if (kind === 'pdf' && ext === '.pdf') {
    throw new Error('gbrain ingest-media --extract openclaw supports text-backed PDF content today; binary PDF extraction is not claimed yet');
  }
  if (kind === 'pdf' && !isTextBackedExtension(ext)) {
    throw new Error(`gbrain ingest-media --extract openclaw supports text-backed document inputs today; ${ext || 'unknown'} files are not claimed yet`);
  }
  if ((kind === 'video' || kind === 'audio') && !isTextBackedExtension(ext)) {
    throw new Error(`gbrain ingest-media --extract openclaw supports ${kind} transcript/text files for today; binary ${kind} understanding is not claimed yet`);
  }
}

function readTextBackedMedia(mediaFile: string, size: number, kind: MediaExtractionKind): string {
  const maxTextBytes = 1_000_000;
  if (size > maxTextBytes) {
    throw new Error(`gbrain ingest-media --extract openclaw only supports ${kind} text/transcript inputs up to ${maxTextBytes} bytes; got ${size}`);
  }
  assertTextBackedDocumentExtension(mediaFile, kind);
  return readFileSync(mediaFile, 'utf-8');
}

export async function runIngestMedia(engine: BrainEngine, args: string[]) {
  const mediaFile = args.find(a => !a.startsWith('--'));
  const extractionFile = getFlag(args, '--extract');
  const slug = getFlag(args, '--slug');
  const title = getFlag(args, '--title');
  const source = getFlag(args, '--source');
  const sourceRef = getFlag(args, '--source-ref');
  const type = getFlag(args, '--type');
  const noFile = args.includes('--no-file');
  const noEmbed = args.includes('--no-embed');

  const contentFile = getFlag(args, '--content-file');
  if (!mediaFile || !extractionFile) {
    console.error('Usage: gbrain ingest-media <file> --extract <json|openclaw> [--slug <s>] [--title <t>] [--source <source-id>] [--source-ref <ref>] [--type <kind>] [--content-file <file.md>] [--no-file] [--no-embed]');
    process.exit(1);
  }

  const resolved = await resolveIngestExtractionFile(mediaFile, extractionFile, type, title);

  try {
    await runImportMedia(engine, [
      '--slug', slug || defaultMediaSlug(mediaFile),
      '--extraction', resolved.extractionFile,
      ...(contentFile ? ['--content-file', contentFile] : []),
      '--media-file', mediaFile,
      '--raw-data-source', 'gbrain.media-evidence.v1',
      ...(title ? ['--title', title] : []),
      ...(source ? ['--source', source] : []),
      ...(sourceRef ? ['--source-ref', sourceRef] : []),
      ...(type ? ['--type', type] : []),
      ...(noFile ? ['--no-file'] : []),
      ...(noEmbed ? ['--no-embed'] : []),
    ]);
  } finally {
    if (resolved.cleanupDir) {
      rmSync(resolved.cleanupDir, { recursive: true, force: true });
    }
  }
}
