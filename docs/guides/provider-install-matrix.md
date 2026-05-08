# Clean integrated install: 2048d embeddings + safe cleanup + verification

This is the recommended customer path for your agent fork right now:

1. **archive any old `~/.gbrain` state instead of patching it in place**
2. **do a fresh init with 2048d embeddings**
3. **verify provider health and brain health immediately**
4. **treat host-managed OAuth extraction as a host-side dependency until live-smoked**
5. **only then import/sync content**

This guide intentionally prefers a clean integrated path over legacy in-place migration complexity.

## Scope and boundary

This branch already documents and ships:
- provider selection via `gbrain init --embedding-model ...`
- provider probing via `gbrain providers list|explain|test`
- safe brain verification via `gbrain doctor --json` and `gbrain stats`

This branch does **not** yet claim a fully merged end-to-end host-managed OAuth extraction flow inside the fork itself.
That work is tracked in the downstream adapter issue.

So the honest integrated install story is:
- **fork side:** fresh 2048d embedding brain + verification
- **host side:** complete the OAuth adapter/auth setup on the host, then verify extraction there
- **cut over only after both halves are green**

## Recommended production target

- embedding provider: **2048d-capable provider**
- model: **`voyage:voyage-4-large`**
- embedding dimension: **2048**
- install style: **fresh init**
- old state handling: **archive, never destructive delete first**

Why this path:
- avoids stale/broken 1536d installs
- makes the dimension contract explicit up front
- gives a clean rollback path
- keeps customer installs reproducible

## One-screen command flow

```bash
# 1) archive old state if present
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/.gbrain-archive
[ -e ~/.gbrain ] && mv ~/.gbrain ~/.gbrain-archive/gbrain-$TS

# 2) configure the documented embedding provider
export VOYAGE_API_KEY=...

# 3) verify provider before init
gbrain providers list
gbrain providers explain
gbrain providers test --model voyage:voyage-4-large

# 4) fresh init at 2048d
gbrain init --pglite --embedding-model voyage:voyage-4-large --embedding-dimensions 2048

# 5) verify the fresh brain
gbrain doctor --json
gbrain stats

# 6) import content only after health is green
gbrain import /path/to/brain-repo --no-embed
gbrain embed --stale
gbrain extract links --source db
gbrain extract timeline --source db
gbrain stats
```

## Safe cleanup of old installs

Do not mutate an unknown old install in place.
Archive it first.

### Local PGLite install

```bash
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/.gbrain-archive
if [ -e ~/.gbrain ]; then
  mv ~/.gbrain ~/.gbrain-archive/gbrain-$TS
fi
```

What this does:
- preserves the old config
- preserves the old local database
- keeps rollback to one `mv` command

### Why archive instead of patching

Old customer installs may have any of these problems:
- stale 1536d embeddings from an older OpenAI-first setup
- mismatched provider env vars
- half-finished migrations
- old config assumptions that hide the real problem

A fresh init is faster and safer than trying to repair every old state shape.

## Fresh init with 2048d embeddings

### PGLite

```bash
export VOYAGE_API_KEY=...
gbrain providers test --model voyage:voyage-4-large
gbrain init --pglite --embedding-model voyage:voyage-4-large --embedding-dimensions 2048
gbrain doctor --json
gbrain stats
```

### Supabase / Postgres

Use a fresh target database or fresh customer database URL.
Do not point a new 2048d install at an old 1536d database.

```bash
export VOYAGE_API_KEY=...
export GBRAIN_DATABASE_URL='postgresql://...'

gbrain providers test --model voyage:voyage-4-large
gbrain init --supabase --non-interactive \
  --embedding-model voyage:voyage-4-large \
  --embedding-dimensions 2048 \
  --url "$GBRAIN_DATABASE_URL"

gbrain doctor --json
gbrain stats
```

## Dimension contract

The embedding dimension is schema-level state.

For common providers:
- OpenAI `text-embedding-3-large` → **1536**
- 2048d provider model → **2048**
- Google `text-embedding-004` → **768**
- Ollama `nomic-embed-text` recipe default → **768**
- LiteLLM → **must be declared explicitly by the operator**

