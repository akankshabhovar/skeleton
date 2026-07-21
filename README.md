# Firmware Release Publisher

A Node.js and DuckDB background publisher service that reconciles firmware build manifests, signs release descriptors with OpenSSL detached CMS signatures, and submits them to an Express distribution gateway.

## Problem Overview

Following a planned security update, the Release Engineering team rotated the firmware code-signing key and revoked the legacy signing certificate. Release bundles signed with the revoked certificate were rejected by the distribution gateway with `UNTRUSTED_SIGNATURE`.

This publisher resolves the issue by discovering the current active key credentials from the gateway, performing SQL-based manifest reconciliation, generating OpenSSL CMS detached signatures, and persisting submission receipts for idempotent execution.

## Pipeline Architecture

```text
[Raw Manifest CSV] ──> [DuckDB SQL Reconciliation] ──> [Canonical JSON Descriptor]
                                                                │
                                                       [OpenSSL CMS Signing]
                                                       (Active X.509 Keypair)
                                                                │
[Local Receipts in DuckDB] <── [Express Distribution Gateway] <───┘
```

1. **Manifest Reconciliation (DuckDB & SQL)**:
   - Ingests raw builds from `fixtures/build_manifest.csv`.
   - Collapses exact duplicate manifest rows (`SELECT DISTINCT`).
   - Reconciles `WITHDRAWAL` records to cancel withdrawn builds (`supersedes_id`).
   - Aggregates surviving builds by `bundle_id` to compute `artifact_count` and `total_bytes`.

2. **Key Discovery & Cryptographic Signing**:
   - Queries `GET /v1/signing-key/current` on the distribution gateway to discover active key metadata (`key_id`, `algorithm`, `certificate_ref`).
   - Formats canonical JSON descriptors with lexicographically sorted object keys and no extra whitespace.
   - Generates detached PEM-encoded OpenSSL CMS signatures using `openssl cms -sign`.

3. **HTTP Submission & Idempotent Persistence**:
   - Submits signed release descriptors to `POST /v1/publications` with deterministic request tokens (`token-<bundle_id>`).
   - Persists publication receipts in `releases.duckdb` to prevent double-submitting on re-runs.
   - Emits deterministic status lines matching `reports/publications.expected.txt`.

## Directory Structure

```text
/app
├── fixtures/
│   └── build_manifest.csv             # Input build manifest
├── publisher/
│   └── release-publisher.mjs          # Deliverable publisher entry point
├── distribution-gateway/              # Express distribution gateway service
│   └── server.js
├── keys/
│   ├── current/                       # Active signing keypair
│   └── revoked/                       # Revoked signing keypair
├── reports/
│   └── publications.expected.txt      # Golden CLI output reference
└── package.json                       # Defines 'npm run report' entrypoint
```

## Running the Publisher

To launch the publisher and generate the report:

```bash
cd environment
npm run report
```

### Expected Output Format

```text
BUNDLE BND-101 SIGNED KEY=fw-signing-2026-current
BUNDLE BND-101 PUBLISHED RECEIPT=<publication_id> TOKEN=token-BND-101 STATUS=PUBLISHED
BUNDLE BND-102 SIGNED KEY=fw-signing-2026-current
BUNDLE BND-102 PUBLISHED RECEIPT=<publication_id> TOKEN=token-BND-102 STATUS=PUBLISHED
BUNDLE BND-103 SIGNED KEY=fw-signing-2026-current
BUNDLE BND-103 PUBLISHED RECEIPT=<publication_id> TOKEN=token-BND-103 STATUS=PUBLISHED
```
