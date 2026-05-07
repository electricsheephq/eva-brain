# GBrain Installation Guide for AI Agents

Read this entire file, then follow the steps. Ask the user for `VOYAGE_API_KEY`
only if the local environment does not already provide it.
Target: ~30 minutes to a fully working brain.

## Step 0: If you are not Claude Code

Read `AGENTS.md` at the repo root first. It's the non-Claude-agent operating
protocol (install, read order, trust boundary, common tasks). Claude Code reads
`CLAUDE.md` automatically and can skip ahead.

If you fetched this file by URL without cloning yet, the companion files live at:
- `https://raw.githubusercontent.com/electricsheephq/eva-brain/master/AGENTS.md` — start here
- `https://raw.githubusercontent.com/electricsheephq/eva-brain/master/llms.txt` — full doc map
- `https://raw.githubusercontent.com/electricsheephq/eva-brain/master/llms-full.txt` — same map, inlined

## Step 1: Install GBrain

```bash
git clone https://github.com/electricsheephq/eva-brain.git ~/eva-brain && cd ~/eva-brain
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install && bun link
```

Verify: `gbrain --version` should print a version number. If `gbrain` is not found,
restart the shell or add the PATH export to the shell profile.

> **Do NOT use `bun install -g github:electricsheephq/eva-brain`.** Bun blocks the top-level
> postinstall hook on global installs, so schema migrations never run and the CLI
> aborts with `Aborted()` when it opens PGLite. Use the `git clone + bun link` path
> above. Tracking issue: [#218](https://github.com/garrytan/gbrain/issues/218).

## Step 2: AI Provider Setup

Default Eva/OpenClaw path:

```bash
export VOYAGE_API_KEY=...
```

Save it to the shell profile or to `~/.gbrain/gbrain.env`. Voyage is for
embeddings. OpenClaw/Codex OAuth is used by the OpenClaw plugin for extraction;
do not ask users for an OpenAI API key just to run Eva Brain extraction.

Before initializing the brain, verify the provider you plan to use:

```bash
gbrain providers list
gbrain providers explain
gbrain providers test --model voyage:voyage-4-large
```

Without an embedding provider, keyword search still works but semantic/hybrid retrieval will not.

If you want Google, Ollama, LiteLLM, or another provider instead of Voyage, read:

- `docs/guides/provider-install-matrix.md` — provider matrix, exact init commands, dimension contract, rollback notes
- `docs/GBRAIN_VERIFY.md` — post-install verification checklist

**OpenClaw Codex OAuth note:** the OpenClaw plugin exposes `/plugins/gbrain/extract`
and routes extraction through OpenClaw's logged-in Codex runtime. The GBrain CLI
still needs a gateway URL/token when calling that route from outside OpenClaw,
but the extraction model auth is owned by OpenClaw, not by a user-supplied
OpenAI API key.

## Step 3: Create the Brain

```bash
gbrain init --pglite --embedding-model voyage:voyage-4-large --embedding-dimensions 2048
gbrain doctor --json                  # verify all checks pass
```

## Step 3.5: Install The OpenClaw Plugin

If OpenClaw is installed on this machine, install the native plugin from the
same Eva Brain checkout:

```bash
cd ~/eva-brain
openclaw plugins install --dangerously-force-unsafe-install ./plugins/openclaw-gbrain
openclaw plugins enable gbrain
openclaw gateway restart
openclaw plugins inspect gbrain --runtime --json
openclaw gbrain status
```

The plugin provides:

- `gbrain_status`
- `gbrain_search`
- `gbrain_query`
- `/plugins/gbrain/extract` for OAuth-backed extraction through OpenClaw/Codex

If OpenClaw is not installed, skip this step and keep the CLI/MCP path.

## Step 3.6: Install The OpenClaw Support KB

For OpenClaw customer/support work, install the KB source and support skills
after GBrain is healthy:

```bash
export OPENCLAW_SUPPORT_KB_REPO="https://github.com/electricsheephq/openclaw-support-kb.git"
export GBRAIN_PARENT="${GBRAIN_HOME:-$HOME}"
export OPENCLAW_SUPPORT_KB_DIR="$GBRAIN_PARENT/.gbrain/sources/openclaw-support-kb"

if [ -d "$OPENCLAW_SUPPORT_KB_DIR/.git" ]; then
  git -C "$OPENCLAW_SUPPORT_KB_DIR" pull --ff-only
else
  git clone "$OPENCLAW_SUPPORT_KB_REPO" "$OPENCLAW_SUPPORT_KB_DIR"
fi

cd "$OPENCLAW_SUPPORT_KB_DIR"
node scripts/update-client.mjs
node scripts/status.mjs
```

This installs the four OpenClaw support skills and registers the
`openclaw-support-kb` GBrain source.

The user's markdown files (notes, docs, brain repo) are SEPARATE from this tool repo.
Ask the user where their files are, or create a new brain repo:

```bash
mkdir -p ~/brain && cd ~/brain && git init
```

Read `~/eva-brain/docs/GBRAIN_RECOMMENDED_SCHEMA.md` and set up the MECE directory
structure (people/, companies/, concepts/, etc.) inside the user's brain repo,
NOT inside `~/eva-brain`.

## Step 4: Import and Index

```bash
gbrain import ~/brain/ --no-embed     # import markdown files
gbrain embed --stale --source default # generate vector embeddings for this brain source
gbrain query "key themes across these documents?"
```

## Step 4.5: Wire the Knowledge Graph

If the user already had a brain repo (Step 3 imported existing markdown), backfill
the typed-link graph and structured timeline. This populates the `links` and
`timeline_entries` tables that future writes will maintain automatically.

```bash
gbrain extract links --source db --dry-run | head -20    # preview
gbrain extract links --source db                         # commit
gbrain extract timeline --source db                      # dated events
gbrain stats                                             # verify links > 0
```

For brand-new empty brains, skip this step — auto-link populates the graph as the
agent writes pages going forward. There is nothing to backfill yet.

After this step:
- `gbrain graph-query <slug> --depth 2` works (relationship traversal)
- Search ranks well-connected entities higher (backlink boost)
- Every future `put_page` auto-creates typed links and reconciles stale ones

If a user has a very large brain (>10K pages), `extract --source db` is idempotent
and supports `--since YYYY-MM-DD` for incremental runs.

## Step 5: Load Skills

Read `~/eva-brain/skills/RESOLVER.md`. This is the skill dispatcher. It tells you which
skill to read for any task. Save this to your memory permanently.

The three most important skills to adopt immediately:

1. **Signal detector** (`skills/signal-detector/SKILL.md`) — fire this on EVERY
   inbound message. It captures ideas and entities in parallel. The brain compounds.

2. **Brain-ops** (`skills/brain-ops/SKILL.md`) — brain-first lookup on every response.
   Check the brain before any external API call.

3. **Conventions** (`skills/conventions/quality.md`) — citation format, back-linking
   iron law, source attribution. These are non-negotiable quality rules.

## Step 6: Identity (optional)

Run the soul-audit skill to customize the agent's identity:

```
Read skills/soul-audit/SKILL.md and follow it.
```

This generates SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md
(who sees what), and HEARTBEAT.md (operational cadence) from the user's answers.

If skipped, minimal defaults are installed automatically.

## Step 7: Recurring Jobs

Set up using OpenClaw's scheduler/Minions job path when available. Plain
`crontab` is a local fallback only, because background agents cannot answer
interactive shell-approval prompts.

- **Local-only brain refresh** (every 15 min): `gbrain import ~/brain --no-embed && gbrain embed --stale --source default`
- **Git-tracked brain sync** (every 15 min): use `gbrain sync --repo ~/brain && gbrain embed --stale --source default`
  only when `~/brain` has a configured git remote and upstream tracking branch.
  If `git -C ~/brain remote -v` is empty, use the local-only import command above.
- **Support KB refresh** (after `openclaw-support-kb` updates): run
  `node scripts/update-client.mjs && gbrain embed --stale --source openclaw-support-kb`
  from `$OPENCLAW_SUPPORT_KB_DIR`, so KB changes do not trigger a full-brain
  stale embed sweep.
- **Auto-update** (daily): `gbrain check-update --json` (tell user, never auto-install)
- **Dream cycle** (nightly): read `docs/guides/cron-schedule.md` for the full protocol.
  Entity sweep, citation fixes, memory consolidation, plus (v0.23+) overnight conversation
  synthesis and cross-session pattern detection. 8 phases, one cron-friendly command. This
  is what makes the brain compound. Do not skip it.
- **Weekly**: `gbrain doctor --json && gbrain embed --stale --source default`

## Step 8: Integrations

Run `gbrain integrations list`. Each recipe in `~/eva-brain/recipes/` is a self-contained
installer. It tells you what credentials to ask for, how to validate, and what cron
to register. Ask the user which integrations they want (email, calendar, voice, Twitter).

Verify: `gbrain integrations doctor` (after at least one is configured)

## Step 9: Verify

Read `docs/GBRAIN_VERIFY.md` and run all 7 verification checks. Check #4 (live sync
actually works) is the most important.

## Upgrade

```bash
cd ~/eva-brain && git pull origin master && bun install
gbrain init                           # apply schema migrations (idempotent)
gbrain post-upgrade                   # show migration notes for the version range
```

Then read `~/eva-brain/skills/migrations/v<NEW_VERSION>.md` (and any intermediate
versions you skipped) and run any backfill or verification steps it lists. Skipping
this is how features ship in the binary but stay dormant in the user's brain.

For v0.12.0+ specifically: if your brain was created before v0.12.0, run
`gbrain extract links --source db && gbrain extract timeline --source db` to
backfill the new graph layer (see Step 4.5 above).

For v0.12.2+ specifically: if your brain is Postgres- or Supabase-backed and
predates v0.12.2, the `v0_12_2` migration runs `gbrain repair-jsonb`
automatically during `gbrain post-upgrade` to fix the double-encoded JSONB
columns. PGLite brains no-op. If wiki-style imports were truncated by the old
`splitBody` bug, run `gbrain sync --full` after upgrading to rebuild
`compiled_truth` from source markdown.
