import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

describe('Eva Brain install contract', () => {
  test('package metadata and postinstall stay repo-owned and advisory', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

    expect(pkg.repository?.url).toContain('electricsheephq/eva-brain');
    expect(pkg.scripts?.postinstall.startsWith('echo ')).toBe(true);
    expect(pkg.scripts?.postinstall).toContain('INSTALL_FOR_AGENTS.md');
    expect(pkg.scripts?.postinstall).not.toContain('apply-migrations');
    expect(pkg.scripts?.postinstall).not.toContain('openclaw gateway restart');

    const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
    expect(manifest.configSchema).not.toHaveProperty('voyage_api_key');
  });

  test('agent install guide preserves Eva, Voyage, OpenClaw, and support KB setup', () => {
    const guide = readFileSync(join(root, 'INSTALL_FOR_AGENTS.md'), 'utf8');

    expect(guide).toContain('https://github.com/electricsheephq/eva-brain.git');
    expect(guide).toContain('voyage:voyage-4-large');
    expect(guide).toContain('--embedding-dimensions 2048');
    expect(guide).toContain('/plugins/gbrain/extract');
    expect(guide).toContain('openclaw plugins install');
    expect(guide).toContain('OPENCLAW_SUPPORT_KB_REPO');
    expect(guide).toContain('GBRAIN_ROOT="${GBRAIN_HOME:-$HOME}"');
    expect(guide).toContain('GBRAIN_ROOT/.gbrain/sources/openclaw-support-kb');
    expect(guide).toContain('https://github.com/electricsheephq/openclaw-support-kb.git');
    expect(guide).toContain('node scripts/update-client.mjs');
    expect(guide).toContain('node scripts/status.mjs');
    expect(guide).toContain('do not ask users for an OpenAI API key just to run Eva Brain extraction');
    expect(guide).not.toContain('export OPENAI_API_KEY=');
  });

  test('agent entrypoints do not send non-Claude agents to upstream Garry installs', () => {
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const setupSkill = readFileSync(join(root, 'skills/setup/SKILL.md'), 'utf8');
    const upgrade = readFileSync(join(root, 'src/commands/upgrade.ts'), 'utf8');

    expect(agents).toContain('https://github.com/electricsheephq/eva-brain');
    expect(agents).toContain('~/eva-brain');
    expect(agents).not.toContain('https://github.com/garrytan/gbrain ~/gbrain');
    expect(setupSkill).toContain('https://github.com/electricsheephq/eva-brain');
    expect(setupSkill).toContain('voyage:voyage-4-large');
    expect(setupSkill).toContain('gbrain embed --stale --source <source-id>');
    expect(setupSkill).not.toContain('bun add github:garrytan/gbrain');
    expect(upgrade).toContain('git clone https://github.com/electricsheephq/eva-brain.git ~/eva-brain');
    expect(upgrade).toContain('cd ~/eva-brain && bun install && bun link');
    expect(upgrade).toContain('scripts/update-local-install.sh');
    expect(upgrade).toContain('https://github.com/electricsheephq/eva-brain/releases');
    expect(upgrade).not.toContain('cd gbrain && bun install && bun link');
    expect(upgrade).not.toContain('bun update gbrain');
    expect(upgrade).not.toContain('clawhub update gbrain');
    expect(upgrade).not.toContain('https://github.com/garrytan/gbrain/releases');
  });

  test('recurring job docs do not use git sync for local-only brains', () => {
    const guide = readFileSync(join(root, 'INSTALL_FOR_AGENTS.md'), 'utf8');

    expect(guide).toContain('Local-only brain refresh');
    expect(guide).toContain('gbrain import ~/brain --no-embed && gbrain embed --stale --source default');
    expect(guide).toContain('Git-tracked brain sync');
    expect(guide).toContain('only when `~/brain` has a configured git remote and upstream tracking branch');
    expect(guide).toContain("OpenClaw's scheduler/Minions job path");
    expect(guide).toContain('gbrain embed --stale --source openclaw-support-kb');
  });

  test('sync cost preview uses configured provider pricing, not legacy OpenAI labels', () => {
    const sync = readFileSync(join(root, 'src/commands/sync.ts'), 'utf8');

    expect(sync).toContain('estimateEmbeddingPreviewCost');
    expect(sync).toContain('cost_per_1m_tokens_usd');
    expect(sync).toContain('model } = estimateEmbeddingPreviewCost');
    expect(sync).not.toContain('on ${EMBEDDING_MODEL}');
  });

  test('OpenClaw extraction route remains Codex OAuth runtime scoped', () => {
    const plugin = readFileSync(join(root, 'plugins/openclaw-gbrain/index.js'), 'utf8');

    expect(plugin).toContain('GBrain extraction only supports openai-codex/* models');
    expect(plugin).toContain('!resolved.startsWith("openai-codex/")');
    expect(plugin).toContain('resolved.slice("openai-codex/".length).trim() === ""');
    expect(plugin).toContain('invalid_model');
  });

  test('OpenClaw plugin keeps source-linked Bun CLI usable under LaunchAgents', () => {
    const plugin = readFileSync(join(root, 'plugins/openclaw-gbrain/index.js'), 'utf8');
    const readme = readFileSync(join(root, 'plugins/openclaw-gbrain/README.md'), 'utf8');

    expect(plugin).toContain('join(homedir(), ".bun", "bin")');
    expect(plugin).toContain('prependPathEntry(basePath, bunBin)');
    expect(plugin).toContain('BUN_INSTALL');
    expect(readme).toContain('LaunchAgents often start with a minimal PATH');
    expect(readme).toContain('Use the source-linked CLI from');
    expect(readme).toContain('Do not point `gbrainBin` at a');
    expect(readme).toContain("PGLite's `pglite.data`");
  });

  test('OpenClaw plugin env parser mirrors core gbrain.env inline-comment and quote behavior', () => {
    const plugin = readFileSync(join(root, 'plugins/openclaw-gbrain/index.js'), 'utf8');

    expect(plugin).toContain('function parseEnvValue');
    expect(plugin).toContain('function stripInlineComment');
    expect(plugin).toContain('if (char === quote) return out');
    expect(plugin).toContain("if (prev === \" \" || prev === \"\\t\") return raw.slice(0, i).trimEnd()");
    expect(plugin).not.toContain('function unquoteEnvValue');
  });
});
