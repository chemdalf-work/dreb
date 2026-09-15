# Issue 15: long-horizon dirty-work snapshot

- Source repository/worktree: `/Users/m347724/Code/dreb-long-horizon-issue-8`
- Source branch: `feature/issue-8-long-horizon-supervisor`
- Base commit: `03f05f9`
- Patch SHA-256: `f4a162026d62f5f1e0acfe419e36f360e3c0861127170fd7c4380dbcf5fa356e`
- Scope: seven modified long-horizon source, test, and documentation paths

Recovery from the base commit:

```bash
git apply preservation/issue-15/changes.patch
```

The patch was verified with `git apply --check` against the recorded base before this branch was pushed.
