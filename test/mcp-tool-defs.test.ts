/**
 * Regression test for the MCP tool-def extraction (v0.16.0 Lane 1A).
 *
 * Before v0.15 the mapping lived inline in src/mcp/server.ts. After the
 * extraction, buildToolDefs is the single source of truth; the subagent tool
 * registry calls it with a filtered OPERATIONS subset. This test pins the
 * extracted output to the pre-extraction shape byte-for-byte so we don't
 * silently drift the MCP-facing tool schema.
 */

import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs, paramDefToSchema } from '../src/mcp/tool-defs.ts';
import type { ParamDef } from '../src/core/operations.ts';

// Pre-extraction inline shape — lifted verbatim from the original
// src/mcp/server.ts block so any future drift fails this test loudly.
type ParamDefLike = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: ParamDefLike;
};

function referenceParamDefToSchema(p: ParamDefLike): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.items ? { items: referenceParamDefToSchema(p.items) } : {}),
  };
}

function legacyInlineMap(ops: typeof operations) {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, referenceParamDefToSchema(v)]),
      ),
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}

describe('buildToolDefs', () => {
  test('output equals pre-extraction inline mapping byte-for-byte', () => {
    const extracted = buildToolDefs(operations);
    const inline = legacyInlineMap(operations);
    expect(JSON.stringify(extracted)).toBe(JSON.stringify(inline));
  });

  test('preserves operation count', () => {
    expect(buildToolDefs(operations).length).toBe(operations.length);
  });

  test('accepts an arbitrary Operation subset (for subagent tool registry)', () => {
    const subset = operations.slice(0, 3);
    const defs = buildToolDefs(subset);
    expect(defs.length).toBe(3);
    expect(defs.map(d => d.name)).toEqual(subset.map(o => o.name));
  });

  test('empty input returns empty array', () => {
    expect(buildToolDefs([])).toEqual([]);
  });

  test('every def has object inputSchema with properties + required array', () => {
    for (const def of buildToolDefs(operations)) {
      expect(def.inputSchema.type).toBe('object');
      expect(typeof def.inputSchema.properties).toBe('object');
      expect(Array.isArray(def.inputSchema.required)).toBe(true);
    }
  });
});

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  [k: string]: unknown;
}

function findArrayWithoutItems(node: SchemaNode, path: string[]): string[] {
  const violations: string[] = [];
  if (node && typeof node === 'object') {
    if (node.type === 'array') {
      if (!node.items || typeof node.items !== 'object') {
        violations.push(`${path.join('.') || '<root>'} (array missing items)`);
      } else if (!('type' in node.items)) {
        violations.push(`${path.join('.') || '<root>'}.items (items missing type)`);
      } else {
        violations.push(...findArrayWithoutItems(node.items, [...path, 'items']));
      }
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, child] of Object.entries(node.properties)) {
        violations.push(...findArrayWithoutItems(child as SchemaNode, [...path, k]));
      }
    }
    if (node.items && typeof node.items === 'object' && node.type !== 'array') {
      violations.push(...findArrayWithoutItems(node.items, [...path, 'items']));
    }
  }
  return violations;
}

describe('paramDefToSchema structural guard', () => {
  test('every operation inputSchema array has items.type set', () => {
    const allViolations: string[] = [];
    for (const def of buildToolDefs(operations)) {
      allViolations.push(...findArrayWithoutItems(def.inputSchema as SchemaNode, [def.name]));
    }
    expect(allViolations).toEqual([]);
  });

  test('extract_facts.entity_hints declares string items', () => {
    const def = buildToolDefs(operations).find(d => d.name === 'extract_facts');
    expect(def).toBeDefined();
    const eh = (def!.inputSchema.properties as Record<string, SchemaNode>).entity_hints;
    expect(eh.type).toBe('array');
    expect((eh.items as SchemaNode).type).toBe('string');
  });

  test('paramDefToSchema recursively preserves nested items', () => {
    const nested: ParamDef = {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'string' },
      },
    };
    const schema = paramDefToSchema(nested) as SchemaNode;
    expect(schema.type).toBe('array');
    expect((schema.items as SchemaNode).type).toBe('array');
    expect(((schema.items as SchemaNode).items as SchemaNode).type).toBe('string');
  });
});
