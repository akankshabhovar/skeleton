# Author Notes — Firmware Release Publisher

This document details the design intent, difficulty devices, and grading criteria for the **Firmware Release Publisher** task.

---

## 1. Task Summary & Intent
This task evaluates a candidate's competence in integrating multiple developer skills:
- **Database & Ingestion**: Loading raw CSV records into a local embedded DuckDB database.
- **SQL & Reconciliation**: Filtering, deduplicating, and canceling records using SQL to get a reconciled working set.
- **Key Discovery & Cryptographic Signing**: Dynamically identifying the correct certificate and signing descriptors using an external crypto CLI (`openssl cms`).
- **HTTP Integration**: Submitting payloads over HTTP and maintaining idempotency via request tokens.
- **Persistence & Idempotency**: Storing gateway receipts locally and reusing them during subsequent runs.

---

## 2. Ingestion & SQL Reconciliation Logic
Raw data is loaded from `/app/fixtures/build_manifest.csv` into a DuckDB file `/app/releases.duckdb`. The reconciliation rules are:
- **Duplicate Suppression**: Collapse manifest rows that are exact duplicates across all columns using `SELECT DISTINCT`.
- **Cancellations (Withdrawals)**: A `WITHDRAWAL` record cancels a `BUILD` record when the build's `entry_id` matches the withdrawal's `supersedes_id`.
- **Bundle Qualification**: A bundle is publishable only if it has at least one build that remains after cancellations. If all builds in a bundle have been cancelled (like `BND-104`), the bundle is omitted.
- **Lexicographical Ordering**: Reconciled bundles must be processed in alphabetical order by their `bundle_id` ASC.

---

## 3. Key Discovery & Cryptographic Signing
To sign release bundles, the publisher must fetch the active certificate path:
- **Rotated Key Discovery**: Query `GET http://127.0.0.1:7070/v1/signing-key/current` on the gateway. The gateway exposes the active certificate path. The private key resides in the same folder.
- **Wrong Key Trap**: The gateway rejects any signature signed with the revoked keys in `/app/keys/revoked/` with `UNTRUSTED_SIGNATURE`. The candidate must sign with the discovered active key.
- **Canonical Serialization**: Signed bytes and verified bytes must match exactly. The descriptor JSON keys must be lexicographically sorted (`artifact_count`, `bundle_id`, `total_bytes`) without any extra spaces or newlines.

---

## 4. Idempotency & Client-Side Persistence
The publisher must maintain local submission state:
- **Database Schema**: Maintain a `publications` table in DuckDB to store receipts.
- **Local Deduplication**: Before signing/POSTing a bundle, the publisher checks the `publications` table. If a receipt already exists, it skips the execution loop, outputs the cached receipt, and avoids redundant gateway requests.
- **Deterministic Token**: The request token is formatted as `token-<bundle_id>`. This allows the gateway itself to respond idempotently to duplicates.

---

## 5. Verifier Design & Test Coverage
The verifier test suite is located in `/tests/test_outputs.py` and is run via `/tests/test.sh`. It asserts six functional criteria:
1. `report_output_matches`: Diffs stdout against `/app/reports/publications.expected.txt` (masking receipt IDs).
2. `withdrawals_and_duplicates_reconciled`: Queries `releases.duckdb` to verify that BND-104 is omitted and that sizes/counts of BND-101, BND-102, BND-103 are correct.
3. `bundles_signed_with_current_key_accepted`: Asserts that all database entries are successfully published (no `UNTRUSTED_SIGNATURE`).
4. `receipts_and_tokens_persisted_in_duckdb`: Checks the schema and entries of the DuckDB database.
5. `idempotent_rerun_no_duplicate_publications`: Runs the publisher a second time and verifies that no new publications are registered at the gateway, and receipts match the first run.
6. `revoked_key_signature_rejected`: Submits a descriptor signed with the revoked certificate to confirm the gateway is executing real signature verification.

---

## 6. Difficulty Devices & Grading Rubric
The task contains several subtle devices to assess candidate attention to detail:
- **Key Rotation**: Hardcoding cert paths fails when keys rotate. Discovery must be dynamic.
- **Strict Canonicalization**: Standard formatting of JSON (`JSON.stringify(obj, null, 2)` or unsorted keys) fails verification. The JSON must be compact with sorted keys.
- **Netting to Zero**: Bundles where all builds are cancelled must be skipped entirely.
- **Idempotency**: Re-runs must produce byte-identical stdout and avoid duplicating gateway records.
