CREATE OR REPLACE FUNCTION apply_hold_projection() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.amount_minor<>OLD.amount_minor OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.description<>OLD.description OR NEW.created_at<>OLD.created_at) THEN
   RAISE EXCEPTION 'Hold reservation fields are immutable';
 END IF;
 IF TG_OP='INSERT' THEN
   UPDATE accounts SET held_minor=held_minor+NEW.amount_minor WHERE id=NEW.account_id;
 ELSIF OLD.status='HELD' AND NEW.status<>'HELD' THEN
   UPDATE accounts SET held_minor=held_minor-OLD.amount_minor WHERE id=OLD.account_id;
 ELSIF OLD.status='RELEASED' AND NEW.status='CAPTURED' AND OLD.updated_at=transaction_timestamp() THEN NULL;
 ELSE RAISE EXCEPTION 'Invalid hold transition';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER immutable_hold_delete BEFORE DELETE ON payment_holds
FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE transfers ADD CONSTRAINT reversal_link_required CHECK ((operation='REVERSAL')=(reversal_of IS NOT NULL));
CREATE FUNCTION enforce_reversal_link() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE original transfers%ROWTYPE;
BEGIN
 IF NEW.reversal_of IS NOT NULL THEN
  SELECT * INTO original FROM transfers WHERE id=NEW.reversal_of;
  IF original.operation NOT IN ('TRANSFER','CAPTURE') OR original.source_id<>NEW.destination_id OR original.destination_id<>NEW.source_id OR original.amount_minor<>NEW.amount_minor OR original.currency<>NEW.currency THEN
   RAISE EXCEPTION 'Reversal must exactly compensate an original transfer or capture';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER valid_reversal AFTER INSERT ON transfers
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_reversal_link();
