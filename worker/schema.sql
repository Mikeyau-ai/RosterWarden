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

-- Open-shift claims: who took each shift sent out to be picked, first come,
-- first served. `ciphertext` (the person and when) is sealed with a key only
-- the owner and their staff hold; `by_hash` is the hash of a secret from the
-- claimer's link, so only they can change or let go of it.
CREATE TABLE IF NOT EXISTS claims (
  id         TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv         TEXT NOT NULL,
  by_hash    TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

-- How many roster emails each owner's account sent on each day, to hold it to
-- a daily limit. `account` is a hash of the account's email; the emails
-- themselves are never kept.
CREATE TABLE IF NOT EXISTS email_sends (
  account TEXT NOT NULL,
  day     TEXT NOT NULL,             -- YYYY-MM-DD, UTC
  sent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, day)
);
