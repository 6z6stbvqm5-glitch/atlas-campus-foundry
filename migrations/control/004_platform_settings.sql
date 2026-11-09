-- Platform-level settings owned by the operator account.
-- Rows are keyed by a short name; secrets are stored AES-256-GCM encrypted
-- through server/vault.ts before they ever reach this table.
CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
