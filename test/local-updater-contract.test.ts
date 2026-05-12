import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const tmpHomes: string[] = [];

interface MarketplaceEntry {
  name?: string;
  source: { path: string };
  policy: { installation: string; authentication: string };
}

afterEach(() => {
  while (tmpHomes.length > 0) {
    const dir = tmpHomes.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-install-test-'));
  tmpHomes.push(dir);
  return dir;
}

describe('public local updater and Codex plugin packaging', () => {
  test('update script is public-host phrased and syntax-valid', () => {
    const script = readFileSync(join(root, 'scripts/update-local-install.sh'), 'utf8');

    expect(script).toMatch(/Usage:\s+scripts\/update-local-install\.sh\s+\[options\]/);
    expect(script).toMatch(/--with-openclaw\b/);
    expect(script).toMatch(/--with-codex-plugin\b/);
    expect(script).toMatch(/node\s+scripts\/install-codex-plugin\.mjs/);
    expect(script).toMatch(/switch\s+--detach\s+FETCH_HEAD/);
    expect(script).toMatch(/GBRAIN_ROOT="\$\{GBRAIN_HOME:-\$HOME\}"/);
    expect(script).toMatch(/GBRAIN_DIR="\$GBRAIN_ROOT\/\.gbrain"/);
    expect(script).toMatch(/config_path="\$GBRAIN_DIR\/config\.json"/);
    expect(script).toMatch(/stop_stale_serve_if_requested\s*\n\s*local config_path="\$GBRAIN_DIR\/config\.json"/);
    expect(script).toMatch(/init\s+--pglite\s+--embedding-model\s+voyage:voyage-4-large\s+--embedding-dimensions\s+2048/);
    expect(script).toMatch(/if \[ -f "\$config_path" \]; then/);
    expect(script).toMatch(/run "\$HOME\/\.bun\/bin\/gbrain" init/);
    expect(script).not.toMatch(/\bfleet\b/i);

    const result = Bun.spawnSync({
      cmd: ['bash', '-n', 'scripts/update-local-install.sh'],
      cwd: root,
    });
    expect(result.exitCode).toBe(0);
  });

  test('Codex plugin metadata stays repo-owned and version-aligned', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const skillManifest = JSON.parse(readFileSync(join(root, 'skills/manifest.json'), 'utf8'));
    const codexPlugin = JSON.parse(readFileSync(join(root, 'plugins/gbrain-codex/.codex-plugin/plugin.json'), 'utf8'));
    const codexPkg = JSON.parse(readFileSync(join(root, 'plugins/gbrain-codex/package.json'), 'utf8'));

    expect(codexPlugin.name).toBe('gbrain-codex');
    expect(codexPlugin.version).toBe(pkg.version);
    expect(codexPkg.version).toBe(pkg.version);
    expect(skillManifest.version).toBe(pkg.version);
    expect(codexPlugin.repository).toContain('electricsheephq/eva-brain');
    expect(codexPlugin.skills).toBe('./skills/');
    expect(codexPlugin.mcpServers).toBe('./.mcp.json');
  });

  test('Codex plugin is not an OpenClaw plugin child by accident', () => {
    expect(existsSync(join(root, 'plugins/gbrain-codex/openclaw.plugin.json'))).toBe(false);

    const mcp = JSON.parse(readFileSync(join(root, 'plugins/gbrain-codex/.mcp.json'), 'utf8'));
    expect(mcp.mcpServers['gbrain-codex'].command).toBe('node');
    expect(mcp.mcpServers['gbrain-codex'].args).toContain('./scripts/launch-gbrain-serve.mjs');
  });

  test('Codex installer creates a local plugin shell linked to current repo skills', () => {
    const home = tempHome();
    const result = Bun.spawnSync({
      cmd: ['node', 'scripts/install-codex-plugin.mjs', '--home', home, '--repo-dir', root],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);

    const pluginDir = join(home, 'plugins/gbrain-codex');
    expect(existsSync(join(pluginDir, '.codex-plugin/plugin.json'))).toBe(true);
    expect(existsSync(join(pluginDir, '.mcp.json'))).toBe(true);
    expect(lstatSync(join(pluginDir, 'skills')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(pluginDir, 'skills'))).toBe(join(root, 'skills'));

    const marketplace = JSON.parse(readFileSync(join(home, '.agents/plugins/marketplace.json'), 'utf8'));
    const entry = marketplace.plugins.find((plugin: MarketplaceEntry) => plugin.name === 'gbrain-codex') as MarketplaceEntry | undefined;
    expect(entry).toBeTruthy();
    if (!entry) throw new Error('gbrain-codex marketplace entry missing');
    expect(entry.source.path).toBe('./plugins/gbrain-codex');
    expect(entry.policy.installation).toBe('AVAILABLE');
    expect(entry.policy.authentication).toBe('ON_INSTALL');
  });

  test('Codex installer replaces stale or broken local gbrain-codex symlinks', () => {
    const home = tempHome();
    const pluginDir = join(home, 'plugins/gbrain-codex');
    mkdirSync(join(home, 'plugins'), { recursive: true });
    symlinkSync('/path/that/does/not/exist', pluginDir);
    expect(lstatSync(pluginDir).isSymbolicLink()).toBe(true);

    const result = Bun.spawnSync({
      cmd: ['node', 'scripts/install-codex-plugin.mjs', '--home', home, '--repo-dir', root],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(lstatSync(pluginDir).isDirectory()).toBe(true);
    expect(readlinkSync(join(pluginDir, 'skills'))).toBe(join(root, 'skills'));
  });

  test('Codex installer dry-run does not create home plugin files', () => {
    const home = tempHome();
    const result = Bun.spawnSync({
      cmd: ['node', 'scripts/install-codex-plugin.mjs', '--home', home, '--repo-dir', root, '--dry-run'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, 'plugins/gbrain-codex'))).toBe(false);
    expect(existsSync(join(home, '.agents/plugins/marketplace.json'))).toBe(false);
  });

  test('Codex installer rejects missing option values instead of falling back to cwd', () => {
    for (const flag of ['--home', '--repo-dir']) {
      const result = Bun.spawnSync({
        cmd: ['node', 'scripts/install-codex-plugin.mjs', flag],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(new TextDecoder().decode(result.stderr)).toContain(`Missing value for ${flag}`);
    }
  });
});
