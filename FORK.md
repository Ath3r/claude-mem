# Multi-device claude-mem fork

Upstream: https://github.com/thedotmack/claude-mem
Fork: https://github.com/Ath3r/claude-mem

This fork will add self-hosted, multi-device memory synchronization while keeping
upstream improvements. Multi-device sync is **not implemented yet**. Existing
Mac and VPS installations continue running their current release.

## Upstream maintenance

`main` is the integration branch containing upstream code and our additions.
Feature branches and ordinary merges retain our history. Never use a hard reset,
force-update main, or replace the live database to catch up with upstream.

```sh
python3 scripts/fork/sync-upstream.py --check
python3 scripts/fork/sync-upstream.py
python3 scripts/fork/sync-upstream.py --publish --github-repo Ath3r/claude-mem
```

The first command only fetches and reports. The second creates a local candidate
branch in an isolated temporary worktree. The third pushes a uniquely named
candidate and creates a draft PR. All use upstream `main`; these are development
candidates, not automatically approved stable releases. The caller's checkout,
uncommitted changes, main branch, and installed workers are untouched. Conflicts
stop the update and report affected files. Failed PR creation can be retried.

The daily GitHub workflow checks at 06:17 UTC, plus manual dispatch. It becomes
available after this workflow is merged into the fork's default branch and Actions
is enabled. Repository Actions settings must allow GitHub Actions to create PRs.
It uses the repository GITHUB_TOKEN, not a personal access token. GitHub currently
puts PR workflows created through that token into an approval-required state:
approve the workflows and verify candidate validation before marking it ready.
The workflow never merges or deploys. See [GitHub's token documentation](https://docs.github.com/en/actions/concepts/security/github_token).

Validation for an upstream candidate includes the repository's version consistency
test, typecheck, build, relevant upstream tests, and our sync regression tests.
Use an isolated development checkout and disposable databases. Do not run
`build-and-sync` or `dev` against live plugin installations: those commands can
sync the marketplace and restart its worker. Root dependencies currently use
`npm install --no-audit --no-fund`; root has no committed lockfile for `npm ci`.

## Multi-device implementation boundary

Keep the extension small: a worker-integrated sync receiver, portable change
export, and a Mac-initiated SSH push/pull client. No hosted SaaS is required.

Before activation, reconcile the shared migration baseline and assign stable
record identities. Atomic apply/checkpoint transactions and idempotent retries
must preserve device-native rows, updates, and deletions. Conflicts must remain
visible; wall-clock last-write-wins is not enough for work-state events, which
currently replay by local database ID. Include FTS/vector indexing and worker
context-cache invalidation in the apply path. Test duplicate replay, concurrent
edits, offline recovery, shared work-state changes, and schema upgrades.

Upstream import and existing cloud sync do not cover full work-state/session
continuity. Do not describe this fork as operational two-way sync until those
tests and a disposable two-device end-to-end check pass.
