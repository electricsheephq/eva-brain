export const DEFAULT_CODEX_EXTRACTION_MODEL = 'openai-codex/gpt-5.4-mini';
const LEGACY_OPENCLAW_COMPLETION_PATH = '/plugins/gbrain/complete';
const DEFAULT_OPENCLAW_EXTRACT_PATH = '/plugins/gbrain/extract';

export interface CodexExtractionRequest {
  prompt: string;
  model?: string;
  signal?: AbortSignal;
}

export interface CodexMediaExtractionRequest {
  kind: 'image' | 'pdf' | 'video' | 'audio';
  sourceRef: string;
  title?: string;
  text?: string;
  file?: {
    name?: string;
    mime?: string;
    base64: string;
  };
  model?: string;
  signal?: AbortSignal;
}

export interface CodexExtractionClient {
  readonly supportsFileMedia: boolean;
  completeText(request: CodexExtractionRequest): Promise<string>;
  completeJson<T = unknown>(request: CodexExtractionRequest): Promise<T>;
  extractMedia<T = unknown>(request: CodexMediaExtractionRequest): Promise<T>;
}

interface CodexExtractionEnv {
  GBRAIN_OPENCLAW_COMPLETION_COMMAND?: string;
  GBRAIN_OPENCLAW_GATEWAY_URL?: string;
  OPENCLAW_GATEWAY_URL?: string;
  GBRAIN_OPENCLAW_GATEWAY_TOKEN?: string;
  OPENCLAW_GATEWAY_TOKEN?: string;
  GBRAIN_OPENCLAW_COMPLETION_PATH?: string;
  GBRAIN_OPENCLAW_EXTRACT_PATH?: string;
  [key: string]: string | undefined;
}

export function createConfiguredCodexExtractionClient(env: CodexExtractionEnv = process.env): CodexExtractionClient | undefined {
  const gatewayUrl = (env.GBRAIN_OPENCLAW_GATEWAY_URL ?? env.OPENCLAW_GATEWAY_URL)?.trim();
  const gatewayToken = (env.GBRAIN_OPENCLAW_GATEWAY_TOKEN ?? env.OPENCLAW_GATEWAY_TOKEN)?.trim();
  if (gatewayUrl) {
    return new OpenClawGatewayCodexExtractionClient({
      gatewayUrl,
      gatewayToken,
      completionPath: env.GBRAIN_OPENCLAW_COMPLETION_PATH?.trim() || undefined,
      extractPath: env.GBRAIN_OPENCLAW_EXTRACT_PATH?.trim() || DEFAULT_OPENCLAW_EXTRACT_PATH,
    });
  }

  const command = env.GBRAIN_OPENCLAW_COMPLETION_COMMAND?.trim();
  return command ? new CommandCodexExtractionClient(command, env) : undefined;
}

export class OpenClawGatewayCodexExtractionClient implements CodexExtractionClient {
  readonly supportsFileMedia = true;

  constructor(private readonly options: { gatewayUrl: string; gatewayToken?: string; completionPath?: string; extractPath?: string }) {}

  async completeText(request: CodexExtractionRequest): Promise<string> {
    const reply = await this.callLegacyCompletionBridge(request, false);
    return coerceTextReply(JSON.stringify(reply));
  }

  async completeJson<T = unknown>(request: CodexExtractionRequest): Promise<T> {
    const reply = await this.callLegacyCompletionBridge(request, true);
    if (isRecord(reply) && reply.json !== undefined) return reply.json as T;
    return parseCodexJsonReply(JSON.stringify(reply)) as T;
  }

