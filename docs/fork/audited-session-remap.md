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
field changes and stale evidence. The original payload plus its original hash
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

## Verification contract

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