### Operational rule

If the install target is 2048d embeddings, initialize the brain that way from the start.
Do not reuse a 1536d brain and expect the dimension mismatch to self-heal.

### Mismatch behavior

If gbrain receives embeddings whose length does not match the configured dimension, it fails closed with an embedding-dimension error.
That is expected and correct.

## OpenClaw OAuth adapter for extraction

This part is a **host-side plugin dependency**, not a GBrain core embedding
dependency.

What we can safely document here today:
- the fork's fresh 2048d install path is independent of host OAuth
- the OpenClaw plugin exposes `/plugins/gbrain/extract`
- the plugin routes extraction through OpenClaw's logged-in Codex runtime
- the plugin owns extraction concurrency, queue, timeout, interval, and file-size policy
- today's adapter payload is `gbrain.media-extraction.v1`
- upstream GBrain native image pages/files/multimodal embeddings remain the canonical long-term media storage and indexing path
- `import-media` and `ingest-media --extract openclaw` are transitional compatibility commands for materializing adapter output into searchable pages

### Recommended integrated rollout

1. complete the fresh 2048d brain install first
2. verify it with `gbrain doctor --json` and `gbrain stats`
3. install and enable `plugins/openclaw-gbrain`
4. verify extraction on the host side through `/plugins/gbrain/extract`
5. only then start customer imports / syncs

### Verification expectation for the OAuth half

Because the auth adapter is host-side, the verification should also be host-side:
- the host OAuth flow should complete without prompting for a missing API key
- the extraction command/path should stop failing on missing auth
- no secret values should be printed during verification

Until a live host runtime smoke has passed on the target machine, the safe fallback is:
- use the documented 2048d embedding provider
- use normalized media evidence JSON or text-backed extraction paths where applicable
- do not claim binary video/audio/PDF understanding beyond the provider paths actually smoke-tested

## Post-init verification

Run these immediately after fresh init:

```bash
gbrain providers list
gbrain providers explain
gbrain providers test --model voyage:voyage-4-large
gbrain doctor --json
gbrain stats
```

Expected outcomes:
- provider test succeeds and prints a 2048-dim result
- doctor reports healthy schema
- stats returns a working brain with no initialization failure

After import, also run:

```bash
gbrain embed --stale
gbrain stats
gbrain search "test query from your imported content"
```

Expected outcomes after import:
- embedded chunk count rises toward total chunk count
- search returns current content from the imported repo
- `extract links` / `extract timeline` complete cleanly

## Rollback

### Local rollback

If the fresh 2048d install is bad, restore the archived state:

```bash
rm -rf ~/.gbrain
mv ~/.gbrain-archive/gbrain-<timestamp> ~/.gbrain
gbrain doctor --json
gbrain stats
```

### Postgres rollback

Rollback by switching the customer back to the old database URL.
Do not drop the old database until the new install passes verification.

```bash
export GBRAIN_DATABASE_URL='postgresql://...old database...'
gbrain doctor --json
gbrain stats
```

## Failure modes

### `Embedding dim mismatch`

Cause:
- a 2048d provider pointed at a 1536d brain, or vice versa

Response:
- stop retrying
- archive the bad state if needed
- re-init cleanly with the intended provider/dimension

### `gbrain providers test` fails

Cause:
- missing `VOYAGE_API_KEY`
- bad network path
- wrong provider/model string

Response:

```bash
gbrain providers env voyage
gbrain providers test --model voyage:voyage-4-large
```

Fix the env/setup first, then rerun init.

### Brain initializes but import/search is wrong

Response:
- rerun `gbrain doctor --json`
- rerun `gbrain stats`
- rerun `gbrain embed --stale`
- verify you imported the intended repo path

## Minimal customer-safe recommendation

If you're installing this fork for a customer today, the safest story is:

1. archive old `~/.gbrain`
2. fresh init with 2048d embeddings
3. verify provider + brain health immediately
4. treat host OAuth extraction as a separately verified dependency
5. only import customer data after both sides are green
