package dev.aethercore;

import static dev.aethercore.Models.*;
import static org.springframework.http.HttpStatus.*;

import java.util.*;
import org.springframework.jdbc.core.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class PaymentService {
  private final JdbcTemplate db;
  private final TransactionTemplate tx;
  private final LedgerService ledger;
  static final RowMapper<Hold> HOLD =
      (r, n) ->
          new Hold(
              r.getObject("id", UUID.class),
              r.getObject("account_id", UUID.class),
              r.getLong("amount_minor"),
              r.getString("description"),
              r.getString("status"),
              r.getObject("capture_id", UUID.class),
              r.getObject("created_at", java.time.OffsetDateTime.class));

  public PaymentService(JdbcTemplate db, TransactionTemplate tx, LedgerService ledger) {
    this.db = db;
    this.tx = tx;
    this.ledger = ledger;
  }

  static void key(String key) {
    if (key == null || !key.matches("[A-Za-z0-9._:-]{1,128}"))
      throw new BankingException(BAD_REQUEST, "INVALID_IDEMPOTENCY_KEY", "Use a valid request key");
  }

  public Hold hold(UUID id) {
    return db.query("SELECT * FROM payment_holds WHERE id=?", HOLD, id).stream()
        .findFirst()
        .orElseThrow(() -> new BankingException(NOT_FOUND, "HOLD_NOT_FOUND", "Hold not found"));
  }

  public Hold reserve(String key, HoldRequest request) {
    key(key);
    return tx.execute(
        s -> {
          UUID id = UUID.randomUUID();
          int inserted =
              db.update(
                  "INSERT INTO"
                      + " payment_holds(id,idempotency_key,account_id,amount_minor,description,status)"
                      + " VALUES (?,?,?,?,?,'HELD') ON CONFLICT(idempotency_key) DO NOTHING",
                  id,
                  key,
                  request.accountId(),
                  request.amountMinor(),
                  request.description());
          if (inserted == 0) {
            Hold existing =
                db.queryForObject("SELECT * FROM payment_holds WHERE idempotency_key=?", HOLD, key);
            if (!existing.accountId().equals(request.accountId())
                || existing.amountMinor() != request.amountMinor()
                || !existing.description().equals(request.description()))
              throw new BankingException(
                  CONFLICT, "IDEMPOTENCY_CONFLICT", "Key belongs to a different hold");
            return existing;
          }
          // Inserting the hold updates held_minor through the trigger, obtaining a row write lock.
          // The database CHECK prevents reservations exceeding balance even under concurrent
          // inserts.
          if (!ledger.account(request.accountId()).kind().equals("CUSTOMER"))
            throw new BankingException(
                UNPROCESSABLE_ENTITY, "INVALID_ACCOUNT_KIND", "Only customer funds may be held");
          return hold(id);
        });
  }

  private Hold locked(UUID id) {
    return db.query("SELECT * FROM payment_holds WHERE id=? FOR UPDATE", HOLD, id).stream()
        .findFirst()
        .orElseThrow(() -> new BankingException(NOT_FOUND, "HOLD_NOT_FOUND", "Hold not found"));
  }

  public Hold release(UUID id) {
    return tx.execute(
        s -> {
          Hold hold = locked(id);
          if (hold.status().equals("CAPTURED"))
            throw new BankingException(
                CONFLICT, "HOLD_CAPTURED", "A captured hold cannot be released");
          if (hold.status().equals("HELD"))
            db.update("UPDATE payment_holds SET status='RELEASED',updated_at=now() WHERE id=?", id);
          return hold(id);
        });
  }

  public Receipt capture(String key, UUID id, UUID destination) {
    key(key);
    return tx.execute(
        s -> {
          Hold hold = locked(id);
          if (hold.status().equals("RELEASED"))
            throw new BankingException(CONFLICT, "HOLD_RELEASED", "This hold was released");
          if (hold.status().equals("CAPTURED")) {
            var existing =
                db.queryForMap(
                    "SELECT idempotency_key,destination_id FROM transfers WHERE id=?",
                    hold.captureId());
            if (!existing.get("idempotency_key").equals(key)
                || !existing.get("destination_id").equals(destination))
              throw new BankingException(
                  CONFLICT, "HOLD_CAPTURED", "This hold was already captured");
            return new Receipt(ledger.transfer(hold.captureId()), true);
          }
          // Lock all money rows in the same order as regular transfers before releasing the
          // reservation.
          db.query(
              "SELECT * FROM accounts WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",
              LedgerService.ACCOUNT,
              hold.accountId(),
              destination);
          // Mark released inside this transaction so the projection trigger frees the held funds.
          db.update("UPDATE payment_holds SET status='RELEASED',updated_at=now() WHERE id=?", id);
          Receipt receipt =
              ledger.postOperation(
                  key,
                  new MoveMoney(hold.accountId(), destination, hold.amountMinor(), "USD"),
                  "CAPTURE",
                  null);
          // A released-to-captured transition does not alter held funds a second time.
          db.update(
              "UPDATE payment_holds SET status='CAPTURED',capture_id=?,updated_at=now() WHERE id=?",
              receipt.transfer().id(),
              id);
          return receipt;
        });
  }

  public Receipt reverse(String key, UUID original) {
    key(key);
    return tx.execute(
        s -> {
          Transfer transfer =
              db
                  .query(
                      "SELECT * FROM transfers WHERE id=? FOR UPDATE",
                      LedgerService.TRANSFER,
                      original)
                  .stream()
                  .findFirst()
                  .orElseThrow(
                      () ->
                          new BankingException(
                              NOT_FOUND, "TRANSFER_NOT_FOUND", "Transfer not found"));
          if (!Set.of("TRANSFER", "CAPTURE").contains(transfer.operation()))
            throw new BankingException(
                UNPROCESSABLE_ENTITY,
                "NOT_REVERSIBLE",
                "Only transfers and captures can be reversed");
          var existing =
              db.queryForList(
                  "SELECT id,idempotency_key FROM transfers WHERE reversal_of=?", original);
          if (!existing.isEmpty()) {
            if (!existing.getFirst().get("idempotency_key").equals(key))
              throw new BankingException(
                  CONFLICT, "ALREADY_REVERSED", "This transfer already has a reversal");
            return new Receipt(ledger.transfer((UUID) existing.getFirst().get("id")), true);
          }
          return ledger.postOperation(
              key,
              new MoveMoney(
                  transfer.destinationId(),
                  transfer.sourceId(),
                  transfer.amountMinor(),
                  transfer.currency()),
              "REVERSAL",
              original);
        });
  }
}
