/**
 * `gbrain providers` CLI — list, test, env, explain.
 *
 * This command operates WITHOUT a brain connection (no engine needed) so
 * users can verify provider setup before `gbrain init`.
 */

import { resolveProviderAuth, redactAuthResolution } from '../core/ai/auth.ts';
import { listRecipes, getRecipe } from '../core/ai/recipes/index.ts';
import { configureGateway, embedOne, isAvailable as gwIsAvailable, chat as gwChat } from '../core/ai/gateway.ts';
import { probeOllama, probeLMStudio } from '../core/ai/probes.ts';
import { loadConfig, loadGbrainEnv } from '../core/config.ts';
import { AIConfigError, AITransientError } from '../core/ai/errors.ts';
import type { AIGatewayConfig, AuthSourceClass, Recipe } from '../core/ai/types.ts';

const SCHEMA_VERSION = 1;

type TouchpointFilter = 'embedding' | 'expansion' | 'chat';

interface ProviderOption {
  id: string;
  touchpoint: TouchpointFilter;
  model: string;
  dims?: number;
  cost_per_1m_tokens_usd?: number;
  cost_per_1m_input_usd?: number;
  cost_per_1m_output_usd?: number;
  price_last_verified?: string;
  env_ready: boolean;
  auth_source: AuthSourceClass;
  tier: 'native' | 'openai-compat';
  pros: string[];
  cons: string[];
}

let gatewayConfig: AIGatewayConfig;

function configureFromEnv(): void {
  const env = loadGbrainEnv();
  const config = loadConfig(env);
  gatewayConfig = {
    embedding_model: config?.embedding_model,
    embedding_dimensions: config?.embedding_dimensions,
    expansion_model: config?.expansion_model,
    chat_model: config?.chat_model,
    chat_fallback_chain: config?.chat_fallback_chain,
    base_urls: config?.provider_base_urls,
    provider_auth: config?.provider_auth,
    env,
  };
  configureGateway(gatewayConfig);
}

function currentGatewayEnv(): Record<string, string | undefined> {
  return gatewayConfig?.env ?? { ...process.env };
}

function configureGatewayForTestModel(modelArg: string, touchpoint: TouchpointFilter): void {
  const [providerId] = modelArg.split(':');
  const recipe = getRecipe(providerId);
  const embedding = recipe?.touchpoints.embedding;
  const recipeDims = embedding?.default_dims && embedding.default_dims > 0 ? embedding.default_dims : undefined;
  gatewayConfig = {
    ...gatewayConfig,
    ...(touchpoint === 'embedding'
      ? {
          embedding_model: modelArg,
          embedding_dimensions: gatewayConfig.embedding_dimensions ?? recipeDims ?? 1536,
        }
      : {}),
    ...(touchpoint === 'chat' ? { chat_model: modelArg } : {}),
    ...(touchpoint === 'expansion' ? { expansion_model: modelArg } : {}),
    env: currentGatewayEnv(),
  };
  configureGateway(gatewayConfig);
}

function authResolution(recipe: Recipe) {
  return resolveProviderAuth(recipe, gatewayConfig);
}

function envReady(recipe: Recipe): boolean {
  return authResolution(recipe).isConfigured;
}

export async function runProviders(subcommand: string | undefined, args: string[]): Promise<void> {
  configureFromEnv();

  switch (subcommand) {
    case 'list':
      return runList(args);
    case 'test':
      return runTest(args);
    case 'env':
      return runEnv(args);
    case 'explain':
      return runExplain(args);
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown providers subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`gbrain providers — AI provider status and testing

USAGE
  gbrain providers list                                   List all known providers + status
  gbrain providers test [--touchpoint T] [--model ID]     Smoke-test configured (or specified) providers
  gbrain providers env <id>                               Show env vars required/optional for a provider
  gbrain providers explain [--json]                       Emit a provider choice matrix (agent-friendly)

TOUCHPOINTS
  --touchpoint embedding (default)  Probes embed_one("...")
  --touchpoint chat                 Probes chat({messages: [{role:'user', content:'ping'}]})

EXAMPLES
  gbrain providers list
  gbrain providers test --model openai:text-embedding-3-large
  gbrain providers test --touchpoint chat --model anthropic:claude-haiku-4-5
  gbrain providers test --touchpoint chat --model deepseek:deepseek-chat
  gbrain providers env ollama
  gbrain providers explain --json
`);
}

