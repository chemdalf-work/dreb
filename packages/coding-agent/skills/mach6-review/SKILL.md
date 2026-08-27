---
name: mach6-review
description: "Run round-aware specialist review, post unverified candidates, then assess practical merge blockers with adversarial counter-pressure. Usage: mach6-review 42 [aspects]"
argument-hint: "<pr-number> [code|errors|tests|completeness|simplify]"
---

# mach6-review — Round-Aware Multi-Agent PR Review

**User input:** $ARGUMENTS

## Global Rules

1. GitHub is shared memory. Post two comments in every round: `<!-- mach6-review -->`, then `<!-- mach6-assessment -->` as each body's first line.
2. Never use `#N` in comment bodies; say "finding N".
3. Track work with `tasks_update`.
4. Set `GH_PAGER=cat` and `GH_EDITOR=cat` for every `gh` command. Use `--body-file` with a unique `mktemp /tmp/gh-comment.$$.XXXXXXXX` file.
5. Formal review runs only from an explicit user request; never invoke it autonomously or start a review-fix-review loop.
6. Review durable work only. Do not review uncommitted or unpushed work.
7. Do not fix findings in this session; fixes require a later user-invoked `/skill:mach6-implement`.

## Optional `context_mode` routing boundary

`context_mode` is available only through the optional, separately installed `dreb-context-mode` package. This guidance is advisory, not universal deterministic interception.

1. Start code discovery with `search`.
2. Use native tools for expected output of ≤2 KB; for 2–5 KB unless the work is clearly analytical; and for edits, verbatim, exact, or ordered facts, and Git/CI/version/release/publish evidence.
3. Use `context_mode` only for precise, large derived analysis or broad gathers expected to exceed 5 KB.
4. Treat its output as derived, not proof: directly verify material claims against source or bounded native evidence.
5. On an unavailable or failed call, show a bounded visible diagnostic, then continue natively; never silently fall back or report partial protocol output as success.
6. Never invoke `ctx_*` directly, arbitrary MCP methods, or a generic MCP client in core.
7. RTK is rejected due to fidelity, exit-code, and actionable-diagnostic failures.

**Review-stage limit:** each reviewer may receive at most one bounded `context_mode` packet; every reviewer must verify its material claims against source or tests before reporting a finding.

## Required child handoff

When launching a child, repeat the routing boundary above and provide the exact task, a bounded file set or claim set, required direct verification, validation commands, and completion criteria. Set every task item's `cwd` to the verified `REVIEW_CWD`; do not rely on the parent session's working directory. The child must use no direct `ctx_*` calls, arbitrary MCP methods, or a generic MCP client in core.

## Step 1: Track tasks

Track prepare, phase-one review, findings comment, phase-two assessment, assessment comment, and summary; keep at most one task in progress.

## Step 2: Parse input

Extract the required PR number and optional aspects: `code`, `errors`, `tests`, `completeness`, `simplify`.

## Step 3: Prepare, determine the round, and establish the review context

Before checkout, run `git status --porcelain`. If non-empty, stop and use `suggest_next` to offer `/skill:mach6-push`.

```bash
gh pr checkout <pr-number>
git pull --ff-only
test -z "$(git status --porcelain)"
LOCAL_HEAD="$(git rev-parse HEAD)"
PR_HEAD="$(gh pr view <pr-number> --json headRefOid --jq '.headRefOid')"
test "$LOCAL_HEAD" = "$PR_HEAD"
REVIEW_CWD="$(git rev-parse --show-toplevel)"
test -n "$REVIEW_CWD"
```

If either durable-work check fails, stop without marking ready, posting, or launching agents and offer `/skill:mach6-push`. `PR_HEAD` is the exact reviewed commit.

Read the PR body, all comments, files, linked original issue and discussion, latest `<!-- mach6-plan -->`, and subsequent human-approved scope updates. Prior findings and assessments are evidence, not scope authority.

Count comments whose bodies start with `<!-- mach6-review -->`:

```bash
PR_CONTEXT="$(gh pr view <pr-number> --json title,body,comments,files,headRefOid)"
PRIOR_ROUNDS="$(printf '%s' "$PR_CONTEXT" | jq '[.comments[] | select(.body | startswith("<!-- mach6-review -->"))] | length')"
REVIEW_ROUND="$((PRIOR_ROUNDS + 1))"
```

Use `gh pr diff <pr-number>` in every round. The full PR and the interactions among all of its changes are the review target unless the user explicitly requests a narrower review.

For round 3+, also extract the most recent parseable full SHA after `Reviewed commit:` in the latest review comment. If found, use `git log <sha>..HEAD` and `git diff <sha>..HEAD` as supplemental context for identifying new changes and verifying prior fixes, never as a replacement for the full PR diff. Extract previous merge blockers and verify that each is fixed. Do not reject a finding merely because the relevant lines are unchanged since the previous round.

