# Manual two-way sync over SSH

This fork can exchange local memory between independently operating devices using a private SQLite revision journal. It needs Bun, the fork's worker on each device, curl on the receiver, and an existing SSH key. It does not need cmem.ai Pro. Both directions run from the initiating device: the Mac pushes its journal and pulls the VPS journal in the same exchange. Either device can keep writing while SSH is unavailable. Retrying resumes from SQLite checkpoints.

**This implementation does not install a timer, scheduler, service, or launch agent. Installing/building it does not enable sync.** Live activation requires a separately reviewed upgrade, backups, baseline reconciliation, and explicit setup. Do not run the old `scripts/claude-mem-sync` alongside it: that script's timestamp/title import does not share these identities.

## Boundaries

- Same private protocol (currently 2) and exact SQLite `schema_versions` maximum on both workers. Current source creates schema 65; an installed schema 64 worker must be deliberately upgraded first. Compare the actual stores; the package version alone is insufficient. Protocol 2 includes canonical work scope; journals from earlier PR builds fail closed, including work projection reads, and need explicit recovery on disposable copies.
- Native Pro sync and private sync cannot run simultaneously against one database. They would compete for content origin columns. Disable Pro before setting up this lane.
- Worker must bind to `127.0.0.1`, `::1`, or `localhost`. Routes reject non-loopback peers, browser `Origin`/`Sec-Fetch-Site`, missing/invalid bearer tokens, and public worker binds. SSH host-key verification uses the existing OpenSSH policy; it is never disabled.
- Only sessions, observations, summaries, prompts, and append-only work-state events sync. Tool-use payloads, pending processing queues, authentication/settings files, cwd, worker port, prompt counters, reinforcement/usage state, and embeddings stay local. Portable session fields include original session identifiers, project/platform, prompt/title, start/completion times, and observed model/billing. Remote sessions are created as completed history and cannot launch a processor.
- Sessions/content have tombstones. Session deletion waits until referencing content is deleted and refuses to remove active sessions, pending work, tool uses, or independently created records. Those cases are explicit projection conflicts. Work-state events cannot be edited/deleted; close lists/tasks with status `done` or `dropped`.
- No remote SQL or paths are accepted. Payloads use fixed allowlists, canonical hashes, globally unique origin identities, safe numeric bounds, at most 24 revisions/page, at most 260 KB/revision and 8 MiB/packet, and at most 256 causal references. Baseline manifests are capped at 32 MiB; setup allows a further 64 KiB envelope, and accept allows two packets plus 1 KiB. These routes use bounded JSON parsers after the loopback/authentication gate, reject compressed bodies, and return sanitized errors. Other worker routes retain their 5 MiB limit. Exceeding a bound fails closed without losing local records.

## Reconcile shared history before assigning device identities

Do **not** configure a full Mac snapshot and the VPS clone as independent histories. That assigns two origins to the same historical records. Create one private baseline manifest from a disposable copy of the original shared snapshot; use that same manifest on both sides. A manifest holds only kind/local-ID/content hashes and a random shared namespace. Keep it private and retain it for recovery.

For the existing migration, the baseline backup is `/home/claude/migration-backups/20261012/claude-mem.db.gz`. Do not mutate that backup or either live store while developing. First produce SQLite-consistent disposable copies (SQLite backup API or a stopped-worker snapshot, including WAL consistency). A schema 64 snapshot needs to be migrated on its **disposable copy** using the reviewed fork before generating a schema 65 manifest. The CLI opens explicit database paths read-only and never runs migrations.

```sh
# Run from this fork checkout. All paths below refer to disposable copies.
# Set BEFORE importing any CLI/helper: logger/paths resolve this at module load.
export CLAUDE_MEM_DATA_DIR=/private/path/isolated-tool-data
bun scripts/self-hosted/cli.ts baseline --database /tmp/shared-baseline.db --output /tmp/shared-baseline.json
bun scripts/self-hosted/cli.ts reconcile --database /tmp/mac-copy.db --manifest /tmp/shared-baseline.json
bun scripts/self-hosted/cli.ts reconcile --database /tmp/vps-copy.db --manifest /tmp/shared-baseline.json
```

Read the counts:

| Result | Meaning |
|---|---|
| matched | Local ID and portable-content hash exactly match the shared baseline; adopt the shared identity. |
| independent | Row ID lies outside the baseline; preserve it under this device's own identity. This includes VPS-native rows appended by the prior migration. |
| ambiguous | A baseline row ID has different portable content. It may be an edit, a collision, or a different import. Setup refuses these unless an exact completion-only session bootstrap plan is reviewed; investigate on disposable copies rather than guessing attribution. |

