# Combined parent bootstrap acceptance — 2026-10-13

The newest specified private Mac backup passed disposable same-device setup and
real Mac/VPS SSH convergence on sealed runtime source
`e79c38229cdc6f2a4b242e42c64e65c900932102` (13.37.0). This does not authorize live
activation. Full historical native Chroma acceptance remains outstanding.

## Source and artifact gates

The runtime contains approved combined source `8a468692`, regenerated worker
bundles, auth fix `a879d5490`, and the prior merged sync/release work. There was no
application-source change after that review. Production build, root/viewer
checks, hook-I/O and spawn guards passed; 193 focused and bundle/version tests
passed with 1,507 assertions. All eight CI checks passed on `e79c38229`.
Generated dependency-string whitespace remains in the exact build output;
source/documentation whitespace checks passed. No `dev` or `build-and-sync` ran.

Separate Mac/Linux dependency trees were retained, overlaid with the reviewed
source/build, and sealed with complete per-file and symlink manifests. All 5,734
Mac files, 6,587 Linux files and six symlinks per platform were verified.

| Artifact | SHA-256 |
|---|---|
| Shared worker bundle | `1e20468121db46c116277f46e455e9dce64bffc8615a9db30afdee461189eb17` |
| Mac archive | `6510fec432833e1a12973f5377997100b9270698ec277e06b70cf775e53b085a` |
| Linux archive | `5e72608bb16b8573bca6fdad2d345ce9e3a1c83c644778813499c5de336420dd` |
| Mac file manifest | `f3beb69224837b632d95d84b23d3e7cfd3fdc4ca0719b4748c6153cb00d9de1d` |
| Linux file manifest | `bec30f231aae92ede3e59bfe6b6031a624b957fd90b21263695bfce3d1e59cfb` |
| Exact source archive | `c6d8f0f0845429adaaf8ae1330869bd85f20ca9dff40f9f6078b776ddd0b38a7` |

## Newest specified snapshot and plan

Input Mac backup SHA-256:
`e969b93cd0b2c1e15518e00c2066e4b1c0cac0a170edbdeb3a50454d82307275`.
The VPS input was its retained independent same-device backup. Neither copy
inherited an initialized identity/journal. Private payloads, identifiers, plans,
credentials and full row-level audits are excluded from this report.

Reconciliation found 108,731 exact original-baseline matches, 3,188 independent
records and 31 changed shared records. Three sessions use the unchanged
standalone completion contract. The combined graph contains 28 shared members
and 404 explicitly hash-bound independent dependents, for exact closure of 432
members. The single parent differs in memory reference and both completion
fields; the other 27 shared members differ only in reference.

An independent Python audit checked original manifest/B hashes, the reference-only
I witness, current C hashes, permitted field differences, advancing consistent
completion timestamps, complete baseline presence, collisions, independence and
graph closure. Five malformed/stale setup variants were rejected on the real
snapshot with zero sync tables and unchanged database bytes. No baseline was
regenerated and no changed shared row was reclassified as independent.

## Complete fresh setup and real SSH convergence

Both devices converged to 112,010 portable records and 112,041 revisions. All
original identities and content were retained; receipt payloads and matching
reference projection were preserved (493 Mac and 19 VPS local receipts).
There were zero payload mismatches, projection errors, work conflicts, entity
conflicts or foreign-key violations. SQLite checks passed. Read-only inspection
after shutdown proved exactly original B plus its direct C child on both devices;
I was never persisted.

Content/identity fingerprint:
`7FzJ9n8cGGf9-bRb2482P_e1niOYrO1E8QAT2Kjd8Zc`.
Work fingerprint:
`eSYnHo30ODh-9TS-3mtr7q2vAEKOYx4c-lmPemL3ph8`.

| Measured phase | Seconds |
|---|---:|
| Mac setup | 28.369 |
| VPS setup | 96.141 |
| Full SSH exchange, including retry | 2,083.751 |
| Initial bootstrap, including prechecks/startup/setup/exchange | 2,332.383 |
| First one-page no-op | 0.507 |
| Second one-page no-op | 0.487 |
| Acceptance through final verification and capture benchmarks | 2,425.301 |

The first SSH attempt reported `SSH request timed out`. The second resumed the
same durable checkpoints and completed; its successful portion took 626.152
seconds. The aggregate exchange timing includes both attempts. A preliminary
attempt had stopped before worker startup because the task-owned SSH multiplex
socket directory was missing; that harness failure was retained separately and
is excluded from the successful bootstrap timing. Existing SSH configuration and
strict host verification were preserved.

Unchanged capture took 0.420 ms on Mac and 3.183 ms on VPS. Forced dirty capture
inside a rolled-back transaction took 1,008.133 ms and 4,437.658 ms respectively.
Both retained the same journal head and native/portable/receipt fingerprints.
These measurements do not recommend a scheduling cadence.

Both owned sync workers were path/hash/PID-verified, stopped, and their disposable
ports verified free before historical indexing started.

## Historical index diagnosis and remaining acceptance

The historical corpus remains separate: 110,858 source records and 678,467
expected native fragments. Its prior reference-only run stopped after 612.045
seconds with `attempt to write a readonly database`. That runner recorded no
statement traceback, so the precise old failing operation remains unproven.

A byte-verified clone of its retained Chroma SQLite checkpoint reproduced the
same error on the coverage query `SELECT embedding_id FROM embeddings`:
macOS Python `mode=ro` returned `SQLITE_READONLY_ROLLBACK` (776) while a Linux
container held a rollback-journal transaction. A reader inside that Linux
container correctly waited for the writer. With the revised read-only/query-only
monitor and busy timeout, the read succeeded after rollback. The clone rolled
back byte-identically and the original checkpoint remained unchanged.

This demonstrates a harness locking-domain failure; attributing the old
untraced event to that same path remains an inference. SQLite documents this
extended code as read-only failure during hot-journal rollback and describes the
locking checks involved: [result codes](https://www.sqlite.org/rescode.html#readonly_rollback)
and [rollback-journal locking](https://www.sqlite.org/lockingv3.html).
No database corruption was established, no permissions were relaxed, and no
application code was changed. Active monitor queries now execute inside the
same Linux container as the writer; host reads are confined to stopped copies.

The resumed full-corpus run uses the new sealed Linux runtime and a clone of the
retained checkpoint after matching source-table fingerprints, device/epoch,
collection and unchanged formatter source. It began at 15,826 indexed fragments
(the previous last sampled progress was 15,665). The original checkpoint stays
retained. Complete expected-ID coverage, native corpus queries/context, durable
deletion failure/retry and restart recovery are still required; zero private
jobs or a small native fixture is not full historical acceptance.

## Parent rollout boundary

Private evidence is under `.claude-mem-sync-acceptance/combined-20261013` on each
host, separate from all older checkpoints. `PARENT-ROLLOUT-COMMANDS.md` prepares
exact archive verification/staging, fresh SQLite backup, quiescent same-device
rollback and runtime startup commands; none was executed against live data.
The parent must review one persistent startup owner and preserve the repaired
Mac launcher, credentials and each device's own data/index/configuration pair.
A direct daemon command alone does not establish that ownership.

Live data can advance beyond this specified backup. Activation requires fresh
read-only backups, a new original-manifest-bound audit for any changed hashes,
full remaining acceptance, and explicit parent approval. Never install copied
acceptance identities, journals, credentials or indexes. No live activation,
restart, settings change, scheduling or merge was performed by this acceptance.
