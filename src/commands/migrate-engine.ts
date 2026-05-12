/**
 * Engine migration: transfer brain data between PGLite and Postgres.
 *
 * Usage:
 *   gbrain migrate --to supabase [--url <connection_string>]
 *   gbrain migrate --to pglite [--path <db_path>]
 *   gbrain migrate --to <engine> --force  (overwrite non-empty target)
 */

import { createEngine } from '../core/engine-factory.ts';
import { loadConfig, saveConfig, toEngineConfig, gbrainPath, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EffectiveDateSource, EngineConfig } from '../core/types.ts';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface MigrateOpts {
  targetEngine: 'postgres' | 'pglite';
  targetUrl?: string;
  targetPath?: string;
  force: boolean;
}

function parseArgs(args: string[]): MigrateOpts {
  const toIdx = args.indexOf('--to');
  if (toIdx === -1 || !args[toIdx + 1]) {
    throw new Error('Usage: gbrain migrate --to <supabase|pglite> [--url <url>] [--path <path>] [--force]');
  }

  const targetRaw = args[toIdx + 1];
  const targetEngine = targetRaw === 'supabase' ? 'postgres' : targetRaw as 'postgres' | 'pglite';
  if (targetEngine !== 'postgres' && targetEngine !== 'pglite') {
    throw new Error(`Unknown target engine: "${targetRaw}". Use: supabase or pglite`);
  }

  const urlIdx = args.indexOf('--url');
  const pathIdx = args.indexOf('--path');

  return {
    targetEngine,
    targetUrl: urlIdx !== -1 ? args[urlIdx + 1] : undefined,
    targetPath: pathIdx !== -1 ? args[pathIdx + 1] : undefined,
    force: args.includes('--force'),
  };
}

function getManifestPath(): string {
  return gbrainPath('migrate-manifest.json');
}

interface MigrateManifest {
  completed_slugs: string[];
  target_engine: string;
  started_at: string;
}

interface LinkMigrationRow {
  from_slug: string;
  to_slug: string;
  from_source_id: string;
  to_source_id: string;
  link_type: string;
  context: string | null;
  link_source: string | null;
  origin_slug: string | null;
  origin_field: string | null;
  origin_source_id: string | null;
}

interface PageMigrationMetadata {
  page_kind: 'markdown' | 'code' | 'image' | null;
  effective_date: string | Date | null;
  effective_date_source: EffectiveDateSource | null;
  import_filename: string | null;
  chunker_version: number | string | null;
  source_path: string | null;
}

interface SourceMigrationRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: string | Date | null;
  config: unknown;
  chunker_version: string | null;
  archived: boolean | null;
  archived_at: string | Date | null;
  archive_expires_at: string | Date | null;
  created_at: string | Date | null;
}

function normalizeDateValue(raw: string | Date | null | undefined): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return raw instanceof Date ? raw : new Date(raw);
}

