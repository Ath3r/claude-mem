# Disposable Mac/VPS compatibility acceptance — 2026-10-13

Acceptance passed on source `f599b78547f02111f62cf8dc62d1e515945f4288`. This report contains aggregates only; corpus copies, manifests, reviewed plans, configs and detailed evidence remain in private acceptance directories. This is not a live activation or release-install claim.

The worker bundle SHA-256 on both hosts was `dadd4d8f12d308f426b4c54fdc812cae00bc46512fa2ec4f744f6027be26f8fc`. Every helper received an isolated `CLAUDE_MEM_DATA_DIR` before importing application code. Builds and tests ran sequentially; no live worker, config, database, index or installed plugin was changed.

## Fixed activation blockers

- Exact legacy empty project strings survive private session/content setup and round trips. Work names, public/Pro validation, authentication, identity and schema checks remain strict.
- Three shared sessions whose only differences were advancing completion fields retain their original identities and current contents through a bounded, hash-bound review plan. Setup records deterministic baseline revisions followed by causal local deltas. Stale or mismatched plans, identities and unreviewed changes fail closed.
- Public observation DELETE accepts proven locally owned private rows and journals their tombstones on capture. Peer-owned, shared-baseline-owned, Pro-imported and unproven rows remain denied.
- Transactional capture counters avoid unchanged full scans. A lazy session-tombstone SQL guard prevents historical scans for live session heads without weakening tombstone protection. The previous guard fails the new regression; the corrected guard passes.

## Fresh setup and complete convergence

Fresh copies came from prior SQLite-consistent snapshots. Their schema upgrade and quick checks passed. The shared manifest contained 108,762 portable records (9,845,152 bytes). Setup preserved portable-content and work-state fingerprints exactly:

| Setup | Matched baseline | Reviewed completion deltas | Independent records | Elapsed |
|---|---:|---:|---:|---:|
| Mac | 108,759 | 3 | 2,036 | 23.96 s |
| VPS | 108,762 | 0 | 60 | 90.79 s |

Actual isolated workers on ports 43301/43302 exchanged over authenticated SSH with pinned host keys. Catch-up resumed from retained checkpoints after interruptions and the diagnosed SQL stall. The final run used the corrected build on both hosts; it did not reset journals or erase differing session metadata.

| Final portable kind | Mac | VPS |
|---|---:|---:|
| Sessions | 4,832 | 4,832 |
| Observations | 83,067 | 83,067 |
| Summaries | 8,410 | 8,410 |
| Prompts | 12,047 | 12,047 |
| Work events | 2,502 | 2,502 |
| Total / maps / current heads | 110,858 | 110,858 |
| Immutable journal revisions | 110,861 | 110,861 |

Both copies retained all 108,762 shared identities, all three reviewed completion advances, all 2,036 Mac originals and all 60 VPS originals. Every portable payload matched its map; no rows were unmapped. Entity conflicts, work conflicts and projection errors were zero. Both SQLite quick checks passed.

Complete ordered map fingerprints matched: `1PT2t9Jx1bGyeIN73FJwvZ05QfUotEUDwdKyKGwkT-s`. Work projection fingerprints matched: `mOSlCbJ4u3a0z9Re2KVUlAiFgAru2UwJwgXadA3juto`. Native row fingerprints stayed unchanged through final no-op verification and rollback benchmarks.

Two real CLI repeats each returned one page, with unchanged counts, journal heads and content/work fingerprints: 0.472 s and 0.436 s.

## Runtime costs and scheduling gate

Catch-up accepted 4,620 pages across four segments. The final segment advanced both checkpoints from 86,544 to 110,861 in 1,014 pages, taking 505.287 s. Earlier segments include interruptions and incomplete monotonic timing records; no exact combined bootstrap duration is claimed. Fresh setup preceded the final SQL-only correction, and the final build resumed those preserved initialized copies rather than repeating setup.

| Capture at converged corpus size | Mac | VPS |
|---|---:|---:|
| Unchanged capture | 0.278 ms | 0.857 ms |
| Forced-dirty full scan | 1,016.685 ms | 4,528.319 ms |

Dirty benchmarks ran inside rolled-back transactions and left counters, journal heads and native fingerprints unchanged. A portable mutation still triggers a full scan. These measurements do not justify an unreviewed frequent scheduler; none was enabled. Parent must measure the integrated release on each target and choose a cadence that accommodates mutation rate, scan cost and index forwarding.

## Public DELETE and native Chroma recovery

A separate disposable fixture ran the same final worker build with isolated native Chroma and a real SSH peer. Before deletion it contained two observation fragments, one prompt and one summary. The normal public DELETE returned success for the local private owner; the peer-owned route returned 404.

Deletion propagated over real sync and repeated exchange did not resurrect it. An unavailable Chroma endpoint left the deletion job durable across restart. Recovery against the original native collection removed every deleted observation fragment, retained the control observation and cleared the job. This proves all three content kinds and deletion recovery in the fixture. It does not prove full-corpus embedding backfill or live-installed capture.

## Validation and cleanup

- 98 focused tests, 763 assertions, 11 files passed on the final source, including the tombstone guard and logger checks.
- Root and viewer typechecks and the production build passed. Separate spawn-environment and hook-I/O guards passed; the final SQL refinement introduced no spawn or hook changes.
- Four independent review rounds approved the implementation, including the final query correction. No full test suite was run.
- All eight GitHub CI checks passed on source `f599b78547f02111f62cf8dc62d1e515945f4288`, including Linux/Windows builds and lifecycle, sync API/hub, dependency closure and server-runtime checks. Subsequent documentation commits and the parent's combined release have their own CI status.
- Owned Mac/VPS corpus workers were identity-checked and stopped with SIGTERM; absence and unavailable health endpoints were verified. The owned SSH mux was closed. The separate fixture container and VPS worker were stopped. Copies and evidence were retained.

The earlier PR3 acceptance supplies historical strict-host-key rejection, offline retry and recovery evidence; those are not relabeled as fresh full-corpus tests here. CI for the final integrated release, full-corpus Chroma indexing, and native installed capture/search/context verification remain outstanding rollout gates.

## Parent handoff

Use the [backup and release gate](self-hosted-sync.md#parent-owned-release-and-backup-gate) and setup/attach commands in the main guide. Preserve auth fix `a879d5490` in the intended 13.37-or-newer release; do not install this fork-13.35 build over the current Mac. Take fresh SQLite backups, reconcile fresh copies, review a newly hash-bound completion plan when needed, and only then activate with the parent's reviewed release.

Run manual catch-up with `sync --config /private/path/mac-sync.json --pages 10000`; resume the same config/checkpoints if bounded catch-up is incomplete. Repeat to a no-op and verify native capture, search, context, deletion and corpus/work fingerprints before considering any schedule. Do not reuse the acceptance plan against changed live hashes or clone an initialized device journal into another device.
