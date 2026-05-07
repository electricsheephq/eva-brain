import { describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Chunk } from '../src/core/types.ts';

const embedBatchMock = mock(async (texts: string[]) => texts.map(() => new Float32Array([0.1, 0.2, 0.3])));

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: embedBatchMock,
}));

describe('embed --stale source awareness', () => {
  test('re-embeds stale chunks in their owning source', async () => {
    const calls: Array<{ name: string; sourceId?: string }> = [];
    const upserts: Array<{ sourceId?: string; embedding?: Float32Array }> = [];
    const chunk: Chunk = {
      id: 1,
      page_id: 10,
      chunk_index: 0,
      chunk_text: 'Support KB text',
      chunk_source: 'compiled_truth',
      embedding: null,
      model: 'voyage-4-large',
      token_count: 4,
      embedded_at: null,
    };
    const engine = {
      countStaleChunks: async () => 1,
      listStaleChunks: async () => [
        {
          source_id: 'openclaw-support-kb',
          slug: 'docs/support',
          chunk_index: 0,
          chunk_text: 'Support KB text',
          chunk_source: 'compiled_truth',
          model: 'voyage-4-large',
          token_count: 4,
        },
      ],
      getChunks: async (_slug: string, opts?: { sourceId?: string }) => {
        calls.push({ name: 'getChunks', sourceId: opts?.sourceId });
        return opts?.sourceId === 'openclaw-support-kb' ? [chunk] : [];
      },
      upsertChunks: async (_slug: string, chunks, opts?: { sourceId?: string }) => {
        calls.push({ name: 'upsertChunks', sourceId: opts?.sourceId });
        upserts.push({ sourceId: opts?.sourceId, embedding: chunks[0]?.embedding });
      },
    } as Partial<BrainEngine> as BrainEngine;

    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const result = await runEmbedCore(engine, { stale: true });

    expect(result.embedded).toBe(1);
    expect(calls).toEqual([
      { name: 'getChunks', sourceId: 'openclaw-support-kb' },
      { name: 'upsertChunks', sourceId: 'openclaw-support-kb' },
    ]);
    expect(upserts[0]?.embedding).toBeInstanceOf(Float32Array);
  });
});
