import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const REPO = join(import.meta.dir, '..');
const PLUGIN_ROOT = join(REPO, 'plugins', 'gbrain-codex');
const PLUGIN_MANIFEST = join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json');
const MCP_MANIFEST = join(PLUGIN_ROOT, '.mcp.json');
const ROOT_SKILLS = join(REPO, 'skills');
const PLUGIN_SKILLS = join(PLUGIN_ROOT, 'skills');

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function collectFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

describe('plugins/gbrain-codex package', () => {
  test('ships the expected plugin package files', () => {
    expect(existsSync(PLUGIN_ROOT)).toBe(true);
    expect(existsSync(PLUGIN_MANIFEST)).toBe(true);
    expect(existsSync(MCP_MANIFEST)).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, 'README.md'))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, 'scripts', 'launch-gbrain-serve.mjs'))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, 'scripts', 'rehearsal.mjs'))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT, 'assets', 'gbrain-codex.svg'))).toBe(true);
    expect(existsSync(PLUGIN_SKILLS)).toBe(true);
  });

  test('plugin manifest is self-contained and branded as GBrain', () => {
    const manifest = readJson(PLUGIN_MANIFEST);
    const repoPkg = readJson(join(REPO, 'package.json'));

    expect(manifest.name).toBe('gbrain-codex');
    expect(manifest.version).toBe(repoPkg.version);
    expect(manifest.skills).toBe('./skills/');
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(manifest.interface.displayName).toBe('GBrain');
    expect(manifest.interface.capabilities).toEqual([
      'Interactive',
      'Read',
      'Write',
    ]);
    expect(manifest.interface.defaultPrompt.length).toBeGreaterThanOrEqual(3);
    expect(manifest.interface.logo).toBe('./assets/gbrain-codex.svg');
    expect(manifest.interface.composerIcon).toBe('./assets/gbrain-codex.svg');

    const pluginLocalPaths = [
      manifest.skills,
      manifest.mcpServers,
      manifest.interface.logo,
      manifest.interface.composerIcon,
    ];
    for (const relPath of pluginLocalPaths) {
      expect(relPath.startsWith('./')).toBe(true);
      expect(existsSync(join(PLUGIN_ROOT, relPath.replace(/^\.\//, '')))).toBe(true);
    }
  });

  test('.mcp.json launches the local stdio adapter instead of a second MCP implementation', () => {
    const manifest = readJson(MCP_MANIFEST);
    expect(Object.keys(manifest.mcpServers)).toEqual(['gbrain-codex']);
    const server = manifest.mcpServers['gbrain-codex'];
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['./scripts/launch-gbrain-serve.mjs']);
    expect(server.cwd).toBe('.');
  });

  test('bundles a byte-identical copy of the full checked-in GBrain skill tree', () => {
    expect(existsSync(ROOT_SKILLS)).toBe(true);
    expect(existsSync(PLUGIN_SKILLS)).toBe(true);

    const rootFiles = collectFiles(ROOT_SKILLS);
    const pluginFiles = collectFiles(PLUGIN_SKILLS);
    expect(pluginFiles).toEqual(rootFiles);

    for (const relPath of rootFiles) {
      const rootPath = join(ROOT_SKILLS, relPath);
      const pluginPath = join(PLUGIN_SKILLS, relPath);
      expect(relative(PLUGIN_SKILLS, pluginPath)).toBe(relPath);
      expect(statSync(pluginPath).isFile()).toBe(true);
      expect(readFileSync(pluginPath, 'utf-8')).toBe(readFileSync(rootPath, 'utf-8'));
    }
  });
});