The implementation requires matching IDs for baseline rows. It does not guess mappings for reordered imports, general historical edits, or partially overlapping work-event sequences. Do not bypass an ambiguous report with `--independent`. Missing baseline rows are not inferred as deletions: absence before setup has no deletion authority.

For two stores with truly independent histories, use `--independent` explicitly on each; equal local SQLite IDs are safe because each device gets a different UUID.

### Reviewed session completion advances

An original shared session can legitimately finish after the baseline snapshot. Never erase its completion, remove its manifest entry, or classify it as independent. `setup --bootstrap-plan /private/path/reviewed.json --manifest ...` accepts a bounded exception only for `completed_at` / `completed_at_epoch` advances. Other content, identities, work events, and naming rules remain unchanged. Legacy exactly empty project strings are preserved for portable sessions/content in the private lane; this does not relax Pro/public validation or work naming.

The private plan is a strict JSON object with `protocol`, `namespace`, `schema`, `manifestHash`, and `sessions`. Each entry contains `local`, `expectedHash`, `currentHash`, `allowedFields`, `baselinePayload`, and a nonempty review `reason`. `manifestHash` is SHA-256/base64url of the canonical complete manifest. The two payload hashes use the same canonical hashing. `baselinePayload` must come from the immutable original copy and match that manifest entry. `allowedFields` must exactly enumerate the changed completion fields; new completion values must be a consistent advancing timestamp pair. Do not commit or print this plan: it contains private session metadata. Plans are limited to 256 sessions and 64 KiB.

Review every differing field against immutable and current copies before creating the plan. Setup verifies the entire plan and current rows again inside one immediate SQLite transaction. Stale hashes, changed identity, unexpected fields, duplicate entries, unknown IDs and unreviewed differences fail closed. It journals the deterministic original shared revision, then a local causal child with the current completion; the base row is not rewritten. An unchanged peer's older baseline cannot overwrite that child. Distinct concurrent advances remain explicit conflicts.

### Review checkout aliases before setup

Native work-state reads can combine configured, legacy, and parent checkout project keys, but those relationships are not stored durably with historical events. Setup conservatively refuses histories where the same list/task/key appears under multiple unreviewed projects. This can also block unrelated projects with similar task names; refusal is a safety boundary, not evidence that those projects are aliases. Never merge unrelated projects to bypass it.

For verified checkout aliases, create the same private JSON file on both devices. Each group lists historical keys first and the canonical key last:

```json
[["legacy-checkout", "parent-checkout", "configured-checkout"]]
```

Pass `--work-aliases /private/path/work-aliases.json` to both setup commands below. The alias plan is immutable for this first implementation. It captures shared work events in native append order under one causal scope, preserving completion even if timestamps go backward. Both devices must agree on the canonical scope; mismatched plans reject the batch without advancing checkpoints. If no verified plan resolves an activation refusal, keep sync disabled and retain the native histories for review.

## Explicit setup and connect

Build with `npm run build` after installing dependencies. Do not use `dev` or `build-and-sync` during review: those copy the plugin and restart an installed worker. The CLI runs from the source checkout; it is not yet integrated into the packaged npm binary. Run the reviewed fork worker against the intended data directory only during an approved activation or disposable acceptance run.

On each loopback worker, enable `CLAUDE_MEM_SELF_HOSTED_SYNC_ALLOW_SETUP=1` **only for its setup window**. This flag permits a local non-browser setup request to initialize the journal and return a bearer token. Disable the flag after setup. Identity, epoch, protocol and token persist in that database. Do not clone an initialized private journal as a new device: peer checks reject cloned identities; initialize a new disposable device and reconcile its baseline instead.

```sh
# Run locally on the Mac with the Mac worker, and locally on the VPS with the VPS worker.
# Each command writes a 0600 file without printing the token.
bun scripts/self-hosted/cli.ts setup --worker http://127.0.0.1:37777 --config /private/path/mac-sync.json --manifest /private/path/shared-baseline.json
bun scripts/self-hosted/cli.ts setup --worker http://127.0.0.1:37778 --config /private/path/vps-sync.json --manifest /private/path/shared-baseline.json
```

Transfer the receiver's private config to a private local path using SSH/scp. It contains a bearer token; do not paste it into chat or commit it. Then run on the Mac:

```sh
bun scripts/self-hosted/cli.ts attach --config /private/path/mac-sync.json --ssh claude@178.105.10.196 --port 37778 --remote-token-file /private/path/vps-sync.json
bun scripts/self-hosted/cli.ts status --config /private/path/mac-sync.json
bun scripts/self-hosted/cli.ts sync --config /private/path/mac-sync.json
```

