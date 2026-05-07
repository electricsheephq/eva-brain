import { execSync } from 'child_process';
import { readdirSync, lstatSync, existsSync, copyFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { saveConfig, loadConfig, loadGbrainEnv, toEngineConfig, gbrainPath, type GBrainConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import { getRecipe } from '../core/ai/recipes/index.ts';
import { configureGateway } from '../core/ai/gateway.ts';
import { appendCompletedMigration, loadCompletedMigrations } from '../core/preferences.ts';
import { migrations } from './migrations/index.ts';

export async function runInit(args: string[]) {
  const isSupabase = args.includes('--supabase');
  const isPGLite = args.includes('--pglite');
  const isNonInteractive = args.includes('--non-interactive');
  const isMigrateOnly = args.includes('--migrate-only');
  const jsonOutput = args.includes('--json');
  const urlIndex = args.indexOf('--url');
  const manualUrl = urlIndex !== -1 ? args[urlIndex + 1] : null;
  const keyIndex = args.indexOf('--key');
  const apiKey = keyIndex !== -1 ? args[keyIndex + 1] : null;
  const pathIndex = args.indexOf('--path');
  const customPath = pathIndex !== -1 ? args[pathIndex + 1] : null;

  // v0.14: AI provider selection.
  // --embedding-model PROVIDER:MODEL (verbose) or --model PROVIDER (shorthand, picks recipe default)
  const embModelIdx = args.indexOf('--embedding-model');
  const modelShortIdx = args.indexOf('--model');
  const embDimsIdx = args.indexOf('--embedding-dimensions');
  const expModelIdx = args.indexOf('--expansion-model');
  const chatModelIdx = args.indexOf('--chat-model');
  const aiOpts = await resolveAIOptions(
    embModelIdx !== -1 ? args[embModelIdx + 1] : null,
    modelShortIdx !== -1 ? args[modelShortIdx + 1] : null,
    embDimsIdx !== -1 ? parseInt(args[embDimsIdx + 1], 10) : null,
    expModelIdx !== -1 ? args[expModelIdx + 1] : null,
    chatModelIdx !== -1 ? args[chatModelIdx + 1] : null,
  );

  // Schema-only path: apply initSchema against the already-configured engine
  // without ever calling saveConfig. Used by apply-migrations, the stopgap
  // script, and the postinstall hook. Bare `gbrain init` defaults to PGLite
  // and overwrites any existing Postgres config — we must never take that
  // branch from a migration orchestrator.
  if (isMigrateOnly) {
    return initMigrateOnly({ jsonOutput });
  }

  // Explicit PGLite mode
  if (isPGLite || (!isSupabase && !manualUrl && !isNonInteractive)) {
    // Smart detection: scan for .md files unless --pglite flag forces it
    if (!isPGLite && !isSupabase) {
      const fileCount = countMarkdownFiles(process.cwd());
      if (fileCount >= 1000) {
        console.log(`Found ~${fileCount} .md files. For a brain this size, Supabase gives faster`);
        console.log('search and remote access ($25/mo). PGLite works too but search will be slower at scale.');
        console.log('');
        console.log('  gbrain init --supabase   Set up with Supabase (recommended for large brains)');
        console.log('  gbrain init --pglite     Use local PGLite anyway');
        console.log('');
        // Default to PGLite, let the user choose Supabase if they want
      }
    }

    return initPGLite({ jsonOutput, apiKey, customPath, aiOpts });
  }

  // Supabase/Postgres mode
  let databaseUrl: string;
  if (manualUrl) {
    databaseUrl = manualUrl;
  } else if (isNonInteractive) {
    const envUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (envUrl) {
      databaseUrl = envUrl;
    } else {
      console.error('--non-interactive requires --url <connection_string> or GBRAIN_DATABASE_URL env var');
      process.exit(1);
    }
  } else {
    databaseUrl = await supabaseWizard();
  }

  return initPostgres({ databaseUrl, jsonOutput, apiKey, aiOpts });
}

/**
 * Resolve AI provider options from CLI flags. Verbose form (--embedding-model
 * openai:text-embedding-3-large) overrides shorthand (--model openai which
 * expands to the recipe's first embedding model).
 */
async function resolveAIOptions(
  verbose: string | null,
  shorthand: string | null,
  dimsArg: number | null,
  expansion: string | null,
  chat: string | null,
): Promise<{ embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string }> {
  const out: { embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string } = {};

  if (verbose) {
    const [providerId, ...modelParts] = verbose.split(':');
    const modelId = modelParts.join(':');
    if (!providerId || !modelId) {
      console.error('Invalid --embedding-model. Expected provider:model.');
      process.exit(1);
    }
    const recipe = getRecipe(providerId);
    if (!recipe) {
      console.error(`Unknown provider: ${providerId}. Run \`gbrain providers list\` to see known providers.`);
      process.exit(1);
    }
    const embedding = recipe.touchpoints.embedding;
    if (!embedding) {
      console.error(`Provider ${providerId} does not support embeddings.`);
      process.exit(1);
    }
    if (embedding.models.length > 0 && !embedding.models.includes(modelId)) {
      console.error(`Model ${modelId} is not listed for provider ${providerId}. Known models: ${embedding.models.join(', ')}`);
      process.exit(1);
    }
    out.embedding_model = `${providerId}:${modelId}`;
    if (embedding.default_dims) out.embedding_dimensions = embedding.default_dims;
  } else if (shorthand) {
    const recipe = getRecipe(shorthand);
    if (!recipe) {
      console.error(`Unknown provider: ${shorthand}. Run \`gbrain providers list\` to see known providers.`);
      process.exit(1);
    }
    const firstModel = recipe.touchpoints.embedding?.models[0];
    if (!firstModel) {
      console.error(`Provider ${shorthand} has no embedding models listed. Use --embedding-model provider:model.`);
      process.exit(1);
    }
    out.embedding_model = `${shorthand}:${firstModel}`;
    out.embedding_dimensions = recipe.touchpoints.embedding!.default_dims;
  }

  if (dimsArg !== null && !Number.isNaN(dimsArg) && dimsArg > 0) {
    out.embedding_dimensions = dimsArg;
  } else if (out.embedding_model && out.embedding_dimensions === undefined) {
    // Derive default dims from the resolved recipe when verbose form was used.
    const providerId = out.embedding_model.split(':')[0];
    const recipe = getRecipe(providerId);
    if (recipe?.touchpoints.embedding?.default_dims) {
      out.embedding_dimensions = recipe.touchpoints.embedding.default_dims;
    }
  }

  if (out.embedding_model && out.embedding_dimensions === undefined) {
    console.error('Could not resolve embedding dimensions. Pass --embedding-dimensions <N>.');
    process.exit(1);
  }

  if (expansion) out.expansion_model = expansion;
  if (chat) out.chat_model = chat;

  return out;
}

/**
 * Apply the schema against the already-configured engine. No saveConfig.
 * No PGLite fallback when no config exists. Used by migration orchestrators
 * to bump an existing brain's schema to the latest version without
 * clobbering the user's chosen engine.
 */
function configureGatewayFromConfig(config: GBrainConfig): void {
  configureGateway({
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: config.provider_base_urls,
    provider_auth: config.provider_auth,
    env: loadGbrainEnv(),
  });
}

async function initMigrateOnly(opts: { jsonOutput: boolean }) {
  const config = loadConfig();
  if (!config) {
    const msg = 'No brain configured. Run `gbrain init` (interactive) or `gbrain init --pglite` / `gbrain init --supabase` first.';
    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'error', reason: 'no_config', message: msg }));
    } else {
      console.error(msg);
    }
    process.exit(1);
  }

  configureGatewayFromConfig(config);

  const engine = await createEngine(toEngineConfig(config));
  try {
    await engine.connect(toEngineConfig(config));
    await engine.initSchema();
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ status: 'success', engine: config.engine, mode: 'migrate-only' }));
  } else {
    console.log(`Schema up to date (engine: ${config.engine}).`);
  }
}

