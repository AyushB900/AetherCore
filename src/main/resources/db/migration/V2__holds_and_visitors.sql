ALTER TABLE accounts ADD COLUMN held_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD CONSTRAINT available_nonnegative CHECK (held_minor >= 0 AND (kind='CLEARING' OR held_minor <= balance_minor));
ALTER TABLE transfers DROP CONSTRAINT transfers_operation_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_operation_check CHECK (operation IN ('TRANSFER','DEPOSIT','REVERSAL','CAPTURE'));
ALTER TABLE transfers ADD COLUMN reversal_of UUID UNIQUE REFERENCES transfers(id);

CREATE TABLE payment_holds (
 id UUID PRIMARY KEY,
 idempotency_key VARCHAR(128) NOT NULL UNIQUE,
 account_id UUID NOT NULL REFERENCES accounts(id),
 amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
 description VARCHAR(120) NOT NULL,
 status VARCHAR(10) NOT NULL CHECK (status IN ('HELD','RELEASED','CAPTURED')),
 capture_id UUID UNIQUE REFERENCES transfers(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((status='CAPTURED') = (capture_id IS NOT NULL))
);
CREATE INDEX active_holds_account_idx ON payment_holds(account_id) WHERE status='HELD';
-- Immutable journal entries stay immutable; hold state is a separate reservation lifecycle.
CREATE FUNCTION apply_hold_projection() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.amount_minor<>OLD.amount_minor OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.description<>OLD.description OR NEW.created_at<>OLD.created_at) THEN
   RAISE EXCEPTION 'Hold reservation fields are immutable';
 END IF;
 IF TG_OP='INSERT' THEN
   UPDATE accounts SET held_minor=held_minor+NEW.amount_minor WHERE id=NEW.account_id;
 ELSIF OLD.status='HELD' AND NEW.status<>'HELD' THEN
   UPDATE accounts SET held_minor=held_minor-OLD.amount_minor WHERE id=OLD.account_id;
 ELSIF OLD.status='RELEASED' AND NEW.status='CAPTURED' THEN NULL;
 ELSE RAISE EXCEPTION 'Invalid hold transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hold_projection AFTER INSERT OR UPDATE ON payment_holds FOR EACH ROW EXECUTE FUNCTION apply_hold_projection();

CREATE TABLE visitor_sessions (
 id UUID PRIMARY KEY,
 token_hash CHAR(64) NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL,
 operation_count INTEGER NOT NULL DEFAULT 0 CHECK (operation_count BETWEEN 0 AND 500),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE visitor_accounts (
 account_id UUID PRIMARY KEY REFERENCES accounts(id),
 session_id UUID NOT NULL REFERENCES visitor_sessions(id)
);
CREATE INDEX visitor_accounts_session_idx ON visitor_accounts(session_id);
CREATE TABLE visitor_session_budget (id INTEGER PRIMARY KEY CHECK(id=1), issued INTEGER NOT NULL DEFAULT 0);
INSERT INTO visitor_session_budget(id) VALUES (1);