The remote command is a fixed curl request to `127.0.0.1:<port>` over authenticated SSH; JSON goes through stdin. SSH targets/ports/tokens are validated, no shell paths are interpolated, and response/request sizes and timeouts are bounded. The CLI serializes invocations using a private config lock; a dead process's lock is recovered after verifying its PID is absent. Private config files must have permissions 0600. `attach` is read-only against the receiver and verifies it is configured.

A sync returns aggregate status and checkpoints without printing memories or tokens. `--pages 1000` is the default bounded catch-up limit; when reached, exit 2 means rerun to continue. Network/worker failures return exit 1; offline local writes remain usable. No checkpoint advances past a failed SQLite transaction. Retry the same command when available; don't delete the journal or reset cursors.

```sh
bun scripts/self-hosted/cli.ts disable --config /private/path/mac-sync.json
bun scripts/self-hosted/cli.ts enable --config /private/path/mac-sync.json
```

If setup committed but the response/config file was lost, use `recover-config --database /explicit/claude-mem.db --worker http://127.0.0.1:37777 --config /private/path/recovered.json`. It opens that explicitly named database read-only and writes a new 0600 config without printing its token; it never replaces the device identity. Reattach the intended SSH receiver afterward.

These preserve identity and history. Disable also returns work-state reads to their original local event view; enable restores the causal projection. Neither changes a scheduler because none is installed.

More devices can use their own config files and workers. The same device UUID/journal supports multiple peers, each with separate incoming/outgoing checkpoints. Use a separate initiating CLI config for each SSH target, preserving the same local token/worker. Status shows all peers.

## Conflict handling

Content/session revisions record their causal parents. A receiver applies an unambiguous descendant, retains concurrent heads with their complete payloads, and exposes aggregate conflicts. It keeps its existing physical row while conflicted; other devices may display their own retained version until an explicit resolution. A single writer cannot silently overwrite another device's concurrent edit. A later deliberate local edit after observing all heads, or the command below, resolves the content register.

```sh
# These explicit inspection commands print the selected memories; use privately.
bun scripts/self-hosted/cli.ts inspect --config /private/path/mac-sync.json --entity observation:HASH
bun scripts/self-hosted/cli.ts resolve --config /private/path/mac-sync.json --entity observation:HASH --chosen REVISION_HASH
bun scripts/self-hosted/cli.ts sync --config /private/path/mac-sync.json
```

Work-state stores each immutable append event with the observed list frontier. The read projection compares causality per task/key, rather than SQLite IDs, timestamps, or network arrival. A causally later `done` remains completed when older events arrive. Concurrent `done`/`todo` becomes a visible `SYNC_CONFLICT` status, so the task is surfaced for resolution. Status lists competing event IDs; inspect the list privately:

```sh
bun scripts/self-hosted/cli.ts inspect-work --config /private/path/mac-sync.json --project PROJECT --list LIST
```

After reviewing both values, write the chosen task/key through the normal `work_state_write` tool on a device that has received both histories. That new append observes both competing events and resolves those keys. Unmentioned keys and independently created tasks remain intact. Timestamps are retained only for display.

An identity/foreign-key collision or locally referenced session tombstone becomes a `projectionErrors` entry; the full revision remains durable. Referencing content/session rows are never merged or deleted by guessing. Projection is retried after dependencies clear. Correct attribution on disposable copies before production recovery.

## Storage, indexes and recovery

The opt-in extension uses `self_sync_*` tables rather than changing upstream schema versions. New setups install SQLite triggers that increment a transactional change counter for portable inserts, updates and deletes from every connection. Before exchange, a dirty counter causes a portable-row scan, fingerprint comparison and revision capture. An unchanged counter skips the scan. Validated incoming projections acknowledge their own changes inside the same transaction; rollback also rolls back the counter. Work-journal selection uses a kind/sequence index instead of reparsing all content payloads. Incoming content checks the current session head deletion flag before looking through retained session identities; the explicit lazy SQL guard prevents the optimizer from scanning all history for every live session. Older configured journals without the counter retain conservative full scans; this patch does not silently migrate them. A worker restart preserves uncaptured changes. Dirty scans still read the full portable corpus, and work-state projection still replays retained events; measure on each target before scheduling frequent sync.

Received revisions, projections, replay identities and peer checkpoints commit in one SQLite transaction. Full immutable revision history is retained; there is no compaction/pruning yet, allowing long offline catch-up and explicit conflict inspection. Epoch/protocol/schema changes fail closed and need deliberate recovery rather than silently resetting cursors. SQLite restore must preserve the complete private journal and peer checkpoints; restore both original device identity and epoch only for that same device. A replacement device needs new setup/baseline review.