function normalizeJsonValue(raw: unknown): string {
  if (raw == null) return '{}';
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function loadManifest(): MigrateManifest | null {
  const path = getManifestPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveManifest(manifest: MigrateManifest): void {
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

function clearManifest(): void {
  const path = getManifestPath();
  if (existsSync(path)) unlinkSync(path);
}

export async function runMigrateEngine(sourceEngine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Check source != target
  if (config.engine === opts.targetEngine) {
    console.error(`Already using ${opts.targetEngine} engine. Nothing to migrate.`);
    process.exit(1);
  }

  // Build target config
  const targetConfig: EngineConfig = { engine: opts.targetEngine };
  if (opts.targetEngine === 'postgres') {
    targetConfig.database_url = opts.targetUrl || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (!targetConfig.database_url) {
      console.error('Target is Supabase but no connection string provided. Use: --url <connection_string>');
      process.exit(1);
    }
  } else {
    targetConfig.database_path = opts.targetPath || gbrainPath('brain.pglite');
  }

  // Connect to target
  console.log(`Connecting to target (${opts.targetEngine})...`);
  const targetEngine = await createEngine(targetConfig);
  await targetEngine.connect(targetConfig);
  await targetEngine.initSchema();

  // Check if target has data
  const targetStats = await targetEngine.getStats();
  if (targetStats.page_count > 0 && !opts.force) {
    console.error(`Target brain is not empty (${targetStats.page_count} pages).`);
    console.error('Run with --force to overwrite, or migrate to an empty brain.');
    await targetEngine.disconnect();
    process.exit(1);
  }

  if (targetStats.page_count > 0 && opts.force) {
    console.log('--force: wiping target brain...');
    // v0.18.0+ multi-source: deletePage(slug) is now source-scoped (defaults
    // to 'default'), so per-page iteration would skip non-default-source
    // rows. migrate-engine --force is a destructive wipe across the entire
    // brain — all sources, all pages — so we issue raw deletes that match
    // the original semantic. Page deletion cascades through content_chunks /
    // page_links / tags / timeline_entries / page_versions via existing FKs.
    await targetEngine.executeRaw('DELETE FROM pages');
    await targetEngine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  }

  // Copy source rows before pages so non-default-source page inserts satisfy
  // the pages.source_id foreign key. Earlier migrations implicitly assumed
  // the default source existed and failed on a fresh target for any multi-
  // source brain.
  const sources = await sourceEngine.executeRaw<SourceMigrationRow>(
    `SELECT id,
            name,
            local_path,
            last_commit,
            last_sync_at,
            config,
            chunker_version,
            archived,
            archived_at,
            archive_expires_at,
            created_at
       FROM sources
      ORDER BY (id = 'default') DESC, id`,
  );
  for (const source of sources) {
    await targetEngine.executeRaw(
      `INSERT INTO sources (
         id, name, local_path, last_commit, last_sync_at, config,
         chunker_version, archived, archived_at, archive_expires_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb,
               $7, COALESCE($8, false), $9::timestamptz, $10::timestamptz, COALESCE($11::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         local_path = EXCLUDED.local_path,
         last_commit = EXCLUDED.last_commit,
         last_sync_at = EXCLUDED.last_sync_at,
         config = EXCLUDED.config,
         chunker_version = EXCLUDED.chunker_version,
         archived = EXCLUDED.archived,
         archived_at = EXCLUDED.archived_at,
         archive_expires_at = EXCLUDED.archive_expires_at`,
      [
        source.id,
        source.name,
        source.local_path,
        source.last_commit,
        normalizeDateValue(source.last_sync_at),
        normalizeJsonValue(source.config),
        source.chunker_version,
        source.archived ?? false,
        normalizeDateValue(source.archived_at),
        normalizeDateValue(source.archive_expires_at),
        normalizeDateValue(source.created_at),
      ],
    );
  }

  // Load or create manifest for resume
  let manifest = loadManifest();
  if (manifest && manifest.target_engine !== opts.targetEngine) {
    console.log('Previous migration was to a different target. Starting fresh.');
    manifest = null;
  }
  // v0.32.8 F8: manifest keys are now `${source_id}::${slug}` so multi-source
  // migrations don't collide on same-slug-different-source pages. Pre-v0.32.8
  // entries were bare slugs; we keep treating those as default-source for
  // back-compat resume.
  const completedSet = new Set(manifest?.completed_slugs || []);
  const makeManifestKey = (sourceId: string, slug: string): string =>
    sourceId === 'default' ? slug : `${sourceId}::${slug}`;
  if (!manifest) {
    manifest = {
      completed_slugs: [],
      target_engine: opts.targetEngine,
      started_at: new Date().toISOString(),
    };
  }

  // Get all source pages
  const sourceStats = await sourceEngine.getStats();
  const allPages = await sourceEngine.listPages({ limit: 100000 });
  const pagesToMigrate = allPages.filter(p => !completedSet.has(makeManifestKey(p.source_id, p.slug)));

  console.log(`Migrating ${pagesToMigrate.length} pages (${allPages.length} total, ${completedSet.size} already done)...`);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('migrate.copy_pages', pagesToMigrate.length);

  let migrated = 0;
  for (const page of pagesToMigrate) {
    // v0.32.8 F8: thread source_id end-to-end so multi-source pages migrate
    // intact. Pre-fix: putPage / getTags / getTimeline / getRawData / getLinks
    // all silently defaulted to source_id='default', so non-default-source
    // tags / timeline / raw / links were either dropped or attached to the
    // wrong row.
    const sourceOpts = { sourceId: page.source_id };

    // Copy page (preserve source_id)
    const [metadata] = await sourceEngine.executeRaw<PageMigrationMetadata>(
      `SELECT page_kind,
              effective_date,
              effective_date_source,
              import_filename,
              chunker_version,
              source_path
         FROM pages
        WHERE slug = $1 AND source_id = $2`,
      [page.slug, page.source_id],
    );
    await targetEngine.putPage(page.slug, {
      type: page.type,
      title: page.title,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline,
      frontmatter: page.frontmatter,
      content_hash: page.content_hash,
      ...(metadata?.page_kind ? { page_kind: metadata.page_kind } : {}),
      ...(metadata?.effective_date !== undefined ? { effective_date: normalizeDateValue(metadata.effective_date) } : {}),
      ...(metadata?.effective_date_source !== undefined ? { effective_date_source: metadata.effective_date_source } : {}),
      ...(metadata?.import_filename !== undefined ? { import_filename: metadata.import_filename } : {}),
      ...(metadata?.chunker_version != null ? { chunker_version: Number(metadata.chunker_version) } : {}),
      ...(metadata?.source_path !== undefined ? { source_path: metadata.source_path } : {}),
    }, sourceOpts);

    // Copy chunks with embeddings.
    const chunks = await sourceEngine.getChunksWithEmbeddings(page.slug, sourceOpts);
    if (chunks.length > 0) {
      await targetEngine.upsertChunks(page.slug, chunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: c.embedding || undefined,
        model: c.model,
        token_count: c.token_count || undefined,
      })), sourceOpts);
    }

    // Copy tags
    const tags = await sourceEngine.getTags(page.slug, sourceOpts);
    for (const tag of tags) {
      await targetEngine.addTag(page.slug, tag, sourceOpts);
    }

    // Copy timeline
    const timeline = await sourceEngine.getTimeline(page.slug, sourceOpts);
    for (const entry of timeline) {
      await targetEngine.addTimelineEntry(page.slug, { // gbrain-allow-direct-insert: migrate-engine copies existing derived timeline rows during database migration
        date: entry.date,
        source: entry.source,
        summary: entry.summary,
        detail: entry.detail,
      }, sourceOpts);
    }

    // Copy raw data
    const rawData = await sourceEngine.getRawData(page.slug, undefined, sourceOpts);
    for (const rd of rawData) {
      await targetEngine.putRawData(page.slug, rd.source, rd.data, sourceOpts);
    }

    // Copy versions
    const versions = await sourceEngine.getVersions(page.slug, sourceOpts);
    if (versions.length > 0) {
      // Resume-safe exact copy: clear any partially copied snapshots for this
      // target page, then preserve the original snapshot payload + timestamp.
      await targetEngine.executeRaw(
        `DELETE FROM page_versions
          WHERE page_id IN (
            SELECT id FROM pages WHERE slug = $1 AND source_id = $2
          )`,
        [page.slug, page.source_id],
      );
      for (const version of versions) {
        const snapshotAt = version.snapshot_at instanceof Date
          ? version.snapshot_at.toISOString()
          : version.snapshot_at;
        await targetEngine.executeRaw(
          `INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at)
           SELECT id, $2, $3::jsonb, $4
             FROM pages
            WHERE slug = $1 AND source_id = $5`,
          [
            page.slug,
            version.compiled_truth,
            JSON.stringify(version.frontmatter ?? {}),
            snapshotAt,
            page.source_id,
          ],
        );
      }
    }

    // Track progress with composite key so multi-source resume is correct.
    manifest!.completed_slugs.push(makeManifestKey(page.source_id, page.slug));
    saveManifest(manifest!);
    migrated++;
    progress.tick(1, page.slug);
  }
  progress.finish();

  // Copy links (after all pages exist in target).
  // v0.32.8 F8: thread source_id so cross-source links migrate correctly.
  console.log('Copying links...');
  progress.start('migrate.copy_links', allPages.length);
  for (const page of allPages) {
    const links = await sourceEngine.executeRaw<LinkMigrationRow>(
      `SELECT f.slug AS from_slug,
              t.slug AS to_slug,
              f.source_id AS from_source_id,
              t.source_id AS to_source_id,
              l.link_type,
              l.context,
              l.link_source,
              o.slug AS origin_slug,
              l.origin_field,
              o.source_id AS origin_source_id
         FROM links l
         JOIN pages f ON f.id = l.from_page_id
         JOIN pages t ON t.id = l.to_page_id
         LEFT JOIN pages o ON o.id = l.origin_page_id
        WHERE f.slug = $1 AND f.source_id = $2`,
      [page.slug, page.source_id],
    );
    for (const link of links) {
      await targetEngine.addLink( // gbrain-allow-direct-insert: migrate-engine copies existing derived link rows during database migration
        link.from_slug, link.to_slug,
        link.context ?? undefined,
        link.link_type,
        link.link_source ?? undefined,
        link.origin_slug ?? undefined,
        link.origin_field ?? undefined,
        {
          fromSourceId: link.from_source_id,
          toSourceId: link.to_source_id,
          originSourceId: link.origin_source_id ?? undefined,
        },
      );
    }
    progress.tick(1);
  }
  progress.finish();

  // Copy config (selective)
  const configKeys = ['embedding_model', 'embedding_dimensions', 'chunk_strategy'];
  for (const key of configKeys) {
    const val = await sourceEngine.getConfig(key);
    if (val) await targetEngine.setConfig(key, val);
  }

  // Update local config
  const newConfig: GBrainConfig = {
    engine: opts.targetEngine,
    ...(opts.targetEngine === 'postgres'
      ? { database_url: targetConfig.database_url }
      : { database_path: targetConfig.database_path }),
  };
  saveConfig(newConfig);

  // Clean up
  clearManifest();

  console.log(`\nMigration complete. ${migrated} pages transferred.`);
  console.log(`Config updated to engine: ${opts.targetEngine}`);
  if (config.engine === 'pglite' && config.database_path) {
    console.log(`Original PGLite brain preserved at ${config.database_path} (backup).`);
  }

  // Post-migrate verification: confirm the target is healthy before we
  // leave the user. Catches incomplete copies, schema drift, and missing
  // embeddings immediately instead of on next CLI use. Non-fatal — prints
  // warnings and keeps going so the user sees the full picture.
  console.log('\nVerifying target...');
  try {
    await verifyTarget(targetEngine, sourceStats.page_count);
  } catch (e) {
    console.warn(`  Verification could not complete: ${e instanceof Error ? e.message : String(e)}`);
  }

  await targetEngine.disconnect();
}

