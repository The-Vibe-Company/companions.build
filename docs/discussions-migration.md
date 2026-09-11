# Deploying discussions (THE-637)

This is a destructive schema upgrade. Build and validate the release before deployment.
The PR does not run this procedure against production. Back up PostgreSQL and retain the
resource inventory below before removing anything. Never run an old binary after migration.


Before applying the new fingerprint to an existing environment:

1. Deploy intake-disabled code or otherwise block creation of specialists/templates/builds and stop every old executor, scheduler, trigger worker, and software builder. Confirm no process still executes SQL naming removed tables/columns.
2. Inventory old resources and persist the inventory outside the database transaction: temporary/draft Companion `box_id`, portable software build `box_id` and `create_key`/`create_started_at` even when its Box identity is unknown, all legacy snapshot names, attachment `storage_key`, portable skill bundle `storage_key`, and provider operation identifiers.
3. Cancel old runs. Request archive for each old Companion/software Box, observe provider state `archived`, then and only then persist `archived_at`/`cleanup_status=complete` and close usage intervals. Ambiguous provider results remain blockers and must be reconciled by observation; never replay creation/archive blindly.
4. Preserve every snapshot referenced by a permanent Companion's `snapshot_name` and every `managed_base_images` snapshot. Separately archive the old template/revision/candidate/operation/software snapshot inventory, delete provider snapshots only after proving no permanent reference, and record each provider deletion result.
5. For attachment and portable-skill object keys belonging only to purged legacy records, export the key/hash/size manifest, delete the object, confirm absence, then delete its database row. `legacy-removal.sql` refuses legacy attachment rows and unreferenced legacy bundle rows so object references cannot disappear before blob reconciliation. Preserve bundles selected by a permanent Companion’s pinned template revision (the revision bundle takes precedence over its companion bundle), as well as bundles directly referenced by permanent Companions or main delivery exports, including their provenance IDs and object bytes.
6. Apply migration with old workers still stopped. The transaction will refuse unresolved Boxes/usages/blobs and will not partially drop schema. Verify removed tables/columns are absent, all permanent Companions remain, and their `snapshot_name`, `agent_state_layout`, Box identity, skill bundle, billing ledger, and model accounting remain coherent.
7. Start the new executor/worker. Wake one migrated `per_companion` permanent Companion and verify its prior Pi transcript/files plus `.legacy-state-seeded`; verify a root-layout permanent Companion remains on `/home/user/.companions`.
8. Keep the external resource/blob reconciliation manifest with deployment evidence. Do not delete provider journals until archive/deletion observations are recorded.


## Rollback

Stop the new API, worker and executor before restoring the pre-migration PostgreSQL backup
and previous distribution together. A rollback does not reconstruct deleted blob or snapshot
bytes: retain the backup/export manifest for the required recovery window. Do not replay a
model request or an agent run whose execution outcome is uncertain. Preserve request IDs,
Pi transcripts and local execution journals on permanent machines.

## Validation

`discussion-upgrade.test.ts` loads the complete previous schema from the immutable test fixture
at revision `7e6e7b9439df4a36ba409f1ba1f4a938a28e1fb1`, then applies the current migration. It
checks real foreign-key ordering, routine and specialist deletion, permanent snapshot/machine
identity, retained skill bundles, direct-history backfill, billing tombstones and repeated
fingerprint application. `legacy-removal.test.ts` checks refusal while provider outcomes remain
unreconciled. These tests use isolated databases and make no provider requests.
