-- Last accepted TOTP time step per user; codes at or before it are rejected (replay protection).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