async function initPGLite(opts: {
  jsonOutput: boolean;
  apiKey: string | null;
  customPath: string | null;
  aiOpts?: { embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string };
}) {
  const dbPath = opts.customPath || gbrainPath('brain.pglite');
  console.log(`Setting up local brain with PGLite (no server needed)...`);
  const existingConfig = loadConfig();

  const mergedConfig: GBrainConfig = {
    ...(existingConfig ?? { engine: 'pglite', database_path: dbPath }),
    engine: 'pglite',
    database_path: dbPath,
    ...(opts.aiOpts?.embedding_model ? { embedding_model: opts.aiOpts.embedding_model } : {}),
    ...(opts.aiOpts?.embedding_dimensions ? { embedding_dimensions: opts.aiOpts.embedding_dimensions } : {}),
    ...(opts.aiOpts?.expansion_model ? { expansion_model: opts.aiOpts.expansion_model } : {}),
    ...(opts.aiOpts?.chat_model ? { chat_model: opts.aiOpts.chat_model } : {}),
  };

  // Configure AI gateway BEFORE initSchema so the vector column uses the right dim.
  if (mergedConfig.embedding_model || mergedConfig.chat_model) {
    configureGatewayFromConfig(mergedConfig);
    console.log(`  Embedding: ${mergedConfig.embedding_model} (${mergedConfig.embedding_dimensions ?? '?'}d)`);
    if (mergedConfig.expansion_model) console.log(`  Expansion: ${mergedConfig.expansion_model}`);
    if (mergedConfig.chat_model) console.log(`  Chat: ${mergedConfig.chat_model}`);
  }

  const engine = await createEngine({ engine: 'pglite' });
  try {
    await engine.connect({ database_path: dbPath, engine: 'pglite' });
    await engine.initSchema();

    const config: GBrainConfig = {
      ...mergedConfig,
      ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
    };
    saveConfig(config);
    recordFreshInstallMigrationBaseline(existingConfig === null);

    const stats = await engine.getStats();

    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'success', engine: 'pglite', path: dbPath, pages: stats.page_count }));
    } else {
      console.log(`\nBrain ready at ${dbPath}`);
      console.log(`${stats.page_count} pages. Engine: PGLite (local Postgres).`);
      if (stats.page_count > 0) {
        console.log('');
        console.log('Existing brain detected. Fresh init is the supported production path for provider-base setup.');
        console.log('Before switching providers or dimensions, preserve this brain explicitly:');
        console.log('  gbrain migrate --to supabase            (copy into a fresh Postgres brain)');
        console.log('  cp ~/.gbrain/brain.pglite ~/.gbrain/brain.pglite.bak   (quick local backup)');
        console.log('Then re-run `gbrain init --pglite --model <provider>` on an empty brain.');
      } else {
        console.log('Next: gbrain import <dir>');
      }
      console.log('');
      console.log('When you outgrow local: gbrain migrate --to supabase');
      reportModStatus();
      await printPostInstallAdvisory();
    }
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

