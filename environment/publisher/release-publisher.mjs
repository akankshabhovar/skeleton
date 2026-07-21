import duckdb from 'duckdb';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const GATEWAY_BASE_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:7070';
const MANIFEST_PATH = process.env.MANIFEST_PATH || 'fixtures/build_manifest.csv';
const DB_PATH = process.env.DB_PATH || 'releases.duckdb';

async function main() {
  const db = new duckdb.Database(DB_PATH);

  const runQuery = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

  const execSql = (sql) =>
    new Promise((resolve, reject) => {
      db.exec(sql, (err) => (err ? reject(err) : resolve()));
    });

  try {
    // 1. Setup publications table in DuckDB for persistence & idempotency
    await execSql(`
      CREATE TABLE IF NOT EXISTS publications (
        bundle_id VARCHAR PRIMARY KEY,
        request_token VARCHAR NOT NULL,
        publication_id VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Import CSV manifest into DuckDB and perform SQL reconciliation
    if (!fs.existsSync(MANIFEST_PATH)) {
      throw new Error(`Manifest file not found at ${MANIFEST_PATH}`);
    }

    await execSql(`
      CREATE OR REPLACE TABLE raw_manifest AS 
      SELECT * FROM read_csv_auto('${MANIFEST_PATH.replace(/'/g, "''")}');

      CREATE OR REPLACE TABLE manifest_dedup AS 
      SELECT DISTINCT * FROM raw_manifest;

      CREATE OR REPLACE TABLE publishable_bundles AS
      SELECT 
        bundle_id,
        COUNT(*) AS artifact_count,
        SUM(size_bytes) AS total_bytes
      FROM manifest_dedup
      WHERE record_type = 'BUILD'
        AND entry_id NOT IN (
          SELECT supersedes_id 
          FROM manifest_dedup 
          WHERE record_type = 'WITHDRAWAL' AND supersedes_id IS NOT NULL
        )
      GROUP BY bundle_id
      ORDER BY bundle_id ASC;
    `);

    const bundles = await runQuery(`
      SELECT bundle_id, artifact_count, total_bytes 
      FROM publishable_bundles 
      ORDER BY bundle_id ASC;
    `);

    // 3. Discover active key metadata from distribution gateway
    const keyResp = await fetch(`${GATEWAY_BASE_URL}/v1/signing-key/current`);
    if (!keyResp.ok) {
      throw new Error(`Failed to fetch current signing key metadata: ${keyResp.status} ${keyResp.statusText}`);
    }
    const keyInfo = await keyResp.json();

    const certPath = keyInfo.certificate_ref;
    const keyPath = certPath.endsWith('.cert.pem')
      ? certPath.replace(/\.cert\.pem$/, '.key.pem')
      : path.join(path.dirname(certPath), 'current.key.pem');

    // 4. Process each publishable bundle
    for (const bundle of bundles) {
      const bundleId = bundle.bundle_id;
      const requestToken = `token-${bundleId}`;

      // Check if already published and recorded in local DuckDB
      const existing = await runQuery(
        `SELECT request_token, publication_id, status FROM publications WHERE bundle_id = ?`,
        [bundleId]
      );

      let receipt;

      if (existing && existing.length > 0) {
        receipt = existing[0];
        console.log(`BUNDLE ${bundleId} SIGNED KEY=${keyInfo.key_id}`);
      } else {
        // Construct canonical descriptor (UTF-8 JSON, sorted keys, no extra whitespace)
        const descriptorObj = {
          artifact_count: Number(bundle.artifact_count),
          bundle_id: String(bundleId),
          total_bytes: Number(bundle.total_bytes)
        };
        const canonicalDescriptor = JSON.stringify(descriptorObj);

        // Generate OpenSSL detached CMS signature
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sig-'));
        const tmpDescriptorPath = path.join(tmpDir, 'descriptor.json');
        fs.writeFileSync(tmpDescriptorPath, canonicalDescriptor, 'utf8');

        let signaturePem;
        try {
          signaturePem = execFileSync(
            'openssl',
            [
              'cms',
              '-sign',
              '-in', tmpDescriptorPath,
              '-signer', certPath,
              '-inkey', keyPath,
              '-outform', 'PEM',
              '-binary'
            ],
            { encoding: 'utf8' }
          );
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }

        console.log(`BUNDLE ${bundleId} SIGNED KEY=${keyInfo.key_id}`);

        // Submit to distribution gateway over HTTP
        const pubResp = await fetch(`${GATEWAY_BASE_URL}/v1/publications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            descriptor: canonicalDescriptor,
            signature: signaturePem,
            request_token: requestToken
          })
        });

        if (!pubResp.ok) {
          const errBody = await pubResp.text();
          throw new Error(`Publication failed for ${bundleId}: ${pubResp.status} ${errBody}`);
        }

        receipt = await pubResp.json();

        // Persist receipt in DuckDB
        await runQuery(
          `INSERT INTO publications (bundle_id, request_token, publication_id, status) VALUES (?, ?, ?, ?)`,
          [bundleId, receipt.request_token, receipt.publication_id, receipt.status]
        );
      }

      console.log(
        `BUNDLE ${bundleId} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${receipt.request_token} STATUS=${receipt.status}`
      );
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('Publisher error:', err);
  process.exit(1);
});