  async extractMedia<T = unknown>(request: CodexMediaExtractionRequest): Promise<T> {
    const url = new URL(this.options.extractPath ?? DEFAULT_OPENCLAW_EXTRACT_PATH, normalizeGatewayUrl(this.options.gatewayUrl));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.gatewayToken) headers.authorization = `Bearer ${this.options.gatewayToken}`;
    const model = (request.model ?? DEFAULT_CODEX_EXTRACTION_MODEL).replace(/^openai-codex\//, '');
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocol: 'gbrain.media-extraction.v1',
        kind: request.kind,
        sourceRef: request.sourceRef,
        title: request.title,
        text: request.text,
        file: request.file,
        model,
      }),
      signal: request.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenClaw extraction route failed (${res.status}): ${text || res.statusText}`);
    const parsed = parseJson(text, 'OpenClaw extraction route returned non-JSON output');
    if (isRecord(parsed) && parsed.ok === false) throw new Error(`OpenClaw extraction route failed: ${String(parsed.error ?? 'unknown error')}`);
    if (isRecord(parsed) && parsed.extraction !== undefined) return parsed.extraction as T;
    return parsed as T;
  }

  private async callLegacyCompletionBridge(request: CodexExtractionRequest, json: boolean): Promise<unknown> {
    const completionPath = this.options.completionPath?.trim();
    if (!completionPath) {
      throw new Error(
        'OpenClaw gateway generic completion is not enabled on the default /plugins/gbrain/extract route. ' +
        'Use extractMedia() for OAuth-backed media extraction, or use GBRAIN_OPENCLAW_COMPLETION_COMMAND for text-only fallback. ' +
        `Set GBRAIN_OPENCLAW_COMPLETION_PATH=${LEGACY_OPENCLAW_COMPLETION_PATH} only when targeting a legacy completion bridge.`,
      );
    }

    const url = new URL(completionPath, normalizeGatewayUrl(this.options.gatewayUrl));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.gatewayToken) headers.authorization = `Bearer ${this.options.gatewayToken}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocol: 'gbrain.codex-extraction.v1',
        model: request.model ?? DEFAULT_CODEX_EXTRACTION_MODEL,
        prompt: request.prompt,
        json,
      }),
      signal: request.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenClaw legacy completion bridge failed (${res.status}): ${text || res.statusText}`);
    const parsed = parseJson(text, 'OpenClaw legacy completion bridge returned non-JSON output');
    if (isRecord(parsed) && parsed.ok === false) throw new Error(`OpenClaw legacy completion bridge failed: ${String(parsed.error ?? 'unknown error')}`);
    return parsed;
  }
}

export class CommandCodexExtractionClient implements CodexExtractionClient {
  readonly supportsFileMedia = false;

  constructor(private readonly command: string, private readonly env: CodexExtractionEnv = process.env) {}

  async completeText(request: CodexExtractionRequest): Promise<string> {
    const stdout = await this.run(request, 'text');
    return coerceTextReply(stdout);
  }

  async completeJson<T = unknown>(request: CodexExtractionRequest): Promise<T> {
    const stdout = await this.run(request, 'json');
    return parseCodexJsonReply(stdout) as T;
  }

  async extractMedia<T = unknown>(request: CodexMediaExtractionRequest): Promise<T> {
    if (!request.text) {
      throw new Error('Codex extraction command fallback only supports text-backed media extraction');
    }
    return await this.completeJson<T>({
      prompt: buildMediaExtractionPrompt(request),
      model: request.model,
      signal: request.signal,
    });
  }

  private async run(request: CodexExtractionRequest, responseFormat: 'text' | 'json'): Promise<string> {
    const payload = JSON.stringify(toHostPayload(request, responseFormat));
    const proc = Bun.spawn(['sh', '-lc', this.command], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: this.env,
    });

    await proc.stdin.write(payload);
    proc.stdin.end();
    if (request.signal?.aborted) proc.kill();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const reason = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
      throw new Error(`Codex extraction command failed: ${reason}`);
    }
    return stdout;
  }
}

function normalizeGatewayUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Missing OpenClaw gateway URL');
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function toHostPayload(request: CodexExtractionRequest, responseFormat: 'text' | 'json'): Record<string, unknown> {
  const modelRef = request.model ?? DEFAULT_CODEX_EXTRACTION_MODEL;
  const slash = modelRef.indexOf('/');
  return {
    protocol: 'gbrain.codex-extraction.v1',
    provider: 'openai-codex',
    model: slash === -1 ? modelRef : modelRef.slice(slash + 1),
    modelRef,
    responseFormat,
    prompt: request.prompt,
    // Deliberately no apiKey/token fields. The host command/plugin must resolve
    // auth through the OpenClaw runtime for the active user.
    auth: { mode: 'openclaw-runtime' },
  };
}

function buildMediaExtractionPrompt(request: CodexMediaExtractionRequest): string {
  return `Extract this text-backed media into JSON matching gbrain.media-extraction.v1.

Return ONLY JSON. Required shape:
{
  "schemaVersion": "gbrain.media-extraction.v1",
  "kind": "image|pdf|video|audio",
  "sourceRef": "...",
  "title": "...",
  "summary": "...",
  "segments": [{ "id": "segment-0", "kind": "page|transcript_segment|audio_segment|asset", "summary": "...", "transcriptText": "...", "ocrText": "...", "entities": [{"text":"...","type":"..."}], "tags": ["..."] }]
}

Use kind "${request.kind}" and sourceRef "${request.sourceRef}". Preserve important quotes and names.
Title hint: ${request.title ?? '(none)'}

Content:
${request.text}`;
}

function coerceTextReply(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('Codex extraction command returned no output');

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (isRecord(parsed)) {
      if (typeof parsed.text === 'string') return parsed.text;
      if (typeof parsed.output === 'string') return parsed.output;
      if (typeof parsed.content === 'string') return parsed.content;
      if (Array.isArray(parsed.content)) {
        const text = contentBlocksToText(parsed.content);
        if (text) return text;
      }
      if (Array.isArray(parsed.choices) && isRecord(parsed.choices[0]) && isRecord(parsed.choices[0].message)) {
        const message = parsed.choices[0].message;
        if (typeof message.content === 'string') return message.content;
      }
    }
  } catch {
    return trimmed;
  }

  throw new Error('Codex extraction command returned JSON without text content');
}

function parseCodexJsonReply(stdout: string): unknown {
  const parsed = parseJson(stdout, 'Codex extraction command returned non-JSON output');

  if (isRecord(parsed)) {
    if (parsed.json !== undefined) return parsed.json;
    if (typeof parsed.text === 'string') return parseJson(parsed.text, 'Codex extraction text field was not JSON');
    if (typeof parsed.output === 'string') return parseJson(parsed.output, 'Codex extraction output field was not JSON');
    if (typeof parsed.content === 'string') return parseJson(parsed.content, 'Codex extraction content field was not JSON');
    if (Array.isArray(parsed.content)) {
      const text = contentBlocksToText(parsed.content);
      if (text) return parseJson(text, 'Codex extraction content blocks were not JSON');
    }
  }

  return parsed;
}

function contentBlocksToText(blocks: unknown[]): string {
  return blocks
    .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch (err) {
    throw new Error(`${message}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