async function initPostgres(opts: {
  databaseUrl: string;
  jsonOutput: boolean;
  apiKey: string | null;
  aiOpts?: { embedding_model?: string; embedding_dimensions?: number; expansion_model?: string; chat_model?: string };
}) {
  const { databaseUrl } = opts;
  const existingConfig = loadConfig();

  const mergedConfig: GBrainConfig = {
    ...(existingConfig ?? { engine: 'postgres', database_url: databaseUrl }),
    engine: 'postgres',
    database_url: databaseUrl,
    ...(opts.aiOpts?.embedding_model ? { embedding_model: opts.aiOpts.embedding_model } : {}),
    ...(opts.aiOpts?.embedding_dimensions ? { embedding_dimensions: opts.aiOpts.embedding_dimensions } : {}),
    ...(opts.aiOpts?.expansion_model ? { expansion_model: opts.aiOpts.expansion_model } : {}),
    ...(opts.aiOpts?.chat_model ? { chat_model: opts.aiOpts.chat_model } : {}),
  };

  // Configure AI gateway BEFORE initSchema so the vector column uses the right dim.
  if (mergedConfig.embedding_model || mergedConfig.chat_model) {
    configureGatewayFromConfig(mergedConfig);
    console.log(`  Embedding: ${mergedConfig.embedding_model} (${mergedConfig.embedding_dimensions ?? '?'}d)`);
    if (mergedConfig.expansion_model) console.log(`  Expansion: ${mergedConfig.expansion_model}`);
    if (mergedConfig.chat_model) console.log(`  Chat: ${mergedConfig.chat_model}`);
  }

  // Detect Supabase direct connection URLs and warn about IPv6
  if (databaseUrl.match(/db\.[a-z]+\.supabase\.co/) || databaseUrl.includes('.supabase.co:5432')) {
    console.warn('');
    console.warn('WARNING: You provided a Supabase direct connection URL (db.*.supabase.co:5432).');
    console.warn('  Direct connections are IPv6 only and fail in many environments.');
    console.warn('  Use the Session pooler connection string instead (port 6543):');
    console.warn('  Supabase Dashboard > gear icon (Project Settings) > Database >');
    console.warn('  Connection string > URI tab > change dropdown to "Session pooler"');
    console.warn('');
  }

  console.log('Connecting to database...');
  const engine = await createEngine({ engine: 'postgres' });
  try {
    try {
      await engine.connect({ database_url: databaseUrl });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (databaseUrl.includes('supabase.co') && (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT'))) {
        console.error('Connection failed. Supabase direct connections (db.*.supabase.co:5432) are IPv6 only.');
        console.error('Use the Session pooler connection string instead (port 6543).');
      }
      throw e;
    }

    // Check and auto-create pgvector extension
    try {
      const conn = (engine as any).sql || (await import('../core/db.ts')).getConnection();
      const ext = await conn`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
      if (ext.length === 0) {
        console.log('pgvector extension not found. Attempting to create...');
        try {
          await conn`CREATE EXTENSION IF NOT EXISTS vector`;
          console.log('pgvector extension created successfully.');
        } catch {
          console.error('Could not auto-create pgvector extension. Run manually in SQL Editor:');
          console.error('  CREATE EXTENSION vector;');
          // Throw so the outer finally runs engine.disconnect() before we die.
          throw new Error('pgvector extension missing');
        }
      }
    } catch {
      // Non-fatal
    }

    console.log('Running schema migration...');
    await engine.initSchema();

    const config: GBrainConfig = {
      ...mergedConfig,
      ...(opts.apiKey ? { openai_api_key: opts.apiKey } : {}),
    };
    saveConfig(config);
    recordFreshInstallMigrationBaseline(existingConfig === null);
    console.log('Config saved to ~/.gbrain/config.json');

    const stats = await engine.getStats();

    if (opts.jsonOutput) {
      console.log(JSON.stringify({ status: 'success', engine: 'postgres', pages: stats.page_count }));
    } else {
      console.log(`\nBrain ready. ${stats.page_count} pages. Engine: Postgres (Supabase).`);
      if (stats.page_count > 0) {
        console.log('');
        console.log('Existing brain detected. Fresh init is the supported production path for provider-base setup.');
        console.log('Before switching providers or dimensions, preserve this brain explicitly:');
        console.log('  gbrain migrate --to pglite --force --path ~/.gbrain/brain.pglite   (copy into a fresh local brain)');
        console.log('  gbrain export --dir ./gbrain-export     (portable markdown export)');
        console.log('Then point init at a clean Postgres target and re-import if needed.');
      } else {
        console.log('Next: gbrain import <dir>');
      }
      reportModStatus();
      await printPostInstallAdvisory();
    }
  } finally {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
}

function recordFreshInstallMigrationBaseline(isFreshInstall: boolean): void {
  if (!isFreshInstall) return;
  if (loadCompletedMigrations().length > 0) return;
  for (const migration of migrations) {
    appendCompletedMigration({
      version: migration.version,
      status: 'complete',
      fresh_install_baseline: true,
    });
  }
}

/**
 * Quick count of .md files in a directory (stops early at 1000).
 */
function countMarkdownFiles(dir: string, maxScan = 1500): number {
  let count = 0;
  try {
    const scan = (d: string) => {
      if (count >= maxScan) return;
      for (const entry of readdirSync(d)) {
        if (count >= maxScan) return;
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = join(d, entry);
        try {
          let stat;
          try {
            stat = lstatSync(full);
          } catch { continue; }
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) scan(full);
          else if (entry.endsWith('.md')) count++;
        } catch { /* skip unreadable */ }
      }
    };
    scan(dir);
  } catch { /* skip unreadable root */ }
  return count;
}

async function supabaseWizard(): Promise<string> {
  try {
    execSync('bunx supabase --version', { stdio: 'pipe' });
    console.log('Supabase CLI detected.');
    console.log('To auto-provision, run: bunx supabase login && bunx supabase projects create');
    console.log('Then use: gbrain init --url <your-connection-string>');
  } catch {
    console.log('Supabase CLI not found.');
  }

  console.log('\nEnter your Supabase/Postgres connection URL:');
  console.log('  Format: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres');
  console.log('  Find it: Supabase Dashboard > Connect (top bar) > Connection String > Session Pooler\n');

  const url = await readLine('Connection URL: ');
  if (!url) {
    console.error('No URL provided.');
    process.exit(1);
  }
  return url;
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (chunk) => {
      data = chunk.toString().trim();
      process.stdin.pause();
      resolve(data);
    });
    process.stdin.resume();
  });
}

/**
 * Detect GStack installation across known host paths.
 * Uses gstack-global-discover if available, falls back to path checking.
 */
export function detectGStack(): { found: boolean; path: string | null; host: string | null } {
  // Try gstack's own discovery tool first (DRY: don't reimplement host detection)
  try {
    const result = execSync(
      `${join(homedir(), '.claude', 'skills', 'gstack', 'bin', 'gstack-global-discover')} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (result) {
      return { found: true, path: result.split('\n')[0], host: 'auto-detected' };
    }
  } catch { /* binary not available */ }

  // Fallback: check known host paths
  const hostPaths = [
    { path: join(homedir(), '.claude', 'skills', 'gstack'), host: 'claude' },
    { path: join(homedir(), '.openclaw', 'skills', 'gstack'), host: 'openclaw' },
    { path: join(homedir(), '.codex', 'skills', 'gstack'), host: 'codex' },
    { path: join(homedir(), '.factory', 'skills', 'gstack'), host: 'factory' },
    { path: join(homedir(), '.kiro', 'skills', 'gstack'), host: 'kiro' },
  ];

  for (const { path, host } of hostPaths) {
    if (existsSync(join(path, 'SKILL.md')) || existsSync(join(path, 'setup'))) {
      return { found: true, path, host };
    }
  }

  return { found: false, path: null, host: null };
}

/**
 * Install default identity templates (SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md)
 * into the agent workspace. Uses minimal defaults, not the soul-audit interview.
 */
export function installDefaultTemplates(workspaceDir: string): string[] {
  const gbrainRoot = dirname(dirname(__dirname)); // up from src/commands/ to repo root
  const templatesDir = join(gbrainRoot, 'templates');
  const installed: string[] = [];

  const templates = [
    { src: 'SOUL.md.template', dest: 'SOUL.md' },
    { src: 'USER.md.template', dest: 'USER.md' },
    { src: 'ACCESS_POLICY.md.template', dest: 'ACCESS_POLICY.md' },
    { src: 'HEARTBEAT.md.template', dest: 'HEARTBEAT.md' },
  ];

  for (const { src, dest } of templates) {
    const srcPath = join(templatesDir, src);
    const destPath = join(workspaceDir, dest);
    if (existsSync(srcPath) && !existsSync(destPath)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      installed.push(dest);
    }
  }

  return installed;
}

/**
 * Report post-init status including GStack detection and skill count.
 */
export function reportModStatus(): void {
  const gstack = detectGStack();
  const gbrainRoot = dirname(dirname(__dirname));
  const skillsDir = join(gbrainRoot, 'skills');

  let skillCount = 0;
  try {
    const manifest = JSON.parse(
      readFileSync(join(skillsDir, 'manifest.json'), 'utf-8')
    );
    skillCount = manifest.skills?.length || 0;
  } catch { /* manifest not found */ }

  console.log('');
  console.log('--- GBrain Mod Status ---');
  console.log(`Skills: ${skillCount} loaded`);
  console.log(`GStack: ${gstack.found ? `found (${gstack.host})` : 'not found'}`);
  if (!gstack.found) {
    console.log('  Install GStack for coding skills:');
    console.log('  git clone https://github.com/garrytan/gstack.git ~/.claude/skills/gstack');
    console.log('  cd ~/.claude/skills/gstack && ./setup');
  }
  console.log('Resolver: skills/RESOLVER.md');
  console.log('Soul audit: run `gbrain soul-audit` to customize agent identity');
  console.log('');
}

async function printPostInstallAdvisory(): Promise<void> {
  try {
    const { printAdvisoryIfRecommended } = await import('../core/skillpack/post-install-advisory.ts');
    const { VERSION } = await import('../version.ts');
    printAdvisoryIfRecommended({ version: VERSION, context: 'init' });
  } catch (e) {
    console.error(`[warn] post-install advisory skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
