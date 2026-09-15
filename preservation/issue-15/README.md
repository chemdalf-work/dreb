# Issue 15: session-appearance dirty-work snapshot

- Source repository: `/Users/m347724/Code/dreb-session-appearance`
- Source branch: `main`
- Source base commit: `a573b4e`
- Storage branch base: Dreb commit `52583b045595aefee07c0937cf60d19b8390c5ed`
- Patch SHA-256: `5180bd697c8d1ebb72b83ea08f2c60516b5d6bf087c45a067e8cdaf6c1b4c60d`
- Scope: five modified appearance package implementation, test, and documentation paths

The source repository has no configured remote, so this dedicated branch in `chemdalf-work/dreb` stores its exact patch. Recover in a clean checkout of the appearance repository at `a573b4e`:

```bash
git apply /path/to/preservation/issue-15/changes.patch
```

The patch was verified with `git apply --check` against the recorded appearance-package base before this branch was pushed.
