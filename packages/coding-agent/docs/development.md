# Development

See [AGENTS.md](../../../AGENTS.md) for build requirements, release protocol, and the completeness rule.

## Prerequisites

- **Node.js** 22 LTS (CI runs on Node 22)
- **npm** (comes with Node)

## Setup

```bash
git clone https://github.com/chemdalf-work/pierre-dreb
cd pierre-dreb
npm install
npm run build
```

Run from source:

```bash
node /path/to/dreb/packages/coding-agent/dist/cli.js
```

The script can be run from any directory. Pierre Dreb keeps the caller's current working directory.

## Monorepo structure

```
packages/
  ai/              # Model registry, provider APIs, types (@dreb/ai)
  agent/           # Core agent loop, event system, types (@dreb/agent-core)
  tui/             # Terminal UI components (@dreb/tui)
  coding-agent/    # CLI, tools, interactive mode, TUI app (@dreb/coding-agent)
  semantic-search/ # Semantic code search library + MCP server (@dreb/semantic-search)
  telegram/        # Telegram bot frontend over RPC (@dreb/telegram)
  dashboard/       # Web dashboard server/client over RPC (@dreb/dashboard)
```

Dependencies flow one way through the workspace: `coding-agent` depends on `agent`, `ai`, and `tui`; frontend packages such as `telegram`, `dashboard`, and `semantic-search` build on the published workspace APIs instead of creating reverse dependencies. Changes to a dependency require rebuilding downstream packages — `npm run build` handles this automatically in the correct order.

## Optional external analysis package

[dreb-context-mode](https://github.com/chemdalf-work/dreb-context-mode) is an optional installable extension package, not a generic MCP client in core. Its automatic main-session and subagent discovery, advisory routing, OS-process privileges, and package-owned persistent storage belong to that package's documentation and tests. Keep core documentation explicit about that boundary; do not add `ctx_*` tools, arbitrary MCP dispatch, or RTK interception to core. RTK remains rejected because its fidelity, exit-code, and actionable-diagnostic failures are unsafe for automatic use.

## Code style

The project uses [Biome](https://biomejs.dev/) for linting and formatting:

```bash
npx biome check --write <files>    # Lint + format
npx biome check --write .          # Whole repo
```

A pre-commit hook runs biome checks, tests, and `tsgo --noEmit` (matching CI) automatically.

## Testing

```bash
npm test                                           # All workspace tests
npx vitest --run packages/coding-agent/test/some.test.ts  # Single file
bash test.sh                                       # Full suite, including configured live providers
bash test.sh --no-live-api                         # Offline suite (skips live provider calls)
```

CI runs `bash test.sh`. The script does not unset API keys: provider tests run when their credentials are available, including OAuth credentials from `~/.dreb/agent/auth.json`, and can consume tokens or subscription quota. CI normally has no provider credentials, so its live tests skip. Use `--no-live-api` for explicit offline isolation; it sets `DREB_SKIP_LIVE_API=1`. Both script modes disable local LLM tests.

When updating live model fixtures, check protocol behavior as well as catalog membership. Adaptive Claude tests that assert visible thinking must request `thinkingDisplay: "summarized"`. A conservative registry window is not necessarily the endpoint's hard limit: overflow tests may need to check full input usage (`input + cacheRead + cacheWrite`) when the server accepts a request beyond the configured window.

## Type checking

```bash
npx tsgo --noEmit
```

CI runs this across the full repo including `examples/`. Run it locally before committing — tests alone won't catch type errors in non-test files.

The pre-commit hook runs in order: biome check → `tsgo --noEmit` → `test.sh`.

## Contributing

1. Open an issue describing the change
2. Create a feature branch from `master`
3. Make changes, ensure tests pass and `tsgo --noEmit` is clean
4. Open a PR against `master` — CI must be green before merge

## Forking / Rebranding

Product identity and compatibility paths are configured independently in `package.json`:

```json
{
  "drebConfig": {
    "displayName": "Pierre Dreb",
    "commandName": "pierre-dreb",
    "compatibilityName": "dreb",
    "configDir": ".dreb",
    "envPrefix": "DREB",
    "upstreamBaseline": "aebrer/dreb@52583b0"
  },
  "bin": {
    "pierre-dreb": "dist/cli.js",
    "dreb": "dist/cli.js"
  }
}
```

`displayName` controls user-facing branding and `commandName` controls examples and diagnostics. `compatibilityName`, `configDir`, and `envPrefix` remain independent so a fork can change its visible identity without breaking existing `~/.dreb`, project `.dreb`, or `DREB_*` behavior. During a command transition, both bin names should point to the same compiled entry point.

## Path Resolution

Pierre Dreb runs in three execution modes (npm install, standalone binary, tsx from source), all of which need to find package assets correctly.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.dreb/agent/dreb-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM
