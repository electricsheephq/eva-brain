import { describe, expect, test } from 'bun:test';

describe('CLI auth/serve hardening invariants', () => {
  test('serve --http validates --public-url has a value', async () => {
    const source = await Bun.file(new URL('../src/commands/serve.ts', import.meta.url)).text();
    expect(source).toContain("console.error('--public-url requires a URL value.')");
    expect(source).toContain("raw.startsWith('--')");
  });

  test('auth register-client only allows HTTP redirect URIs for loopback hosts', async () => {
    const authSource = await Bun.file(new URL('../src/commands/auth.ts', import.meta.url)).text();
    const source = await Bun.file(new URL('../src/core/oauth-provider.ts', import.meta.url)).text();
    expect(authSource).toContain('validateRedirectUri');
    expect(source).toContain("parsed.protocol !== 'https:'");
    expect(source).toContain("parsed.protocol === 'http:' && isLoopback");
    expect(source).toContain("parsed.hostname === 'localhost'");
    expect(source).toContain("parsed.hostname === '127.0.0.1'");
  });

  test('post-upgrade skill advisory is gated to the v0.25.1 crossing', async () => {
    const source = await Bun.file(new URL('../src/commands/upgrade.ts', import.meta.url)).text();
    expect(source).toContain("isNewerThan('0.25.1', upgradeFrom)");
    expect(source).toContain("!isNewerThan('0.25.1', VERSION)");
  });

  test('legacy singleton guard records failures in context artifacts', async () => {
    const source = await Bun.file(new URL('../scripts/check-no-legacy-getconnection.sh', import.meta.url)).text();
    expect(source).toContain('.context');
    expect(source).toContain('test-failures.log');
    expect(source).toContain('CHECK-NO-LEGACY-GETCONNECTION FAILED');
  });

  test('legacy singleton guard detects db calls inside template interpolation', async () => {
    const source = await Bun.file(new URL('../scripts/check-no-legacy-getconnection.mjs', import.meta.url)).text();
    expect(source).toContain('interpolationRe');
    expect(source).toContain('inside template interpolation');
  });
});
