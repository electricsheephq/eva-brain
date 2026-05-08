# GBrain for Codex Desktop

This package makes GBrain available to Codex Desktop as a native local plugin.

It is intentionally thin:

- Codex launches `node ./scripts/launch-gbrain-serve.mjs`
- that launcher resolves a local `gbrain` executable
- then it runs the canonical upstream server via `gbrain serve`

There is no second MCP server here, and no forked search or write logic inside
the plugin package. Codex sees the same GBrain MCP surface that other stdio
hosts see.

## What you get

- the full current upstream GBrain MCP tool surface
- the full checked-in GBrain skill tree, bundled locally in this package
- the same remote/untrusted MCP behavior GBrain already applies to stdio calls

## Resolution order

The launcher resolves `gbrain` in this order:

1. `GBRAIN_CODEX_BIN`
2. repo-local `bin/gbrain`
3. `gbrain` on `PATH` with `$HOME/.bun/bin` prepended

If none resolve, the launcher fails with an install hint. This plugin is an
adapter over a local GBrain install, not a standalone runtime bundle.

## Local repo smoke

From the GBrain repo root:

```bash
bun install
test -x "$HOME/.bun/bin/gbrain" || bun link
node plugins/gbrain-codex/scripts/rehearsal.mjs
```

The rehearsal script creates a temp `GBRAIN_HOME`, initializes PGLite, connects
to the plugin over stdio MCP, checks `tools/list`, and exercises `put_page`,
`get_page`, `search`, `query`, `sync_brain`, and the `whoami` fail-closed path.

## Install in Codex Desktop

Codex plugin discovery is marketplace-based. For a user-local install:

1. Symlink this plugin into `~/plugins`:

```bash
mkdir -p ~/plugins ~/.agents/plugins
ln -sfn /absolute/path/to/gbrain/plugins/gbrain-codex ~/plugins/gbrain-codex
```

2. Create or update `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "local",
  "interface": {
    "displayName": "Local Plugins"
  },
  "plugins": [
    {
      "name": "gbrain-codex",
      "source": {
        "source": "local",
        "path": "./plugins/gbrain-codex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Engineering"
    }
  ]
}
```

3. Restart Codex Desktop.

For repo-local testing, a linked CLI or explicit override is the easiest path:

```bash
bun install
bun link
```

If Codex cannot see your linked `gbrain` on GUI PATH, set:

```bash
export GBRAIN_CODEX_BIN=/absolute/path/to/gbrain
```

For a pure source-tree override during local development, point it at a wrapper
that runs `bun run src/cli.ts`. The rehearsal script creates that wrapper
automatically unless `GBRAIN_CODEX_BIN` is already set.

## Safety boundary

This plugin does not add or loosen GBrain permissions.

- Codex calls arrive through MCP stdio
- GBrain treats those calls as `remote: true`
- operation-level guards stay inside GBrain core

That means Codex gets the full upstream tool surface, but the same stdio-MCP
trust boundary and restrictions still apply.
