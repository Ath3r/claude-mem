# Audited session reference bootstrap

## Diagnosis and bounded plan

The fresh private audit found one unchanged content-session identity with a UUID
memory reference replaced by `codex-<same content-session>-<epoch>`. Exactly one
session, thirteen observations, six summaries and eight joined prompts differ;
every other portable field matches its original manifest hash. The retained copy
has no foreign-key violations. No private identifiers or payloads belong here.

`CodexProvider.syntheticIdPrefix` and `OpenAICompatibleProvider.startSession`
explain this shape: switching to that provider from a different reference calls
`SessionStore.updateMemorySessionId`. That transaction changes the parent key,
cascades observation/summary FKs and updates local tool receipts; prompts derive
their reference from the parent. This is source-supported attribution, not a
claim to possess a historical call trace. The unrelated upstream registration
fix (#4027) already prevents repeated Claude registration churn and stays intact.

Implement a separate, explicitly reviewed `sessionRemapPlan`, never an expansion
of completion-only `bootstrapPlan`. Bind the entire plan to the original manifest
and each member to its baseline/current hashes, old/new non-null references and
original payload. Require a complete baseline on the accepting device and exact
closure of the current linked graph. Reject omitted/extra/duplicate members,
missing baseline rows, unreviewed independent dependents, reference collisions, non-reference
field changes (except the explicit parent completion contract below) and stale evidence. The original payload plus its original hash
proves the old graph; reconciliation rejects any changed row outside the plan.

The complete private graph also has 398 post-baseline dependents (321 observations,
30 summaries, 47 prompts). List them explicitly in `independentRows` with a null
expected baseline hash and exact current hash. Require their absence from the
manifest and null prior ownership, and keep ordinary device-owned capture roots.
A missing graph member, changed payload or pre-existing owner is a rejection.

Validate under setup's IMMEDIATE transaction before creating state. Seed original
shared roots with the original owner/local identity, then let ordinary capture
append local causal deltas, without rewriting portable rows. Keep the Pro guard,
auth rules, baseline updater and completion-only validator unchanged.

Receiver projection also carries local tool receipt references that match the
exact prior parent key. Receipts have no cascading memory-reference FK. Keep all
receipt payloads and unrelated historical/null references intact, in the same
projection savepoint as the parent and ordinary dependent cascade. A receipt
failure must roll back the parent too; no receipt is transferred between devices.

## Optional combined parent completion

A newer private snapshot changed the same parent's memory reference and both
completion fields. The reference-only plan must continue to reject it unless a
separate review supplies this strict optional `sessionRemapPlan` field:

```ts
parentCompletion?: {
  mode: 'completion-pair-after-remap-v1';
  referenceOnlyHash: string; // SHA-256 base64url, exactly 43 characters
  reason: string;           // 1–512 characters
}
```

For the single graph parent, B is the original manifest-bound baseline payload;
I is B with only the approved new memory reference; C is the current payload.
Validate B against its expected hash and the original manifest, I against
`referenceOnlyHash`, and C against its reviewed current hash. I to C must change
exactly both `completed_at` and `completed_at_epoch`. C must pass strict session
validation, contain a consistent non-null timestamp pair and advance beyond B's
non-null completion epoch using the existing bootstrap completion rule.

I is only a validation witness. It is never persisted as a revision, native row,
or replacement manifest, and proves no historical ordering. Setup still seeds
original B and captures a single B to C child. True concurrent parent deltas
remain explicit conflicts. All dependent reference-only validation, complete
graph closure, ownership, collisions, hash and size bounds remain in force.
An exception on a reference-only parent is rejected. Completion-only
`bootstrapPlan` is unchanged; other parents may have separate completion
approvals, but approvals for the same parent cannot overlap.

The approved combined source at `8a468692` has regenerated worker bundles and
fresh root/viewer typechecks. Combined disposable acceptance remains a release
gate. The previous sealed reference-only artifacts do not validate this source
or the newer combined snapshot; those checkpoints remain retained unchanged.

## Verification contract

Fresh validation after regenerating the combined worker bundle: 193 tests and
1,507 assertions passed across the two bootstrap/remap suites, logger standards,
committed bundle checks and version consistency. Production build, root/viewer
typechecks, hook-I/O and spawn-environment guards passed with an isolated data
directory. The logger reports only aggregate graph counts. These checks do not
prove newest-backup SSH convergence or historical native Chroma acceptance.

The older reference-only run completed 111,878 records and 111,909 revisions
with equal fingerprints, preserved receipts and two one-page no-ops. Its
historical Chroma continuation stopped at 15,665 of 678,467 fragments with
`attempt to write a readonly database`; the failing SQLite operation was not
identified by that runner. Historical coverage, native query/context and deletion
restart recovery remain unproven. This report does not authorize activation.

Tests must prove all four kinds retain native content, ownership, FKs and root
history; old-root-first and remap-first page exchange must converge without false
conflicts or new no-op revisions. Reject malformed, partial, duplicate, stale and
conflicting plans without sync tables or row changes. Force a late setup failure
to prove rollback after root creation. Preserve genuine concurrent edits.

After focused tests/typechecks/build guards, package new immutable Mac/Linux
artifacts and verify their manifests. Repeat setup on independent disposable
device backups, actual SSH convergence/no-ops and capture timings. Retain private
data fingerprints and total bootstrap time. Resume full-corpus native Chroma only
after source/device/collection and formatter verification; require expected-ID
coverage, native search/context, deletion and restart recovery. No live activation.
