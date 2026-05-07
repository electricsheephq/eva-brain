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

  test('duplicate slugs only re-embed the stale source row', async () => {
    const getCalls: Array<{ slug: string; sourceId?: string }> = [];
    const upserts: Array<{ slug: string; sourceId?: string; text?: string }> = [];
    const defaultChunk: Chunk = {
      id: 1,
      page_id: 10,
      chunk_index: 0,
      chunk_text: 'Default workspace text',
      chunk_source: 'compiled_truth',
      embedding: new Float32Array([0.9, 0.9, 0.9]),
      model: 'voyage-4-large',
      token_count: 5,
      embedded_at: new Date('2026-05-01T00:00:00.000Z'),
    };
    const kbChunk: Chunk = {
      id: 2,
      page_id: 20,
      chunk_index: 0,
      chunk_text: 'KB stale text',
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
          slug: 'docs/shared',
          chunk_index: 0,
          chunk_text: 'KB stale text',
          chunk_source: 'compiled_truth',
          model: 'voyage-4-large',
          token_count: 4,
        },
      ],
      getChunks: async (slug: string, opts?: { sourceId?: string }) => {
        getCalls.push({ slug, sourceId: opts?.sourceId });
        if (opts?.sourceId === 'openclaw-support-kb') return [kbChunk];
        if (opts?.sourceId === 'default') return [defaultChunk];
        throw new Error('embed --stale must pass an explicit source id');
      },
      upsertChunks: async (slug: string, chunks, opts?: { sourceId?: string }) => {
        upserts.push({ slug, sourceId: opts?.sourceId, text: chunks[0]?.chunk_text });
      },
    } as Partial<BrainEngine> as BrainEngine;

    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const result = await runEmbedCore(engine, { stale: true });

    expect(result.embedded).toBe(1);
    expect(getCalls).toEqual([{ slug: 'docs/shared', sourceId: 'openclaw-support-kb' }]);
    expect(upserts).toEqual([{ slug: 'docs/shared', sourceId: 'openclaw-support-kb', text: 'KB stale text' }]);
  });

  test('CLI --stale --source passes the source filter into stale queries', async () => {
    const staleQueryOpts: Array<{ sourceId?: string } | undefined> = [];
    const engine = {
      countStaleChunks: async (opts?: { sourceId?: string }) => {
        staleQueryOpts.push(opts);
        return 0;
      },
      listStaleChunks: async (opts?: { sourceId?: string }) => {
        staleQueryOpts.push(opts);
        return [];
      },
    } as Partial<BrainEngine> as BrainEngine;

    const { runEmbed } = await import('../src/commands/embed.ts');
    await runEmbed(engine, ['--stale', '--source', 'openclaw-support-kb']);

    expect(staleQueryOpts).toEqual([{ sourceId: 'openclaw-support-kb' }]);
  });
});