function runList(_args: string[]): void {
  const recipes = listRecipes();
  const rows: string[] = [];
  rows.push('PROVIDER'.padEnd(14) + 'TIER'.padEnd(18) + 'EMBED'.padEnd(8) + 'EXPAND'.padEnd(8) + 'CHAT'.padEnd(8) + 'STATUS');
  rows.push('-'.repeat(78));
  for (const r of recipes) {
    const hasEmbed = !!r.touchpoints.embedding && (r.touchpoints.embedding.models.length > 0);
    const hasExpand = !!r.touchpoints.expansion;
    const hasChat = !!r.touchpoints.chat && r.touchpoints.chat.models.length > 0;
    const resolution = authResolution(r);
    const ready = resolution.isConfigured;
    const status = ready
      ? `✓ ready (${resolution.source})`
      : `✗ ${resolution.source === 'missing' ? resolution.missingReason ?? 'missing credentials' : resolution.source}`;
    rows.push(
      r.id.padEnd(14) +
      r.tier.padEnd(18) +
      (hasEmbed ? 'yes' : '—').padEnd(8) +
      (hasExpand ? 'yes' : '—').padEnd(8) +
      (hasChat ? 'yes' : '—').padEnd(8) +
      status,
    );
  }
  console.log(rows.join('\n'));
}

async function runTest(args: string[]): Promise<void> {
  const modelIdx = args.indexOf('--model');
  const modelArg = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  const tpIdx = args.indexOf('--touchpoint');
  const tpArg = (tpIdx >= 0 ? args[tpIdx + 1] : 'embedding') as TouchpointFilter;

  if (modelIdx >= 0 && (!modelArg || modelArg.startsWith('-'))) {
    console.error('Missing value for --model. Expected provider:model.');
    process.exit(1);
  }
  if (tpIdx >= 0 && (!tpArg || String(tpArg).startsWith('-'))) {
    console.error('Missing value for --touchpoint. Expected embedding or chat.');
    process.exit(1);
  }
  if (tpArg !== 'embedding' && tpArg !== 'chat') {
    console.error(`--touchpoint must be 'embedding' or 'chat' (got: ${tpArg}).`);
    process.exit(1);
  }

  // If --model passed, override only the requested touchpoint for this test
  // while preserving configured base URLs, other models, env, and provider_auth.
  if (modelArg) {
    configureGatewayForTestModel(modelArg, tpArg);
  }

  if (!gwIsAvailable(tpArg)) {
    console.error(`${tpArg[0]?.toUpperCase()}${tpArg.slice(1)} provider not configured or not ready. Run \`gbrain providers list\` to see status.`);
    process.exit(1);
  }

  console.log(`Probing ${tpArg} provider...`);
  const start = Date.now();
  try {
    if (tpArg === 'embedding') {
      const v = await embedOne('gbrain smoke test');
      const ms = Date.now() - start;
      console.log(`  ✓ ${ms}ms, ${v.length} dims`);
    } else {
      const result = await gwChat({
        messages: [{ role: 'user', content: 'Reply with just the word: pong' }],
        maxTokens: 16,
      });
      const ms = Date.now() - start;
      const preview = (result.text || '<empty>').replace(/\s+/g, ' ').slice(0, 80);
      console.log(`  ✓ ${ms}ms · model=${result.model} · stop=${result.stopReason} · in=${result.usage.input_tokens}/out=${result.usage.output_tokens} · "${preview}"`);
    }
    console.log('\nAll probes green.');
  } catch (e) {
    const ms = Date.now() - start;
    if (e instanceof AIConfigError) {
      console.error(`  ✗ config error (${ms}ms): ${e.message}`);
      if (e.fix) console.error(`    Fix: ${e.fix}`);
      process.exit(2);
    } else if (e instanceof AITransientError) {
      console.error(`  ✗ transient error (${ms}ms): ${e.message}`);
      console.error(`    Retry after a moment.`);
      process.exit(3);
    } else {
      console.error(`  ✗ unknown error (${ms}ms): ${e instanceof Error ? e.message : e}`);
      process.exit(4);
    }
  }
}

