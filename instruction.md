# Task: Firmware Release Publisher

A security rotation has occurred. The Release Engineering team rotated the code-signing key for the IoT device fleet and retired the old certificate. Since this rotation, every release bundle submitted to the gateway has been rejected with `UNTRUSTED_SIGNATURE` because the legacy publisher service is still signing payloads with the old, revoked certificate.

Your job is to (re)write the release publisher service in Node.js and SQL/DuckDB so that it reconciles builds, signs release descriptors with the currently active key, and securely publishes them.

---

## Deliverable File Path

Implement the publisher service as an ESM module at:
`/app/publisher/release-publisher.mjs`

It must be executed by the grader (and by you) via:
`npm run report` (which runs `node publisher/release-publisher.mjs --report`)

---

## Requirements and Steps

### 1. Database Setup and Manifest Ingestion
Create an embedded DuckDB database file at `/app/releases.duckdb`. Do not pre-create it; it must be initialized at run time.
- Create a table called `publications` to store submission receipts with the following schema:
  - `bundle_id` (VARCHAR, PRIMARY KEY)
  - `request_token` (VARCHAR, NOT NULL)
  - `publication_id` (VARCHAR, NOT NULL)
  - `status` (VARCHAR, NOT NULL)
  - `published_at` (TIMESTAMP, default current timestamp)
- Read the raw manifest CSV from `/app/fixtures/build_manifest.csv` and import it into DuckDB.

### 2. SQL Manifest Reconciliation
Formulate SQL queries to reconcile the imported manifest and derive the list of **publishable release bundles**:
- **Collapse Exact Duplicates**: Suppress duplicate rows in the manifest that are byte-identical across *every* column. Count each distinct row exactly once.
- **Apply Withdrawals**: A manifest row with `record_type = 'WITHDRAWAL'` cancels a build row where the build's `entry_id` matches the withdrawal's `supersedes_id`. Cancelled/withdrawn builds are not part of any release.
- **Filter Publishable Bundles**: A bundle (`bundle_id`) is publishable only if it has at least one surviving (non-withdrawn) build. If all builds within a bundle have been withdrawn, the entire bundle must be skipped.
- **Aggregate Bundle Metrics**: For each surviving bundle, compute the number of surviving builds (`artifact_count`) and the sum of their sizes in bytes (`total_bytes`).
- Reconciled bundles must be processed in **lexicographical ascending order** of their `bundle_id`.

### 3. Active Key Discovery
Query the Express distribution gateway's local metadata endpoint over HTTP to determine which key is currently active:
- **Endpoint**: `GET http://127.0.0.1:7070/v1/signing-key/current`
- **Response Format**: `{ key_id, algorithm, certificate_ref, status }`
- **Key Location**: The `certificate_ref` tells you the absolute path of the current certificate (e.g., `/app/keys/current/current.cert.pem`). The corresponding private key is located in the same directory (e.g., `/app/keys/current/current.key.pem`). Do *not* sign with the revoked keys in `/app/keys/revoked/` as they will be rejected by the gateway.

### 4. Canonicalization and OpenSSL Signing
For each publishable bundle:
- **Canonical Descriptor**: Format a canonical JSON descriptor object with lexicographically sorted keys and no insignificant whitespace:
  `{"artifact_count":<count>,"bundle_id":"<id>","total_bytes":<size>}`
  *Warning*: The signed bytes and the sent bytes must match exactly. insigificant spaces, linebreaks, or unsorted keys will result in signature verification failures.
- **OpenSSL CMS Signing**: Generate a detached CMS signature in PEM format using the `openssl` CLI:
  ```bash
  openssl cms -sign -in <descriptor_path> \
    -signer /app/keys/current/current.cert.pem \
    -inkey /app/keys/current/current.key.pem \
    -outform PEM -binary
  ```
  Ensure the signer and inkey files point to the active certificate and private key found during key discovery.

### 5. Gateway Submission
Submit each bundle's descriptor to the distribution gateway:
- **Endpoint**: `POST http://127.0.0.1:7070/v1/publications`
- **Request Body**:
  ```json
  {
    "descriptor": "...",       // The canonical descriptor string or object
    "signature": "...",        // The PEM-encoded detached signature from OpenSSL
    "request_token": "..."     // A unique request token formatted as 'token-<bundle_id>'
  }
  ```
- **Response**: `{ publication_id, request_token, status: "PUBLISHED" }` on success, or an error code such as `UNTRUSTED_SIGNATURE` if signature verification fails.

### 6. Persistence & Idempotency
- **Deduplication**: Before signing or submitting a bundle, query your local DuckDB `publications` table.
- **Idempotency**: If a bundle has already been successfully published in a previous run:
  - Re-use the existing receipt (`publication_id`, `request_token`, `status`) from the database.
  - Do *not* re-sign the payload or POST to the gateway again.
  - Format status output lines using the cached receipt.
- **Recording**: If the bundle is not yet published, submit it, verify the gateway response, and record the returned `publication_id`, `request_token`, and `status` in the `publications` table.

### 7. CLI Output Format
For every publishable bundle, the program must output exactly two lines to stdout, ordered by `bundle_id` ASC:
```text
BUNDLE <bundle_id> SIGNED KEY=<key_id>
BUNDLE <bundle_id> PUBLISHED RECEIPT=<publication_id> TOKEN=token-<bundle_id> STATUS=PUBLISHED
```
- `<key_id>` is the active key identifier returned by the key discovery endpoint.
- `<publication_id>` is the publication identifier returned by the submission endpoint.

---

## Success Criteria

1. Running `npm run report` produces status lines matching `/app/reports/publications.expected.txt` (receipt ID is masked by the verifier).
2. The DuckDB analytical database `/app/releases.duckdb` correctly lists the publications, request tokens, and receipts.
3. Rerunning `npm run report` is fully idempotent: the stdout is identical, receipts are reused, and the gateway ledger contains no duplicate submissions.
4. Interact with the gateway *only* over HTTP. Do not read or write its private ledger at `/app/distribution-gateway/data/gateway.json`.
