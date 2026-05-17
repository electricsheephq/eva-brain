import type { Operation, ParamDef } from '../core/operations.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function paramDefToSchema(p: ParamDef): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.items ? { items: paramDefToSchema(p.items) } : {}),
  };
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  return ops.map(op => ({
    name: op.name,
    description: op.description,
    inputSchema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)]),
      ),
      required: Object.entries(op.params)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}