function runEnv(args: string[]): void {
  const env = currentGatewayEnv();
  const id = args[0];
  if (!id) {
    console.error('Usage: gbrain providers env <id>');
    process.exit(1);
  }
  const recipe = getRecipe(id);
  if (!recipe) {
    console.error(`Unknown provider: ${id}. Run \`gbrain providers list\` to see known providers.`);
    process.exit(1);
  }
  console.log(`${recipe.name} (${recipe.id})`);
  console.log('');
  const required = recipe.auth_env?.required ?? [];
  const optional = recipe.auth_env?.optional ?? [];
  if (required.length > 0) {
    console.log('Required:');
    for (const k of required) {
      const resolution = authResolution(recipe);
      const set = resolution.source === 'env' && resolution.credentialKey === k;
      console.log(`  ${k.padEnd(32)} ${set ? '✓ selected' : env[k] ? '• available' : '✗ not set'}`);
    }
  } else {
    console.log('Required: (none)');
  }
  if (optional.length > 0) {
    console.log('\nOptional:');
    for (const k of optional) {
      const set = !!env[k];
      console.log(`  ${k.padEnd(32)} ${set ? '✓ set' : '✗ not set'}`);
    }
  }
  const resolution = redactAuthResolution(authResolution(recipe));
  console.log(`\nSelected auth source: ${String(resolution.source)}`);
  if (resolution.credentialKey) console.log(`Credential key: ${String(resolution.credentialKey)}`);
  if (resolution.missingReason) console.log(`Status: ${String(resolution.missingReason)}`);
  if (recipe.auth_env?.setup_url) {
    console.log(`\nSetup: ${recipe.auth_env.setup_url}`);
  }
  if (recipe.setup_hint) {
    console.log(`\n${recipe.setup_hint}`);
  }
}

async function runExplain(args: string[]): Promise<void> {
  const asJson = args.includes('--json') || args.includes('-j');

  const recipes = listRecipes();
  const env = currentGatewayEnv();
  const env_detected = {
    OPENAI_API_KEY: !!env.OPENAI_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: !!env.GOOGLE_GENERATIVE_AI_API_KEY,
    ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
    VOYAGE_API_KEY: !!env.VOYAGE_API_KEY,
    DEEPSEEK_API_KEY: !!env.DEEPSEEK_API_KEY,
    GROQ_API_KEY: !!env.GROQ_API_KEY,
    TOGETHER_API_KEY: !!env.TOGETHER_API_KEY,
  };

  // Parallel probes for local providers (1s timeout each)
  const [ollama, lmstudio] = await Promise.all([probeOllama(env), probeLMStudio(env)]);

  const options: ProviderOption[] = [];
  for (const r of recipes) {
    if (r.touchpoints.embedding && r.touchpoints.embedding.models.length > 0) {
      const m = r.touchpoints.embedding;
      options.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'embedding',
        model: m.models[0],
        dims: m.default_dims,
        cost_per_1m_tokens_usd: m.cost_per_1m_tokens_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r) || (r.id === 'ollama' && ollama.models_endpoint_valid === true),
        auth_source: authResolution(r).source,
        tier: r.tier,
        pros: prosFor(r, 'embedding'),
        cons: consFor(r),
      });
    }
    if (r.touchpoints.expansion) {
      const m = r.touchpoints.expansion;
      options.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'expansion',
        model: m.models[0],
        cost_per_1m_tokens_usd: m.cost_per_1m_tokens_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r),
        auth_source: authResolution(r).source,
        tier: r.tier,
        pros: prosFor(r, 'expansion'),
        cons: consFor(r),
      });
    }
    if (r.touchpoints.chat && r.touchpoints.chat.models.length > 0) {
      const m = r.touchpoints.chat;
      options.push({
        id: `${r.id}:${m.models[0]}`,
        touchpoint: 'chat',
        model: m.models[0],
        cost_per_1m_input_usd: m.cost_per_1m_input_usd,
        cost_per_1m_output_usd: m.cost_per_1m_output_usd,
        price_last_verified: m.price_last_verified,
        env_ready: envReady(r),
        auth_source: authResolution(r).source,
        tier: r.tier,
        pros: prosFor(r, 'chat'),
        cons: consFor(r),
      });
    }
  }

  const recommended = pickRecommended(options, env_detected, ollama.models_endpoint_valid === true);

  const matrix = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    env_detected,
    local_probes: {
      ollama: { url: env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1', reachable: ollama.reachable, models_endpoint_valid: ollama.models_endpoint_valid === true },
      lmstudio: { url: env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1', reachable: lmstudio.reachable, models_endpoint_valid: lmstudio.models_endpoint_valid === true },
    },
    options,
    recommended: recommended.id,
    recommended_reason: recommended.reason,
  };

  if (asJson) {
    console.log(JSON.stringify(matrix, null, 2));
    return;
  }

  // Human-readable table
  console.log(`Provider matrix (schema v${SCHEMA_VERSION}, generated ${matrix.generated_at})`);
  console.log('');
  console.log('Environment:');
  for (const [k, v] of Object.entries(env_detected)) console.log(`  ${k.padEnd(32)} ${v ? '✓ set' : '✗ not set'}`);
  console.log(`  Ollama @ ${matrix.local_probes.ollama.url}  ${matrix.local_probes.ollama.models_endpoint_valid ? '✓ reachable' : '✗ not detected'}`);
  console.log('');
  console.log('Embedding options:');
  for (const o of options.filter(x => x.touchpoint === 'embedding')) {
    const cost = o.cost_per_1m_tokens_usd !== undefined ? `$${o.cost_per_1m_tokens_usd}/1M` : '—';
    const dims = o.dims ? `${o.dims}d` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${dims.padEnd(8)} ${cost.padEnd(10)} ${o.tier} ${o.auth_source}`);
  }
  console.log('');
  console.log('Expansion options:');
  for (const o of options.filter(x => x.touchpoint === 'expansion')) {
    const cost = o.cost_per_1m_tokens_usd !== undefined ? `$${o.cost_per_1m_tokens_usd}/1M` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${cost.padEnd(10)} ${o.tier} ${o.auth_source}`);
  }
  console.log('');
  console.log('Chat options:');
  for (const o of options.filter(x => x.touchpoint === 'chat')) {
    const input = o.cost_per_1m_input_usd !== undefined ? `$${o.cost_per_1m_input_usd}/1M in` : '—';
    const output = o.cost_per_1m_output_usd !== undefined ? `$${o.cost_per_1m_output_usd}/1M out` : '—';
    console.log(`  ${o.env_ready ? '✓' : '✗'} ${o.id.padEnd(44)} ${input.padEnd(14)} ${output.padEnd(14)} ${o.tier} ${o.auth_source}`);
  }
  console.log('');
  console.log(`Recommended: ${matrix.recommended}`);
  console.log(`  ${matrix.recommended_reason}`);
  console.log('');
  console.log('Re-invoke:');
  console.log(`  gbrain init --embedding-model ${matrix.recommended.split(':')[0]}:${matrix.recommended.split(':').slice(1).join(':')}`);
}

