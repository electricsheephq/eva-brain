/**
 * v0.32.7 CJK wave — post-upgrade chunker-bump cost prompt.
 *
 * When `MARKDOWN_CHUNKER_VERSION` bumps, older markdown pages need a
 * re-chunk + re-embed. Re-embed has a real provider bill ($X) and wall-clock
 * cost (Y min) proportional to the brain size. On a 1386-page brain that's
 * pennies; on a 100K-page brain it's tens of dollars. Surprise bills are how
 * trust breaks.
 *
 * Eva policy: upgrade is advisory only. Print a real-data estimate and a
 * manual command, but never mutate/chunk/embed automatically from upgrade.
 * This avoids both surprise provider spend and legacy metadata loss when a
 * row lacks `source_path`.
 *
 * Codex C3 corrections in place:
 *   - Real SQL queries against `pages.chunker_version < N AND page_kind = 'markdown'`
 *     for both page count and char total. No phantom `markdown_body` column.
 *   - Pricing lookup through `src/core/embedding-pricing.ts` keyed on
 *     `provider:model` from the configured gateway, with a clear
 *     "estimate unavailable" message for unknown providers.
 */

import type { BrainEngine } from './engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from './embedding-pricing.ts';

export interface ReembedEstimate {
  pendingCount: number;
  pendingChars: number;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
  modelString: string;
  pricingKnown: boolean;
}

/**
 * Compute the re-embed estimate using only what's actually on the `pages`
 * table after migration v54 applied. Used by both the post-upgrade prompt
 * and tests.
 */
export async function computeReembedEstimate(
  engine: BrainEngine,
  modelString: string,
): Promise<ReembedEstimate> {
  const rows = await engine.executeRaw<{ pending_count: string | number; pending_chars: string | number | null }>(
    `SELECT COUNT(*)::bigint AS pending_count,
            COALESCE(SUM(LENGTH(compiled_truth)) + SUM(LENGTH(timeline)), 0)::bigint AS pending_chars
       FROM pages
      WHERE page_kind = 'markdown'
        AND chunker_version < $1
        AND deleted_at IS NULL`,
    [MARKDOWN_CHUNKER_VERSION],
  );
  const pendingCount = Number(rows[0]?.pending_count ?? 0);
  const pendingChars = Number(rows[0]?.pending_chars ?? 0);
  const price = lookupEmbeddingPrice(modelString);

  if (price.kind === 'known') {
    const estimatedCostUsd = estimateCostFromChars(pendingChars, price.pricePerMTok);
    return {
      pendingCount,
      pendingChars,
      estimatedTokens: Math.ceil(pendingChars / 3.5),
      estimatedCostUsd,
      modelString,
      pricingKnown: true,
    };
  }
  return {
    pendingCount,
    pendingChars,
    estimatedTokens: Math.ceil(pendingChars / 3.5),
    estimatedCostUsd: null,
    modelString,
    pricingKnown: false,
  };
}

/**
 * Format the operator-facing stderr line. Pure function so tests can pin
 * the exact wording.
 */
export function formatReembedPrompt(est: ReembedEstimate, _graceSeconds: number): string {
  if (est.pendingCount === 0) {
    return `[chunker-bump] No pending markdown pages. Skipping re-embed.`;
  }
  const minEst = Math.max(1, Math.ceil(est.pendingCount / 60)); // ~60 pages/min wall-clock heuristic
  if (est.pricingKnown && est.estimatedCostUsd !== null) {
    const dollars = est.estimatedCostUsd.toFixed(2);
    return `[chunker-bump] ~${est.pendingCount} markdown pages need reindexing via ${est.modelString}, rough est. ~$${dollars} (CJK-heavy content may be higher), ~${minEst}min. Upgrade will not run this automatically.`;
  }
  return `[chunker-bump] ~${est.pendingCount} markdown pages need reindexing via ${est.modelString}; pricing estimate unavailable for this provider. Upgrade will not run this automatically.`;
}

export interface PromptResult {
  proceeded: boolean;
  reason: 'no_pending' | 'bypassed_no_reembed' | 'manual_required';
  estimate: ReembedEstimate;
}

/**
 * Run the post-upgrade chunker-bump advisory. Returns proceeded=false for all
 * non-empty cases: the caller should not invoke `gbrain reindex --markdown`
 * automatically from upgrade.
 *
 * Env overrides (codex C3 + D3=B):
 *   - GBRAIN_NO_REEMBED=1     → bail out entirely (writes a doctor warning marker).
 *   - GBRAIN_REEMBED_GRACE_SECONDS is ignored by the advisory-only path.
 */
export async function runPostUpgradeReembedPrompt(
  engine: BrainEngine,
  modelString: string,
  opts: {
    /** Override for tests: pretend stdin is/isn't a TTY. */
    isTTY?: boolean;
    /** Override for tests: how long the wait window is. */
    graceSeconds?: number;
    /** Override for tests: env-var bag. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Override for tests: where to write. Defaults to process.stderr. */
    write?: (line: string) => void;
  } = {},
): Promise<PromptResult> {
  const env = opts.env ?? process.env;
  const writeFn = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const estimate = await computeReembedEstimate(engine, modelString);

  if (estimate.pendingCount === 0) {
    return { proceeded: false, reason: 'no_pending', estimate };
  }

  if (env.GBRAIN_NO_REEMBED === '1') {
    writeFn(`[chunker-bump] GBRAIN_NO_REEMBED=1 set; skipping re-embed sweep. Pending: ${estimate.pendingCount} pages. Re-run \`gbrain reindex --markdown\` when ready.`);
    return { proceeded: false, reason: 'bypassed_no_reembed', estimate };
  }

  const grace = typeof opts.graceSeconds === 'number'
    ? opts.graceSeconds
    : (() => {
        const n = parseInt(env.GBRAIN_REEMBED_GRACE_SECONDS ?? '', 10);
        return Number.isFinite(n) && n >= 0 ? n : 10;
      })();

  writeFn(formatReembedPrompt(estimate, grace));
  writeFn(`[chunker-bump] Run \`gbrain reindex --markdown --repo <brain-repo>\` when ready, or \`gbrain reindex --markdown --repo <brain-repo> --no-embed\` followed by \`gbrain embed --stale\`.`);

  return { proceeded: false, reason: 'manual_required', estimate };
}
