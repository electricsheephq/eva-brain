import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { CommandCodexExtractionClient, OpenClawGatewayCodexExtractionClient, createConfiguredCodexExtractionClient } from '../src/core/ai/codex-extraction-client.ts';

describe('CodexExtractionClient', () => {
  test('calls the configured host command with a prompt-only payload and no OAuth token material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-extraction-test-'));
    const capturePath = join(dir, 'request.json');
    const profilePath = join(dir, 'auth-profiles.json');
    writeFileSync(profilePath, JSON.stringify({
      version: 1,
      profiles: {
        'openai-codex:default': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'oauth-access-token-must-not-be-api-key',
          refresh: 'oauth-refresh-token-must-not-be-api-key',
        },
      },
    }));

    const command = `node -e "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{fs.writeFileSync(process.env.CAPTURE,s);process.stdout.write(JSON.stringify({text:'host text ok'}));});"`;
    const client = new CommandCodexExtractionClient(command, {
      ...process.env,
      CAPTURE: capturePath,
      GBRAIN_OPENCLAW_AUTH_PROFILES_PATH: profilePath,
    });

    const text = await client.completeText({ prompt: 'extract the important facts' });

    expect(text).toBe('host text ok');
    const payload = JSON.parse(readFileSync(capturePath, 'utf-8'));
    expect(payload.protocol).toBe('gbrain.codex-extraction.v1');
    expect(payload.provider).toBe('openai-codex');
    expect(payload.modelRef).toBe('openai-codex/gpt-5.4-mini');
    expect(payload.prompt).toBe('extract the important facts');
    expect(payload.auth).toEqual({ mode: 'openclaw-runtime' });
    expect(payload.apiKey).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('oauth-access-token-must-not-be-api-key');
    expect(JSON.stringify(payload)).not.toContain('oauth-refresh-token-must-not-be-api-key');
  });

  test('parses direct JSON extraction output from the host command', async () => {
    const command = `node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const p=JSON.parse(s);if(!p.prompt.includes('gbrain.media-extraction.v1')) process.exit(2);process.stdout.write(JSON.stringify({schemaVersion:'gbrain.media-extraction.v1',kind:'pdf',segments:[{id:'segment-0',kind:'page',summary:'ok'}]}));})"`;
    const client = new CommandCodexExtractionClient(command, process.env);
    expect(client.supportsFileMedia).toBe(false);

    const json = await client.extractMedia<any>({ kind: 'pdf', sourceRef: 'note.txt', text: 'extract JSON' });

    expect(json.schemaVersion).toBe('gbrain.media-extraction.v1');
    expect(json.segments[0].summary).toBe('ok');
  });

  test('calls the OpenClaw extraction route over HTTP when gateway URL is configured', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, extraction: { schemaVersion: 'gbrain.media-extraction.v1', kind: 'pdf', sourceRef: 'note.txt', segments: [{ id: 'segment-0', kind: 'page', summary: 'ok' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new OpenClawGatewayCodexExtractionClient({ gatewayUrl: 'http://127.0.0.1:18789', gatewayToken: 'gateway-token' });
      expect(client.supportsFileMedia).toBe(true);
      const json = await client.extractMedia<any>({ kind: 'pdf', sourceRef: 'note.txt', text: 'extract JSON', model: 'openai-codex/gpt-5.4-mini' });

      expect(json.schemaVersion).toBe('gbrain.media-extraction.v1');
      expect(requests.length).toBe(1);
      expect(requests[0].url).toBe('http://127.0.0.1:18789/plugins/gbrain/extract');
      expect((requests[0].init.headers as Record<string, string>).authorization).toBe('Bearer gateway-token');
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.model).toBe('gpt-5.4-mini');
      expect(body.kind).toBe('pdf');
      expect(body.sourceRef).toBe('note.txt');
      expect(body.text).toBe('extract JSON');
      expect(body.apiKey).toBeUndefined();
      expect(body.token).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refuses generic gateway completion unless a legacy completion path is explicitly configured', async () => {
    const client = new OpenClawGatewayCodexExtractionClient({ gatewayUrl: 'http://127.0.0.1:18789' });

    await expect(client.completeJson({ prompt: 'extract JSON' })).rejects.toThrow(
      'OpenClaw gateway generic completion is not enabled on the default /plugins/gbrain/extract route.',
    );
  });

  test('supports the legacy gateway completion bridge only when explicitly configured', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, json: { summary: 'ok' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new OpenClawGatewayCodexExtractionClient({
        gatewayUrl: 'http://127.0.0.1:18789',
        completionPath: '/plugins/gbrain/complete',
      });
      const json = await client.completeJson<{ summary: string }>({ prompt: 'extract JSON' });

      expect(json.summary).toBe('ok');
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('http://127.0.0.1:18789/plugins/gbrain/complete');
      const body = JSON.parse(String(requests[0].init.body));
      expect(body.protocol).toBe('gbrain.codex-extraction.v1');
      expect(body.prompt).toBe('extract JSON');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sends image bytes to the OpenClaw extraction route without model API keys', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, extraction: { schemaVersion: 'gbrain.media-extraction.v1', kind: 'image', sourceRef: 'receipt.png', segments: [{ id: 'frame-1', kind: 'frame', caption: 'Receipt' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const client = new OpenClawGatewayCodexExtractionClient({ gatewayUrl: 'http://127.0.0.1:18789' });
      await client.extractMedia<any>({
        kind: 'image',
        sourceRef: 'receipt.png',
        file: { name: 'receipt.png', mime: 'image/png', base64: 'aW1hZ2U=' },
      });

      const body = JSON.parse(String(requests[0].init.body));
      expect(body.file).toEqual({ name: 'receipt.png', mime: 'image/png', base64: 'aW1hZ2U=' });
      expect(JSON.stringify(body)).not.toMatch(/apiKey|OPENAI_API_KEY|refreshToken|oauth/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('factory prefers the OpenClaw gateway bridge, then falls back to command bridge', () => {
    expect(createConfiguredCodexExtractionClient({})).toBeUndefined();
    expect(createConfiguredCodexExtractionClient({ GBRAIN_OPENCLAW_COMPLETION_COMMAND: 'cat' })).toBeTruthy();
    expect(createConfiguredCodexExtractionClient({ GBRAIN_OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18789' })).toBeTruthy();
    expect(createConfiguredCodexExtractionClient({
      GBRAIN_OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:18789',
      GBRAIN_OPENCLAW_COMPLETION_PATH: '/plugins/gbrain/complete',
    })).toBeTruthy();
  });
});
