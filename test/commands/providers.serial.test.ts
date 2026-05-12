import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

const configureGatewayMock = mock(() => {});
const embedOneMock = mock(async () => new Array(1536).fill(0));
const isAvailableMock = mock(() => true);
const chatMock = mock(async () => ({
  text: 'pong',
  model: 'mock-chat',
  provider: 'mock',
  usage: { input_tokens: 1, output_tokens: 1 },
  stopReason: 'stop',
}));
const probeOllamaMock = mock(async () => ({ reachable: false, models_endpoint_valid: false }));
const probeLMStudioMock = mock(async () => ({ reachable: false, models_endpoint_valid: false }));
const probeLlamaServerMock = mock(async () => ({ reachable: false, models_endpoint_valid: false }));
const loadGbrainEnvMock = mock(() => ({ ...process.env }));
const loadConfigMock = mock(() => ({
  embedding_model: 'openai:text-embedding-3-large',
  embedding_dimensions: 1536,
  expansion_model: 'anthropic:claude-haiku-4-5-20251001',
  provider_auth: { openai: { prefer: 'openclaw-codex', profile: 'openclaw-codex' } },
}));
const resolveProviderAuthMock = mock((recipe: { id: string }) => {
  if (recipe.id === 'openai') {
    return {
      source: 'openclaw-codex',
      isConfigured: true,
      credentialKey: 'OPENAI_API_KEY',
      meta: { profile: 'openclaw-codex' },
      secret: 'oc-secret',
    };
  }
  if (recipe.id === 'anthropic') {
    return {
      source: 'missing',
      isConfigured: false,
      missingReason: 'Missing ANTHROPIC_API_KEY.',
      meta: { mode: 'env' },
    };
  }
  return {
    source: 'missing',
    isConfigured: false,
    missingReason: 'missing',
    meta: { mode: 'env' },
  };
});

mock.module('../../src/core/ai/gateway.ts', () => ({
  configureGateway: configureGatewayMock,
  embedOne: embedOneMock,
  isAvailable: isAvailableMock,
  chat: chatMock,
}));

mock.module('../../src/core/ai/probes.ts', () => ({
  probeOllama: probeOllamaMock,
  probeLMStudio: probeLMStudioMock,
  probeLlamaServer: probeLlamaServerMock,
}));

mock.module('../../src/core/config.ts', () => ({
  loadConfig: loadConfigMock,
  loadGbrainEnv: loadGbrainEnvMock,
}));

mock.module('../../src/core/ai/auth.ts', () => ({
  resolveProviderAuth: resolveProviderAuthMock,
  redactAuthResolution: (resolution: any) => ({ ...resolution, value: undefined, secret: undefined }),
}));

