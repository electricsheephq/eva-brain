/**
 * Lightweight probes for local AI providers. Used by the providers wizard
 * to auto-detect ready endpoints before prompting the user.
 */

export interface ProbeResult {
  reachable: boolean;
  models_endpoint_valid?: boolean;
  error?: string;
}

/**
 * Probe an OpenAI-compatible /v1/models endpoint. Per Codex C-secondary-4:
 * port-open is insufficient — a broken daemon can accept connections but
 * serve garbage. We validate the response is JSON with the expected shape.
 */
function openAICompatModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

export async function probeOpenAICompat(baseUrl: string, timeoutMs: number = 1000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(openAICompatModelsUrl(baseUrl), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { reachable: true, models_endpoint_valid: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return { reachable: true, models_endpoint_valid: false, error: 'non-JSON response' };
    }
    const isList = (body as any).object === 'list' && Array.isArray((body as any).data);
    return { reachable: true, models_endpoint_valid: isList };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeOllama(env: Record<string, string | undefined> = process.env): Promise<ProbeResult> {
  const url = env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
  return probeOpenAICompat(url);
}

export async function probeLMStudio(env: Record<string, string | undefined> = process.env): Promise<ProbeResult> {
  const url = env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
  return probeOpenAICompat(url);
}

/**
 * Probe llama.cpp's `llama-server --embeddings` endpoint. Defaults to port
 * 8080 (llama-server's default; distinct from Ollama's 11434 and LM Studio's
 * 1234). Override via `LLAMA_SERVER_BASE_URL` env, or pass `baseURL` directly
 * (callers with access to `cfg.base_urls['llama-server']` should pass it so
 * probe agrees with what the gateway will actually call).
 */
export async function probeLlamaServer(baseURL?: string): Promise<ProbeResult> {
  const url = baseURL ?? process.env.LLAMA_SERVER_BASE_URL ?? 'http://localhost:8080/v1';
  return probeOpenAICompat(url);
}
