CREATE TABLE accounts (
    id UUID PRIMARY KEY,
    owner_name VARCHAR(120) NOT NULL,
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('CUSTOMER', 'CLEARING')),
    balance_minor BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (kind = 'CLEARING' OR balance_minor >= 0)
);
-- Customer balances are liabilities: credits increase them, debits decrease them.
-- Negative clearing is a demo representation of funds received from an external rail.
INSERT INTO accounts(id,owner_name,currency,kind)
VALUES ('00000000-0000-0000-0000-000000000001','External USD clearing','USD','CLEARING');

CREATE TABLE transfers (
    id UUID PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    fingerprint CHAR(64) NOT NULL,
    source_id UUID NOT NULL REFERENCES accounts(id),
    destination_id UUID NOT NULL REFERENCES accounts(id),
    currency CHAR(3) NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
    operation VARCHAR(16) NOT NULL CHECK (operation IN ('TRANSFER','DEPOSIT')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_id <> destination_id)
);

CREATE TABLE ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id UUID NOT NULL REFERENCES transfers(id),
    account_id UUID NOT NULL REFERENCES accounts(id),
    side VARCHAR(6) NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (transfer_id, side)
);
CREATE INDEX ledger_account_idx ON ledger_entries(account_id, id);

CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    transfer_id UUID NOT NULL UNIQUE REFERENCES transfers(id),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);
CREATE INDEX outbox_pending_idx ON outbox_events(created_at) WHERE published_at IS NULL;

CREATE FUNCTION reject_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Journal records are immutable; use compensating transfers';
END $$;
CREATE TRIGGER immutable_entries BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_transfers BEFORE UPDATE OR DELETE ON transfers
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Even direct SQL cannot commit a transfer without its exact debit and credit.
CREATE FUNCTION enforce_balanced_transfer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE t transfers%ROWTYPE; n INTEGER; correct INTEGER;
BEGIN
    SELECT * INTO t FROM transfers WHERE id = NEW.id;
    SELECT count(*), count(*) FILTER (WHERE amount_minor = t.amount_minor AND
        ((side = 'DEBIT' AND account_id = t.source_id) OR
         (side = 'CREDIT' AND account_id = t.destination_id)))
    INTO n, correct FROM ledger_entries WHERE transfer_id = t.id;
    IF n <> 2 OR correct <> 2 THEN
        RAISE EXCEPTION 'Transfer must have exactly one matching debit and credit';
    END IF;
    IF EXISTS (SELECT 1 FROM accounts WHERE id IN (t.source_id,t.destination_id) AND currency <> t.currency) THEN
        RAISE EXCEPTION 'Cross-currency postings require an FX journal';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_transfer AFTER INSERT ON transfers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_balanced_transfer();

-- Projection updates happen inside the journal insertion transaction, never in Java.
CREATE FUNCTION apply_posting() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE t transfers%ROWTYPE;
BEGIN
    SELECT * INTO t FROM transfers WHERE id = NEW.transfer_id;
    IF NEW.amount_minor <> t.amount_minor OR
       (NEW.side = 'DEBIT' AND NEW.account_id <> t.source_id) OR
       (NEW.side = 'CREDIT' AND NEW.account_id <> t.destination_id) THEN
        RAISE EXCEPTION 'Posting does not match transfer';
    END IF;
    UPDATE accounts SET balance_minor = balance_minor +
        CASE WHEN NEW.side = 'CREDIT' THEN NEW.amount_minor ELSE -NEW.amount_minor END
    WHERE id = NEW.account_id;
    RETURN NEW;
END $$;
CREATE TRIGGER apply_ledger_posting AFTER INSERT ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION apply_posting();