/**
 * Lightweight doctor-style verify run against the migrated target.
 * Prints a small table of signals; does not exit. Callers own engine
 * lifecycle.
 */
async function verifyTarget(engine: BrainEngine, expectedPages: number): Promise<void> {
  const stats = await engine.getStats();
  if (stats.page_count === expectedPages) {
    console.log(`  ok  pages: ${stats.page_count} (matches source)`);
  } else {
    console.warn(`  WARN pages: ${stats.page_count} (source had ${expectedPages})`);
  }

  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      console.log(`  ok  embeddings: ${pct}% coverage, ${health.missing_embeddings} missing`);
    } else {
      console.warn(`  WARN embeddings: ${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale`);
    }
  } catch (e) {
    console.warn(`  WARN embeddings: could not measure (${e instanceof Error ? e.message : String(e)})`);
  }

  try {
    const version = await engine.getConfig('version');
    const { LATEST_VERSION } = await import('../core/migrate.ts');
    const schemaVersion = parseInt(version || '0', 10);
    if (schemaVersion >= LATEST_VERSION) {
      console.log(`  ok  schema: version ${schemaVersion}`);
    } else {
      console.warn(`  WARN schema: version ${schemaVersion} (latest: ${LATEST_VERSION}). Run: gbrain apply-migrations --yes`);
    }
  } catch {
    console.warn('  WARN schema: version could not be read');
  }

  console.log('  Full health check: gbrain doctor');
}
