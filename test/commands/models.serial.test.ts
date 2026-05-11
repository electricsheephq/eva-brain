import { describe, expect, mock, spyOn, test } from 'bun:test';

const chatMock = mock(async () => ({
  text: 'ok',
  model: 'mock-model',
  provider: 'mock',
  usage: { input_tokens: 1, output_tokens: 1 },
  stopReason: 'stop',
}));

mock.module('../../src/core/ai/gateway.ts', () => ({
  chat: chatMock,
  getChatModel: () => 'anthropic:claude-sonnet-4-6',
  getExpansionModel: () => 'anthropic:claude-haiku-4-5-20251001',
}));

class StubEngine {
  async getConfig() { return null; }
}

describe('models command', () => {
  test('models doctor dispatches from stripped CLI args', async () => {
    chatMock.mockClear();
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { runModels } = await import('../../src/commands/models.ts');
      await runModels(new StubEngine() as never, ['doctor', '--json']);

      expect(chatMock).toHaveBeenCalledTimes(2);
      const payload = JSON.parse(String(stdout.mock.calls[0]?.[0] ?? '{}'));
      expect(payload.summary.total).toBe(2);
      expect(payload.summary.ok).toBe(2);
    } finally {
      stdout.mockRestore();
    }
  });
});