describe('providers command auth hardening', () => {
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    configureGatewayMock.mockClear();
    embedOneMock.mockClear();
    isAvailableMock.mockClear();
    chatMock.mockClear();
    probeOllamaMock.mockClear();
    probeLMStudioMock.mockClear();
    probeLlamaServerMock.mockClear();
    loadGbrainEnvMock.mockClear();
    loadConfigMock.mockClear();
    resolveProviderAuthMock.mockClear();
    logSpy.mockClear();
    errorSpy.mockClear();
    isAvailableMock.mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  test('providers test --model preserves provider_auth while overriding only model', async () => {
    const { runProviders } = await import('../../src/commands/providers.ts');
    await runProviders('test', ['--model', 'openai:text-embedding-3-small']);

    expect(configureGatewayMock).toHaveBeenCalledTimes(2);
    const overrideArgs = configureGatewayMock.mock.calls[1] as unknown[] | undefined;
    const overrideCall = overrideArgs?.[0] as Record<string, unknown> | undefined;
    expect(overrideCall).toMatchObject({
      embedding_model: 'openai:text-embedding-3-small',
      provider_auth: { openai: { prefer: 'openclaw-codex', profile: 'openclaw-codex' } },
    });
  });

  test('providers test --model preserves configured embedding dimensions', async () => {
    loadConfigMock.mockReturnValueOnce({
      embedding_model: 'voyage:voyage-4-large',
      embedding_dimensions: 2048,
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      provider_auth: { openai: { prefer: 'openclaw-codex', profile: 'openclaw-codex' } },
    });
    const { runProviders } = await import('../../src/commands/providers.ts');
    await runProviders('test', ['--model', 'voyage:voyage-4-large']);

    expect(configureGatewayMock).toHaveBeenCalledTimes(2);
    const overrideArgs = configureGatewayMock.mock.calls[1] as unknown[] | undefined;
    const overrideCall = overrideArgs?.[0] as Record<string, unknown> | undefined;
    expect(overrideCall).toMatchObject({
      embedding_model: 'voyage:voyage-4-large',
      embedding_dimensions: 2048,
    });
  });

  test('providers command honors config-file API keys and config base URLs', async () => {
    loadGbrainEnvMock.mockReturnValueOnce({
      OLLAMA_BASE_URL: 'http://env-ollama.test/v1',
    });
    loadConfigMock.mockReturnValueOnce({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'anthropic:claude-haiku-4-5-20251001',
      openai_api_key: 'from-config-openai',
      anthropic_api_key: 'from-config-anthropic',
      provider_base_urls: { ollama: 'http://config-ollama.test/v1' },
    } as any);

    const { runProviders } = await import('../../src/commands/providers.ts');
    await runProviders('list', []);

    const initialArgs = configureGatewayMock.mock.calls[0] as unknown[] | undefined;
    const initialCall = initialArgs?.[0] as Record<string, any> | undefined;
    expect(initialCall?.env.OPENAI_API_KEY).toBe('from-config-openai');
    expect(initialCall?.env.ANTHROPIC_API_KEY).toBe('from-config-anthropic');
    expect(initialCall?.base_urls).toMatchObject({
      ollama: 'http://config-ollama.test/v1',
    });
  });

  test('providers explain recommends openai when auth comes from openclaw profile', async () => {
    const { runProviders } = await import('../../src/commands/providers.ts');
    await runProviders('explain', []);

    const output = logSpy.mock.calls
      .flatMap(call => call)
      .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
    expect(output).toContain('Recommended: openai:text-embedding-3-large');
    expect(output).toContain('OpenAI auth resolved via openclaw-codex');
    expect(output).not.toContain('oc-secret');
  });

  test('providers explain recommends Voyage when Voyage auth is available, even with OpenClaw OpenAI auth', async () => {
    loadGbrainEnvMock.mockReturnValueOnce({
      VOYAGE_API_KEY: 'from-gbrain-env',
    });
    const { runProviders } = await import('../../src/commands/providers.ts');
    await runProviders('explain', []);

    const output = logSpy.mock.calls
      .flatMap(call => call)
      .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
    expect(output).toContain('Recommended: voyage:voyage-4-large');
    expect(output).toContain('Eva Brain recommends Voyage 4 Large at 2048 dims');
    expect(output).not.toContain('from-gbrain-env');
  });

  test('providers explain reads env detected state from gbrain.env loader', async () => {
    loadGbrainEnvMock.mockReturnValueOnce({
      VOYAGE_API_KEY: 'from-gbrain-env',
      OLLAMA_BASE_URL: 'http://example.test:11434/v1',
    });
    const { runProviders } = await import('../../src/commands/providers.ts');
    await runProviders('explain', ['--json']);

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(payload.env_detected.VOYAGE_API_KEY).toBe(true);
    expect(payload.local_probes.ollama.url).toBe('http://example.test:11434/v1');
    expect(probeOllamaMock).toHaveBeenCalledWith(expect.objectContaining({
      OLLAMA_BASE_URL: 'http://example.test:11434/v1',
    }));
    expect(probeLMStudioMock).toHaveBeenCalledWith(expect.objectContaining({
      VOYAGE_API_KEY: 'from-gbrain-env',
    }));
  });

  test('providers test --model requires an explicit value', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code}`);
    });
    try {
      const { runProviders } = await import('../../src/commands/providers.ts');
      await expect(runProviders('test', ['--model'])).rejects.toThrow('exit:1');
      expect(errorSpy.mock.calls.map(call => String(call[0])).join('\n')).toContain('Missing value for --model');
      expect(configureGatewayMock).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  test('providers test --model rejects malformed or unsupported embedding models', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`exit:${code}`);
    });
    try {
      const { runProviders } = await import('../../src/commands/providers.ts');

      isAvailableMock.mockReturnValueOnce(false);
      await expect(runProviders('test', ['--model', 'openai'])).rejects.toThrow('exit:1');

      isAvailableMock.mockReturnValueOnce(false);
      await expect(runProviders('test', ['--model', 'nope:text-embedding-3-small'])).rejects.toThrow('exit:1');

      isAvailableMock.mockReturnValueOnce(false);
      await expect(runProviders('test', ['--model', 'anthropic:claude-haiku-4-5-20251001'])).rejects.toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
    }
  });
});
