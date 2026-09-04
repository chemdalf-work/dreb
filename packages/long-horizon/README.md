# @dreb/long-horizon

Durable, unattended goal supervision around the existing `@dreb/coding-agent` SDK loop. This package adds planning, bounded autonomous execution rounds, failure escalation, context-safe session rollover, crash recovery, and evidence-gated completion. It does not replace Dreb's model/tool loop, and it is distinct from automatic compaction continuation.

## Start a run

```bash
npm install -g @dreb/long-horizon
dreb-long-horizon start --config run.json
```

Minimal `run.json`:

```json
{
  "objective": "Implement issue 123 and leave the repository verified",
  "planner": { "provider": "your-provider", "modelId": "your-sol-model", "thinkingLevel": "max" },
  "executor": { "provider": "your-provider", "modelId": "your-terra-model", "thinkingLevel": "high" },
  "advisor": { "provider": "your-provider", "modelId": "your-sol-model", "thinkingLevel": "max" },
  "acceptanceCommands": ["npm run build", "npm test"],
  "policy": { "allowedCommands": ["npm run build", "npm test", "git status --short"] }
}
```

Exact provider/model IDs are required. Requested thinking levels are validated and startup fails if the SDK would clamp them. Models and credentials use normal Dreb configuration. The workspace must be a Git repository with a valid `HEAD`; completion evidence hashes tracked changes plus ignored-aware untracked file contents so stale evidence cannot pass after the workspace changes.

## Configuration

The JSON file may also set `cwd`, `runRoot`, an optional fresh `verifier` model, and partial overrides for:

- `limits`: `maxRounds` (100), `maxTotalTokens` (5,000,000), `maxCostUsd` (500), `maxElapsedMs` (7 days), `maxHandoffs` (20), `maxEscalations` (10), `maxUnchangedFailureCycles` (8), and `failureThreshold` (3, so escalation occurs on the fourth matching failure).
- `rollover`: `softTokens` (250,000) and `strongTokens` (300,000), evaluated from current SDK context at completed-round safe edges.
- `policy`: the exact `allowedCommands`, command timeout/output limits, and default-false opt-ins for destructive Git, release, deployment, credential, and remote-state commands.

Configuration is validated strictly, copied into the run directory, and frozen for that run. Acceptance commands cannot be replaced by model output.

## Control

```bash
dreb-long-horizon status .dreb/long-runs/<run-id>
dreb-long-horizon pause  .dreb/long-runs/<run-id> "operator maintenance"
dreb-long-horizon resume .dreb/long-runs/<run-id>
# After inspecting an interrupted side effect:
dreb-long-horizon resume .dreb/long-runs/<run-id> --acknowledge-pending "workspace inspected"
dreb-long-horizon abort  .dreb/long-runs/<run-id> "stop work"
```

Signals and control requests are applied at safe control points; context thresholds never abort an active model turn or tool operation. The default soft boundary is 250k current-context tokens and the strong rollover boundary is 300k. Automatic compaction remains available as emergency protection, but the supervisor disables `continueAfterAutoCompaction` inside hosted sessions so only durable supervisor decisions can dispatch another round.

## Durability and recovery

Each run stores immutable configuration, a checksum-chained append-only journal, an atomically replaced derived snapshot, artifacts, and parent-linked Dreb sessions under `.dreb/long-runs/<run-id>/`. A pending side-effect intent after a crash is treated as ambiguous and blocks instead of being repeated. Corrupt journals, mismatched snapshots, unsupported schemas, and live writer collisions fail closed.

`resume` is deterministic supervisor recovery; restarting the host process remains the responsibility of a service manager.

## Safety model

Planner, advisor, and verifier sessions receive read-only file tools. Executor sessions receive file tools and a policy-enforced `run_command`; unrestricted bash, subagent tools, skills, and project/global extensions are not loaded. Commands are exact allowlist entries parsed into executable/argv and spawned without a shell. Release, deployment, credential, destructive Git, and remote-state mutations are denied unless explicitly enabled in persisted policy. Completion is only recorded after every immutable acceptance command passes with evidence from the current workspace identity. Optional fresh-model final verification can add a gate but cannot replace deterministic acceptance.
