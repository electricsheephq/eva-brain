import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

function ctx(sourceId: string): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as OperationContext['config'],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  };
}

async function seedSource(sourceId: string) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ($1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [sourceId, sourceId],
  );
}

describe('operation source identity', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    await seedSource('kb-source');
  });

  test('put_page auto-timeline writes to ctx.sourceId instead of default', async () => {
    await engine.setConfig('auto_timeline', 'true');
    await engine.putPage('people/dana', {
      type: 'person',
      title: 'Default Dana',
      compiled_truth: 'Default source row.',
    });

    const putPage = operationsByName['put_page'];
    const result = await putPage.handler(ctx('kb-source'), {
      slug: 'people/dana',
      content: `---
type: person
title: Dana
---

Dana is a founder.

## Timeline

- **2026-03-15** | Shipped v1.0
`,
    });

    expect((result as any).auto_timeline?.created).toBe(1);
    expect(await engine.getTimeline('people/dana', { sourceId: 'default' })).toHaveLength(0);
    const altTimeline = await engine.getTimeline('people/dana', { sourceId: 'kb-source' });
    expect(altTimeline).toHaveLength(1);
    expect(altTimeline[0].summary).toBe('Shipped v1.0');
  });

  test('log_ingest operation writes ctx.sourceId', async () => {
    const logIngest = operationsByName['log_ingest'];
    await logIngest.handler(ctx('kb-source'), {
      source_type: 'test',
      source_ref: 'source-op-test',
      pages_updated: ['people/dana'],
      summary: 'source-scoped log',
    });

    const rows = await engine.getIngestLog({ limit: 5 });
    expect(rows.find(row => row.source_ref === 'source-op-test')?.source_id).toBe('kb-source');
  });
});