Mark the PR ready only after all checks pass: `gh pr ready <pr-number>`.

## Step 4: Phase one — specialist candidates

Agent mapping: `code` → `code-reviewer`; `errors` → `error-auditor`; `tests` → `test-reviewer`; `completeness` → `completeness-checker`; `simplify` → `simplifier`.

Without targeted aspects, run `code-reviewer`, applicable `error-auditor`, applicable `test-reviewer`, applicable `completeness-checker`, and `simplifier` together in one parallel `subagent` `tasks` call in every round. Set `cwd: REVIEW_CWD` on every task item. `test-reviewer` remains present whenever the PR contains testable code changes.

With targeted aspects, run only mapped agents while still reviewing the full PR unless the user explicitly requests a narrower target. Set `cwd: REVIEW_CWD` on every task item.

If dispatch arbitration or a specialist agent fails, retry that specialist with a one-item `tasks` array carrying `cwd: REVIEW_CWD`; do not use single mode because older dreb versions may ignore a top-level cwd. Do not omit a required or requested specialist because its first attempt failed.

Give every agent changed paths, the full PR diff and context, authoritative scope, actual files, and confidence scoring (0–100; report only candidates at least 80). In round 3+, also provide the prior reviewed SHA, supplemental delta, and previous blockers so agents can verify fixes without narrowing the review target. Verify previous blockers independently even if no agent reports them.

## Step 5: Post unverified candidates

Always post the phase-one comment, even with no candidates. Severity is reviewer confidence, not an assessed shipping decision.

```markdown
<!-- mach6-review -->
## Unverified Review Candidates — Pending Assessment

**Review round:** N
**Reviewed commit:** <full PR_HEAD SHA>

> These are unverified candidates. Severity reflects reviewer confidence; do not treat any item as a merge blocker until the assessment comment is posted.

### Critical
...
### Important
...
### Suggestions
...
### Strengths
...

**Agents run:** ...

---
*Reviewed by mach6*
```

Post with a unique temp file and `gh pr comment <pr-number> --body-file "$GH_BODY"`; save the returned/latest comment URL.

## Step 6: Phase two — assess with counter-pressure

All assessors receive identical candidate findings, actual code, the full PR diff and PR/issue context, verbatim original quoted requests, acceptance criteria, approved scope changes, and the review round. For round 3+, also provide the latest delta as supplemental fix-verification context without narrowing assessment of the full PR.

Apply three gates:
1. **Factual:** current code contains the problem.
2. **Scope:** fixing it is required by authoritative scope or a PR-introduced material regression.
3. **Practical:** shipping plausibly causes meaningful harm in supported use, through a credible attacker/system failure, or directly violates an explicit acceptance criterion.

Rounds 1–2: launch `independent-assessor` alone.

Round 3+: launch `independent-assessor`, `developers-advocate`, and `devils-advocate` together in one parallel `subagent` `tasks` call. This preserves model-family diversity where available. The devil's advocate supplements, never replaces, `test-reviewer` and attacks acceptance evidence. The developer's advocate attacks the practical value of proposed work and cannot generate findings.

In round 3+, a candidate is a merge blocker only when both the independent assessor and developer's advocate find material practical impact. Do not vote or average confidence. When they disagree, the parent adjudicates by writing a concrete actor, exact reachable trigger sequence, resulting user harm or attacker capability, existing safeguards, and material outcome of fixing it. Without that concrete trigger-and-outcome sequence, it is not a merge blocker. Use devil's-advocate output to determine the minimal missing acceptance evidence, not to manufacture unrelated findings.

Missing tests are not blockers by themselves: identify the important regression, practical consequence, and why current tests miss it.

## Step 7: Post assessment

Post the second comment with a unique temp body:

```markdown
<!-- mach6-assessment -->
## Review Assessment

<link to findings comment>

### Classifications
| Finding | Classification | Reasoning |
|---|---|---|
| ... | merge blocker / useful follow-up / discarded observation / nitpick / false positive / deferred | **Factual:** ... **Scope:** ... **Practical:** ... |

### Action Plan
<merge blockers only, ordered by priority>

---
*Assessment by mach6*
```

Classify every candidate. Useful follow-ups and deferred observations stay outside the action plan.

## Step 8: CLI summary

Report each classification, counts of merge blockers/nitpicks/false positives/deferred, and the merge-blocker-only action plan. Ask whether to create issues for deferred follow-ups, using unique temp body files.

Suggest exactly one next command:
- Merge blockers: `/skill:mach6-implement <pr-number> <finding-numbers>`
- No merge blockers: `/skill:mach6-publish <pr-number>`
