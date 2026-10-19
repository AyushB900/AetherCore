package dev.aethercore;

import static dev.aethercore.Models.*;
import static org.springframework.http.HttpStatus.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class LedgerService {
  public static final UUID CLEARING = UUID.fromString("00000000-0000-0000-0000-000000000001");
  private final JdbcTemplate db;
  private final TransactionTemplate tx;
  private final RedisHints hints;
  static final RowMapper<Account> ACCOUNT =
      (r, n) ->
          new Account(
              r.getObject("id", UUID.class),
              r.getString("owner_name"),
              r.getString("currency"),
              r.getString("kind"),
              r.getLong("balance_minor"),
              r.getLong("held_minor"),
              r.getLong("balance_minor") - r.getLong("held_minor"));
  static final RowMapper<Transfer> TRANSFER =
      (r, n) ->
          new Transfer(
              r.getObject("id", UUID.class),
              r.getObject("source_id", UUID.class),
              r.getObject("destination_id", UUID.class),
              r.getLong("amount_minor"),
              r.getString("currency"),
              r.getString("operation"),
              r.getObject("created_at", java.time.OffsetDateTime.class),
              r.getObject("reversal_of", UUID.class));

  public LedgerService(JdbcTemplate db, TransactionTemplate tx, RedisHints hints) {
    this.db = db;
    this.tx = tx;
    this.hints = hints;
  }

  public Account create(CreateAccount request) {
    UUID id = UUID.randomUUID();
    db.update(
        "INSERT INTO accounts(id,owner_name,currency,kind) VALUES (?,?,?,'CUSTOMER')",
        id,
        request.ownerName(),
        request.currency());
    return account(id);
  }

  public Account account(UUID id) {
    return db.query("SELECT * FROM accounts WHERE id=?", ACCOUNT, id).stream()
        .findFirst()
        .orElseThrow(
            () -> new BankingException(NOT_FOUND, "ACCOUNT_NOT_FOUND", "Account not found"));
  }

  public Transfer transfer(UUID id) {
    return db.query("SELECT * FROM transfers WHERE id=?", TRANSFER, id).stream()
        .findFirst()
        .orElseThrow(
            () -> new BankingException(NOT_FOUND, "TRANSFER_NOT_FOUND", "Transfer not found"));
  }

  public List<Map<String, Object>> entries(UUID id, long after, int limit) {
    account(id);
    return db.queryForList(
        "SELECT id,transfer_id,side,amount_minor,created_at FROM ledger_entries WHERE account_id=?"
            + " AND id>? ORDER BY id LIMIT ?",
        id,
        after,
        limit);
  }

  public Receipt move(String key, MoveMoney request, boolean deposit) {
    return postOperation(key, request, deposit ? "DEPOSIT" : "TRANSFER", null);
  }

  Receipt postOperation(String key, MoveMoney request, String operation, UUID reversalOf) {
    if (request.amountMinor() < 1
        || request.amountMinor() > 1_000_000_000_000L
        || !"USD".equals(request.currency()))
      throw new BankingException(
          BAD_REQUEST, "INVALID_REQUEST", "Amount and USD currency are required");
    if (key == null || !key.matches("[A-Za-z0-9._:-]{1,128}"))
      throw new BankingException(
          BAD_REQUEST,
          "INVALID_IDEMPOTENCY_KEY",
          "Use 1-128 ASCII letters, digits, dot, underscore, colon or dash");
    if (request.sourceId().equals(request.destinationId()))
      throw new BankingException(
          UNPROCESSABLE_ENTITY, "SAME_ACCOUNT", "Source and destination must differ");
    String fingerprint =
        hash(
            operation
                + "|"
                + request.sourceId()
                + "|"
                + request.destinationId()
                + "|"
                + request.amountMinor()
                + "|"
                + request.currency()
                + (reversalOf == null ? "" : "|" + reversalOf));
    String digest = hash(key);
    String lease = hints.acquire(digest);
    try {
      Receipt receipt =
          Objects.requireNonNull(
              tx.execute(
                  status ->
                      execute(
                          key, request, operation, reversalOf, fingerprint, hints.cached(digest))));
      if (org.springframework.transaction.support.TransactionSynchronizationManager
          .isActualTransactionActive()) {
        org.springframework.transaction.support.TransactionSynchronizationManager
            .registerSynchronization(
                new org.springframework.transaction.support.TransactionSynchronization() {
                  @Override
                  public void afterCommit() {
                    hints.remember(digest, receipt.transfer().id());
                  }
                });
      } else hints.remember(digest, receipt.transfer().id());
      return receipt;
    } finally {
      hints.release(digest, lease);
    }
  }

  private Receipt execute(
      String key, MoveMoney r, String operation, UUID reversalOf, String fingerprint, UUID cached) {
    boolean deposit = operation.equals("DEPOSIT");
    // A poisoned/stale Redis hint cannot alter the durable key-to-request mapping.
    if (cached != null) {
      var rows =
          db.queryForList(
              "SELECT fingerprint FROM transfers WHERE id=? AND idempotency_key=?", cached, key);
      if (!rows.isEmpty())
        return replay(cached, rows.getFirst().get("fingerprint").toString(), fingerprint);
    }
    UUID id = UUID.randomUUID();
    int inserted =
        db.update(
            """
            INSERT INTO transfers(id,idempotency_key,fingerprint,source_id,destination_id,currency,amount_minor,operation,reversal_of)
            VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (idempotency_key) DO NOTHING
            """,
            id,
            key,
            fingerprint,
            r.sourceId(),
            r.destinationId(),
            r.currency(),
            r.amountMinor(),
            operation,
            reversalOf);
    // PostgreSQL's unique-index conflict waits for an in-flight competing transaction.
    if (inserted == 0) {
      var row = db.queryForMap("SELECT id,fingerprint FROM transfers WHERE idempotency_key=?", key);
      return replay((UUID) row.get("id"), row.get("fingerprint").toString(), fingerprint);
    }
    // All money paths lock both accounts in UUID order to prevent lock-order deadlocks.
    List<Account> locked =
        db.query(
            "SELECT * FROM accounts WHERE id IN (?,?) ORDER BY id FOR NO KEY UPDATE",
            ACCOUNT,
            r.sourceId(),
            r.destinationId());
    if (locked.size() != 2)
      throw new BankingException(NOT_FOUND, "ACCOUNT_NOT_FOUND", "Account not found");
    Account source =
        locked.stream().filter(a -> a.id().equals(r.sourceId())).findFirst().orElseThrow();
    Account destination =
        locked.stream().filter(a -> a.id().equals(r.destinationId())).findFirst().orElseThrow();
    if ((!deposit && !source.kind().equals("CUSTOMER"))
        || !destination.kind().equals("CUSTOMER")
        || (deposit && !source.kind().equals("CLEARING")))
      throw new BankingException(
          UNPROCESSABLE_ENTITY,
          "INVALID_ACCOUNT_KIND",
          "Operation not allowed for this account type");
    if (!source.currency().equals(r.currency()) || !destination.currency().equals(r.currency()))
      throw new BankingException(
          UNPROCESSABLE_ENTITY, "CURRENCY_MISMATCH", "Cross-currency transfers are unsupported");
    if (!deposit && source.availableMinor() < r.amountMinor())
      throw new BankingException(
          UNPROCESSABLE_ENTITY, "INSUFFICIENT_FUNDS", "Insufficient available balance");
    if (destination.balanceMinor() > Long.MAX_VALUE - r.amountMinor()
        || (deposit && source.balanceMinor() < Long.MIN_VALUE + r.amountMinor()))
      throw new BankingException(
          UNPROCESSABLE_ENTITY, "BALANCE_LIMIT", "Account balance limit exceeded");
    db.update(
        "INSERT INTO ledger_entries(transfer_id,account_id,side,amount_minor) VALUES"
            + " (?,?,'DEBIT',?),(?,?,'CREDIT',?)",
        id,
        r.sourceId(),
        r.amountMinor(),
        id,
        r.destinationId(),
        r.amountMinor());
    UUID event = UUID.randomUUID();
    db.update(
        """
        INSERT INTO outbox_events(id,transfer_id,payload)
        SELECT ?,id,jsonb_build_object('eventId',?::text,'type','TransferPosted','schemaVersion',1,
            'transferId',id,'sourceId',source_id,'destinationId',destination_id,
            'amountMinor',amount_minor,'currency',currency,'operation',operation,'reversalOf',reversal_of,'occurredAt',created_at)
        FROM transfers WHERE id=?
        """,
        event,
        event.toString(),
        id);
    return new Receipt(transfer(id), false);
  }

  private Receipt replay(UUID id, String existing, String fingerprint) {
    if (!existing.equals(fingerprint))
      throw new BankingException(
          CONFLICT, "IDEMPOTENCY_CONFLICT", "This key was already used for a different request");
    return new Receipt(transfer(id), true);
  }

  private static String hash(String value) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