Native `CanonicalContent` validates observation/summary/prompt payloads. Native `SyncApply` handles their local row/session mapping. Base-table writes activate SQLite FTS triggers. The worker emits in-process context invalidation only after commit, and persists index jobs in SQLite before Chroma forwarding. Failed forwarding stays pending and retries on the next exchange or worker startup; native Chroma also retains its existing pending reconciliation markers. Deletion jobs remove all Chroma fragments for that SQLite record. Public observation DELETE permits an originally local private observation only when the enabled matching-protocol journal maps it to the current device and both stored origin fields agree. Peer-owned, shared-baseline-owned, Pro-imported and unproven origins remain denied. Normal capture appends the deletion tombstone before the next exchange; immutable prior revisions remain retained. Content conflicts remain visible through status; resolving them schedules a fresh index projection.

Session updates can change joined prompt fields and cascade memory identifiers into observations and summaries. Their receiver-side fingerprints and index jobs update atomically with the session projection, so a later page does not mistake those SQL effects for new local edits. Genuine local edits are captured before applying incoming pages and remain distinct revisions. Native content application cannot implicitly create/adopt/merge session stubs or leave a portable row different from its revision; such projections remain explicit conflicts until authoritative session metadata makes the association safe.

## Validation evidence and gaps

Focused tests use disposable stores only. They cover two-way exchanges across all five kinds, retries/no-op batches,70 event paging, session FK mapping, simultaneous edits and explicit resolution, offline catch-up, content/session tombstones without resurrection, preservation of independent rows, receiver/client crash rollback, shared baseline identities and VPS-native preservation, strict protocol/schema/hash/identity rejection, prototype-named fields, durable index jobs and cache invalidation. Three-device tests cover shared work-state completion, delayed events, concurrent completion/reopen and explicit causal resolution.

The HTTP tests use the production middleware, including a baseline above 5 MiB, valid large 24-revision pages, a two-packet accept body, exact byte limits, authentication before parsing, and sanitized parser errors. Alias regressions cover refused activation, reviewed shared history, completion before any exchange, mismatched plans, and concurrent reopening. A 24-session page regression covers joined prompts and observation/summary cascades without receiver-authored revisions, index scheduling, and preservation of a genuine edit between pages.

The CLI smoke runs two disposable worker-route HTTP servers with real CLI subprocesses and curl. A temporary SSH shim simulates remote command execution; it does **not** prove real SSH authentication, host-key handling, the production worker lifecycle, installed plugin compatibility, live Chroma, or real Mac/VPS baseline attribution. Those remain required before live activation. No existing Mac/VPS store, service, plugin installation, or schedule was changed.

### Parent-owned release and backup gate

The compatibility branch is based on fork 13.35.0 and includes auth fix `a879d5490`. It is **not** an installable downgrade for a Mac running 13.37. Parent must integrate the reviewed compatibility commit and auth fix into its intended upstream release, verify both changes are present, pass that release's CI, and build that version before either live install. No upstream merge, installed-worker restart, scheduler, or live database change is part of this PR.

Before rollout, on each device independently, take a SQLite backup under its own private directory. Substitute that device's verified live database and backup path; do not copy a running `.db` file without its WAL:

```sh
umask 077
python3 - "$verified_live_db" "$new_private_backup_db" <<'PY'
import pathlib, sqlite3, sys
source, destination = map(pathlib.Path, sys.argv[1:])
if not source.is_file() or destination.exists():
    raise SystemExit('source missing or backup path already exists')
src = sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)
dst = sqlite3.connect(destination)
try:
    src.backup(dst)
    if dst.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise SystemExit('backup integrity failed')
finally:
    dst.close()
    src.close()
PY
```

Retain the prior install/build, service command, settings and private configs separately for rollback. Run full reconciliation again against fresh consistent copies immediately before setup: the three-session plan from acceptance is bound to those copied contents and is not reusable if live hashes have advanced. Prepare a newly reviewed plan for any changed completion metadata; other changes still require investigation. Set `CLAUDE_MEM_DATA_DIR` before every helper/CLI launch. Setup has a bounded five-minute transport budget for large corpus initialization; if a response is lost, inspect/recover the existing identity rather than starting independent setup.

After the parent deploys its version-preserving release, use the setup/attach commands above with the reviewed manifest and, only on the device needing it, `--bootstrap-plan`. Keep the setup flag window short. Run manual sync to completion, repeat to a no-op, verify native capture/search/context/deletion and the retained corpus/work fingerprints, then review measured dirty-scan and exchange costs before enabling any separately managed schedule. Preserve initialized device identities and complete journals in subsequent backups. If acceptance fails, disable private sync on both devices and restore only the affected device's verified backup/install through the parent's rollout procedure; never swap one initialized device database into the other.