function prosFor(r: Recipe, touchpoint: TouchpointFilter): string[] {
  const out: string[] = [];
  if (r.id === 'openai') out.push('Default', 'High quality', 'Wide compatibility');
  else if (r.id === 'google') out.push('Smaller vectors', 'Matryoshka dim flex');
  else if (r.id === 'anthropic') out.push('Default expansion model', 'Best-in-class reasoning');
  else if (r.id === 'ollama') out.push('Local', 'Free', 'Private');
  else if (r.id === 'voyage') out.push('Best rerank pairing');
  else if (r.id === 'litellm') out.push('Universal coverage (Bedrock/Vertex/Azure/any)');
  else if (r.id === 'deepseek') out.push('Low-cost chat');
  else if (r.id === 'groq') out.push('Fast chat');
  else if (r.id === 'together') out.push('Open-weight chat');
  if (touchpoint === 'chat' && r.touchpoints.chat?.supports_subagent_loop) out.push('Subagent loop ready');
  return out;
}

function consFor(r: Recipe): string[] {
  const out: string[] = [];
  if (r.tier === 'native' && r.id !== 'ollama') out.push('Paid');
  if (r.id === 'ollama') out.push('Requires Ollama daemon running');
  if (r.id === 'litellm') out.push('Requires LiteLLM proxy + config');
  return out;
}

function pickRecommended(options: ProviderOption[], env: Record<string, boolean>, ollamaReady: boolean): { id: string; reason: string } {
  const embOpts = options.filter(o => o.touchpoint === 'embedding');
  const readyOpenAI = embOpts.find(o => o.id.startsWith('openai:') && o.env_ready);
  if (readyOpenAI) {
    const reason = readyOpenAI.auth_source === 'env'
      ? 'OPENAI_API_KEY set — OpenAI default is high-quality and preserves existing 1536-dim schema.'
      : `OpenAI auth resolved via ${readyOpenAI.auth_source} — default model stays compatible with the existing 1536-dim schema.`;
    return { id: readyOpenAI.id, reason };
  }
  if (ollamaReady) {
    const ollama = embOpts.find(o => o.id.startsWith('ollama:'));
    if (ollama) return { id: ollama.id, reason: 'Ollama detected locally — zero cost + private.' };
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = embOpts.find(o => o.id.startsWith('google:'));
    if (google) return { id: google.id, reason: 'GOOGLE_GENERATIVE_AI_API_KEY set — Gemini embedding at 768 dims.' };
  }
  if (env.VOYAGE_API_KEY) {
    const voyage = embOpts.find(o => o.id.startsWith('voyage:'));
    if (voyage) return { id: voyage.id, reason: 'VOYAGE_API_KEY set — Voyage at 2048 dims.' };
  }
  return {
    id: 'openai:text-embedding-3-large',
    reason: 'No provider auth detected. OpenAI is the fastest setup — get a key at https://platform.openai.com/api-keys or configure OpenClaw provider_auth.',
  };
}
