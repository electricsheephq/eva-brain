import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

const REPO = join(import.meta.dir, '..');
const LAUNCHER_PATH = join(
  REPO,
  'plugins',
  'gbrain-codex',
  'scripts',
  'launch-gbrain-serve.mjs',
);

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

async function loadLauncher(): Promise<any> {
  expect(existsSync(LAUNCHER_PATH)).toBe(true);
  return import(pathToFileURL(LAUNCHER_PATH).href);
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugins/gbrain-codex launcher', () => {
  test('exports testable launcher helpers', async () => {
    const mod = await loadLauncher();
    expect(typeof mod.prependBunBinToPath).toBe('function');
    expect(typeof mod.resolveGbrainExecutable).toBe('function');
    expect(typeof mod.buildServeArgs).toBe('function');
  });

  test('GBRAIN_CODEX_BIN wins over repo-local bin and PATH', async () => {
    const mod = await loadLauncher();
    const repoRoot = tempDir('gbrain-codex-repo-');
    const pluginRoot = join(repoRoot, 'plugins', 'gbrain-codex');
    mkdirSync(pluginRoot, { recursive: true });

    const envBin = join(tempDir('gbrain-codex-env-'), 'gbrain');
    const repoBin = join(repoRoot, 'bin', 'gbrain');
    const pathBinDir = tempDir('gbrain-codex-path-');
    const pathBin = join(pathBinDir, 'gbrain');
    writeExecutable(envBin);
    writeExecutable(repoBin);
    writeExecutable(pathBin);

    const resolved = mod.resolveGbrainExecutable({
      pluginRoot,
      env: { HOME: '/tmp/home', PATH: pathBinDir, GBRAIN_CODEX_BIN: envBin },
    });

    expect(resolved.command).toBe(envBin);
    expect(resolved.source).toBe('env');
  });

  test('repo-local bin/gbrain is used when override is absent', async () => {
    const mod = await loadLauncher();
    const repoRoot = tempDir('gbrain-codex-repo-');
    const pluginRoot = join(repoRoot, 'plugins', 'gbrain-codex');
    mkdirSync(pluginRoot, { recursive: true });
    const repoBin = join(repoRoot, 'bin', 'gbrain');
    writeExecutable(repoBin);

    const resolved = mod.resolveGbrainExecutable({
      pluginRoot,
      env: { HOME: '/tmp/home', PATH: '' },
    });

    expect(resolved.command).toBe(repoBin);
    expect(resolved.source).toBe('repo');
  });

  test('PATH lookup is used when repo-local bin is absent', async () => {
    const mod = await loadLauncher();
    const repoRoot = tempDir('gbrain-codex-repo-');
    const pluginRoot = join(repoRoot, 'plugins', 'gbrain-codex');
    mkdirSync(pluginRoot, { recursive: true });
    const pathBinDir = tempDir('gbrain-codex-path-');
    const pathBin = join(pathBinDir, 'gbrain');
    writeExecutable(pathBin);

    const resolved = mod.resolveGbrainExecutable({
      pluginRoot,
      env: { HOME: '/tmp/home', PATH: pathBinDir },
    });

    expect(resolved.command).toBe(pathBin);
    expect(resolved.source).toBe('path');
  });

  test('prependBunBinToPath adds $HOME/.bun/bin once at the front', async () => {
    const mod = await loadLauncher();
    expect(mod.prependBunBinToPath('/usr/bin:/bin', '/Users/test')).toBe(
      '/Users/test/.bun/bin:/usr/bin:/bin',
    );
    expect(
      mod.prependBunBinToPath('/Users/test/.bun/bin:/usr/bin:/bin', '/Users/test'),
    ).toBe('/Users/test/.bun/bin:/usr/bin:/bin');
  });

  test('missing executable throws an actionable adapter error', async () => {
    const mod = await loadLauncher();
    const repoRoot = tempDir('gbrain-codex-repo-');
    const pluginRoot = join(repoRoot, 'plugins', 'gbrain-codex');
    mkdirSync(pluginRoot, { recursive: true });

    expect(() =>
      mod.resolveGbrainExecutable({
        pluginRoot,
        env: { HOME: '/tmp/home', PATH: '' },
      })).toThrow(/adapter over a local GBrain install/i);
  });
});
