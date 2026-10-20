-- One row per synced database. The server never sees plaintext: `ciphertext`
-- and `iv` are produced on the device and are meaningless without the user's
-- secret, which is never transmitted.
CREATE TABLE IF NOT EXISTS blobs (
  id         TEXT PRIMARY KEY,   -- hex SHA-256 derived from the user's secret
  ciphertext TEXT NOT NULL,      -- base64 AES-GCM ciphertext
  iv         TEXT NOT NULL,      -- base64 12-byte nonce, fresh for every write
  updated_at TEXT NOT NULL       -- ISO timestamp, set by the device
);

-- Staff link mailboxes: one each way per staff member, encrypted with a key
-- only the owner and that staff member hold (it lives in the link's #).
-- `revoked` is set when the owner replaces a link, so the old one can never
-- write again.
CREATE TABLE IF NOT EXISTS mailboxes (
  id         TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
