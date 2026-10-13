# Self-hosted sync release candidate on upstream 13.37

This records historical release preparation, which performed no live activation, installed-worker restart, configuration change, or scheduling, for [PR #6](https://github.com/Ath3r/claude-mem/pull/6), originally stacked on [PR #5](https://github.com/Ath3r/claude-mem/pull/5). Both PRs are now merged; the parent still owns subsequent rollout gates. Later session-remap work has a [separate verification contract](audited-session-remap.md).

## Source and artifacts

Combined tested runtime source: `2694c509222d7923c12c266caeaaa12eca7e5dca`. It contains final PR5 `7f7bd3845b792aaeee0438194e58d780d5f3301a`, sync PR3, auth fix `a879d549074b0655abfe376a615c0ead8b94a56e`, and pinned upstream v13.37.0 `b2756eb31740143e6f464bf65d9f9c766402efc6` with normal merge history. Auth/private-sync source remains byte-identical to final PR5. The sole shared merge surface, `DatabaseManager.ts`, retains upstream's guarded SQLite open and private-sync initialization.

`npm run build` rebuilt committed plugin bundles and lazy SQLite modules. `dev` and `build-and-sync` were never used. All version manifests and injected bundles identify 13.37.0.

| Artifact | SHA-256 |
|---|---|
| Worker bundle | `ffa21bc8ba1e264e8c709c7157aec7407f1c1835a2eff66e0428fccaa2d67a25` |
| Bundled sync CLI | `b9fbc004c1f59374c42041e9e2b7d047d24292d8d27d4de8aa60441fd82bc8b1` |
| Lazy SessionStore | `8e407b68cb2d918dc0f00bdc48d31c976ba5a66120d960a4a1515f79845af997` |
| Lazy observation files | `83bf8d44bb58384157a70ee8ed2412838b05869c5bf80349180939aaff568121` |

Private staging roots end in `.claude-mem-sync-acceptance/release-13.37-20261013` under the Mac user's home and the VPS user's home. They contain a complete source archive, read-only runtimes with separately installed Mac/Linux production dependencies, bundled CLI, source, modes, lazy SQLite assets, resolved dependency inventory, full per-file manifests, and content-addressed runtime archives. The private handoff inventories archive hashes and paths. These archives contain code/dependencies; copied memory, tokens and acceptance plans remain separate and must not be published.

The runtime's minimal dependency manifest is recorded alongside `source-package.json`; it is packaging metadata, not a source manifest change. Invoke the bundled `runtime/cli.js` with Bun and an explicitly isolated `CLAUDE_MEM_DATA_DIR`. Do not put acceptance SSH wrappers on a live service's PATH. The source archive is the exact tested source, before documentation-only handoff changes.

## Fresh combined-runtime evidence

- 166 focused tests and 957 assertions passed, with one optional native test initially skipped. A subsequent native-enabled auth run passed all 53 tests and 146 assertions, including synthetic legacy ChatGPT recognition without rewriting credentials. These counts overlap and must not be summed as distinct tests.
- 28 committed-bundle/version tests and 65 assertions passed. Root/viewer typechecks, production build, spawn-environment and hook-I/O guards passed.
- Build advisory warnings remain: worker 3359.65 KB versus advisory 2900 KB; transcript watcher 341.41 KB versus advisory 200 KB. The enforced build completed successfully. Generated upstream dependency strings also produce trailing-whitespace findings; generated bundles were retained exactly as built.
- Actual combined workers ran on disposable ports 43401/43402 with strict existing SSH host keys. Consistent new copies preserved the prior initialized checkpoints; earlier copies were not edited. Initial exchange and two further exchanges were one-page no-ops.
- Both copies contain 110,858 portable records and 110,861 journal revisions. Complete content/work fingerprints match, all 108,762 shared identities, three reviewed completion changes, 2,036 Mac originals and 60 VPS originals remain. Native row fingerprints stayed unchanged through no-ops and rollback benchmarks. There were no unmapped rows, payload mismatches, conflicts or projection errors; SQLite quick checks passed.
- Content fingerprint: `1PT2t9Jx1bGyeIN73FJwvZ05QfUotEUDwdKyKGwkT-s`. Work fingerprint: `mOSlCbJ4u3a0z9Re2KVUlAiFgAru2UwJwgXadA3juto`.
- Dirty capture took 1,076.545 ms on Mac and 5,583.293 ms on VPS; unchanged capture took 0.339 ms and 0.922 ms. The two real SSH no-ops took 1.608 s and 1.743 s without SSH multiplexing. These are measurements, not a scheduler recommendation.
- A fresh Linux native Chroma fixture indexed observation/prompt/summary, completed a semantic query, retained a failed deletion job across restart, recovered against the same native collection, denied peer-owned public deletion, and propagated deletion over real SSH with no resurrection on repeat exchange.

## Acceptance boundaries and rollout handoff

Full actual-corpus Chroma completion remains unproven. A separate disposable full-corpus probe indexed 918 native embeddings from an empty index within a 180-second budget (184.990 seconds including its final semantic query), and that query passed. Historical backfill had not completed when the owned container was stopped. Zero private jobs did not mean complete historical embeddings; backfill is a separate native pipeline. The copied database/index and checkpoints remain private for continuation. No live installed capture/search/context, live auth generation, fresh production reconciliation, or production rollout is claimed. No full local test suite was run; integrated CI and PR5 final review were parent-owned gates at the time of this preparation.

The corpus test resumed preserved initialized copies, so it is not a new complete bootstrap timing or fresh setup proof on the combined release. Full-copy setup and reconciliation must be repeated on fresh device-specific SQLite backups before live activation, including a newly hash-bound review plan if completion metadata changed. Never copy initialized identity/journals into another live device.

Before any rollout, retain the actual installed plugin trees, service commands, settings, configurations, complete SQLite backups with journals, and local Chroma indexes separately for each device. The live Mac worker digest observed during preparation was `646568035b6bf369fabe4b30f8595f015ba7c411fa86899229d2c6d383759a19`; it was not replaced. Use the [parent backup and release gate](self-hosted-sync.md#parent-owned-release-and-backup-gate), then verify native capture, search, context, deletion, and corpus/work preservation on each target. Preserve the successful Mac launcher repair when packaging the parent's install.

Rollback is parent-controlled: stop/disable only the affected sync lane, retain evidence, and restore that same device's verified install/configuration/database/index checkpoint together. Never use the other device's identity as a rollback image. This preparation leaves live services running their original builds and performs no rollback or activation.

Final read-only checks matched both live workers' original PIDs, versions, paths and bundle hashes. All owned disposable corpus/fixture workers and both Chroma containers were stopped and verified absent.
