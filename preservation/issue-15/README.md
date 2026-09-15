# Issue 15: DeepSeek V4 Pro xhigh dirty-work snapshot

- Source repository: `/Users/m347724/Code/dreb`
- Source branch: `feature/xhigh-deepseek-v4-pro`
- Base commit: `52583b045595aefee07c0937cf60d19b8390c5ed`
- Patch SHA-256: `b099ed5bca350cbd5a348c2fa094e2247917d5656427255572b78427104923d6`
- Scope: the eight `packages/ai` paths listed by issue 15's handoff

Recovery from the base commit:

```bash
git apply preservation/issue-15/changes.patch
```

The patch was verified with `git apply --check` against the recorded base before this branch was pushed.
