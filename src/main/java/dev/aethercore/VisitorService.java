package dev.aethercore;

import static dev.aethercore.Models.*;
import static org.springframework.http.HttpStatus.*;

import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.*;
import java.util.*;
import java.util.function.Function;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * All visitor operations lock their session row, verify ownership and enforce bounded resources.
 */
@Service
public class VisitorService {
  private final JdbcTemplate db;
  private final TransactionTemplate tx;
  private final LedgerService ledger;
  private final PaymentService payments;
  private final boolean enabled;
  private final int maxSessions;

  public VisitorService(
      JdbcTemplate db,
      TransactionTemplate tx,
      LedgerService ledger,
      PaymentService payments,
      @Value("${app.demo-enabled:false}") boolean enabled,
      @Value("${app.demo-max-sessions:1000}") int maxSessions) {
    this.db = db;
    this.tx = tx;
    this.ledger = ledger;
    this.payments = payments;
    this.enabled = enabled;
    this.maxSessions = maxSessions;
  }

  void enabled() {
    if (!enabled)
      throw new BankingException(NOT_FOUND, "DEMO_DISABLED", "Public demo sessions are disabled");
  }

  public Map<String, Object> start() {
    enabled();
    return tx.execute(
        s -> {
          // Global allocation is database-serialized across instances. No unbounded unauthenticated
          // data creation.
          int allocated =
              db.update(
                  "UPDATE visitor_session_budget SET issued=issued+1 WHERE id=1 AND issued<?",
                  maxSessions);
          if (allocated == 0)
            throw new BankingException(
                TOO_MANY_REQUESTS,
                "DEMO_CAPACITY",
                "The demo session budget is exhausted; contact the operator");
          byte[] bytes = new byte[32];
          new SecureRandom().nextBytes(bytes);
          String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
          UUID id = UUID.randomUUID();
          OffsetDateTime expires = OffsetDateTime.now(ZoneOffset.UTC).plusHours(24);
          db.update(
              "INSERT INTO visitor_sessions(id,token_hash,expires_at) VALUES (?,?,?)",
              id,
              hash(token),
              expires);
          UUID clearing = UUID.randomUUID();
          db.update(
              "INSERT INTO accounts(id,owner_name,currency,kind) VALUES (?,'External"
                  + " clearing','USD','CLEARING')",
              clearing);
          bind(id, clearing);
          String[] names = {"Operating account", "Reserve account", "Payroll account"};
          long[] balances = {1250000, 800000, 450000};
          for (int i = 0; i < 3; i++) {
            Account account = ledger.create(new CreateAccount(names[i], "USD"));
            bind(id, account.id());
            ledger.postOperation(
                id + ":seed:" + i,
                new MoveMoney(clearing, account.id(), balances[i], "USD"),
                "DEPOSIT",
                null);
          }
          return Map.of("token", token, "expiresAt", expires, "sessionId", id);
        });
  }

  private void bind(UUID session, UUID account) {
    db.update("INSERT INTO visitor_accounts(account_id,session_id) VALUES (?,?)", account, session);
  }

  <T> T session(String token, boolean write, Function<UUID, T> action) {
    enabled();
    if (token == null || !token.matches("[A-Za-z0-9_-]{43}"))
      throw new BankingException(UNAUTHORIZED, "SESSION_REQUIRED", "Start a demo session first");
    return tx.execute(
        s -> {
          var rows =
              db.queryForList(
                  "SELECT id,operation_count FROM visitor_sessions WHERE token_hash=? AND"
                      + " expires_at>now() FOR UPDATE",
                  hash(token));
          if (rows.isEmpty())
            throw new BankingException(
                UNAUTHORIZED, "SESSION_EXPIRED", "This demo session is missing or expired");
          UUID id = (UUID) rows.getFirst().get("id");
          if (write) {
            int count = ((Number) rows.getFirst().get("operation_count")).intValue();
            if (count >= 500)
              throw new BankingException(
                  TOO_MANY_REQUESTS, "SESSION_LIMIT", "This session reached 500 operations");
            db.update(
                "UPDATE visitor_sessions SET operation_count=operation_count+1 WHERE id=?", id);
          }
          return action.apply(id);
        });
  }

  private void owns(UUID session, UUID account) {
    if (!Boolean.TRUE.equals(
        db.queryForObject(
            "SELECT EXISTS(SELECT 1 FROM visitor_accounts WHERE session_id=? AND account_id=?)",
            Boolean.class,
            session,
            account)))
      throw new BankingException(
          NOT_FOUND, "ACCOUNT_NOT_FOUND", "Account not found in this workspace");
  }

  private String key(UUID session, String key) {
    PaymentService.key(key);
    if (key.length() > 80)
      throw new BankingException(
          BAD_REQUEST, "INVALID_IDEMPOTENCY_KEY", "Visitor keys must be at most 80 characters");
    return session + ":" + key;
  }

  public Account create(String token, CreateAccount r) {
    return session(
        token,
        true,
        id -> {
          int count =
              db.queryForObject(
                  "SELECT count(*) FROM visitor_accounts WHERE session_id=?", Integer.class, id);
          if (count >= 21)
            throw new BankingException(
                TOO_MANY_REQUESTS, "ACCOUNT_LIMIT", "This workspace supports 20 customer accounts");
          Account account = ledger.create(r);
          bind(id, account.id());
          return account;
        });
  }

  public Receipt move(String token, String key, MoveMoney r) {
    return session(
        token,
        true,
        id -> {
          owns(id, r.sourceId());
          owns(id, r.destinationId());
          limit(r.amountMinor());
          return ledger.move(key(id, key), r, false);
        });
  }

  public Receipt deposit(String token, String key, Deposit r) {
    return session(
        token,
        true,
        id -> {
          owns(id, r.destinationId());
          limit(r.amountMinor());
          UUID clearing =
              db.queryForObject(
                  "SELECT a.id FROM accounts a JOIN visitor_accounts v ON a.id=v.account_id WHERE"
                      + " v.session_id=? AND a.kind='CLEARING'",
                  UUID.class,
                  id);
          return ledger.postOperation(
              key(id, key),
              new MoveMoney(clearing, r.destinationId(), r.amountMinor(), r.currency()),
              "DEPOSIT",
              null);
        });
  }

  public Hold reserve(String token, String key, HoldRequest r) {
    return session(
        token,
        true,
        id -> {
          owns(id, r.accountId());
          limit(r.amountMinor());
          return payments.reserve(key(id, key), r);
        });
  }

  public Hold release(String token, UUID hold) {
    return session(
        token,
        true,
        id -> {
          owns(id, payments.hold(hold).accountId());
          return payments.release(hold);
        });
  }

  public Receipt capture(String token, String key, UUID hold, UUID destination) {
    return session(
        token,
        true,
        id -> {
          owns(id, payments.hold(hold).accountId());
          owns(id, destination);
          return payments.capture(key(id, key), hold, destination);
        });
  }

  public Receipt reverse(String token, String key, UUID transfer) {
    return session(
        token,
        true,
        id -> {
          Transfer t = ledger.transfer(transfer);
          owns(id, t.sourceId());
          owns(id, t.destinationId());
          return payments.reverse(key(id, key), transfer);
        });
  }

  private void limit(long amount) {
    if (amount > 100000000)
      throw new BankingException(
          UNPROCESSABLE_ENTITY, "DEMO_AMOUNT_LIMIT", "Demo movements are limited to $1,000,000");
  }

  public Map<String, Object> snapshot(String token) {
    return session(
        token,
        false,
        id -> {
          var accounts =
              db.query(
                  "SELECT a.* FROM accounts a JOIN visitor_accounts v ON a.id=v.account_id WHERE"
                      + " v.session_id=? ORDER BY a.created_at,a.id",
                  LedgerService.ACCOUNT,
                  id);
          var transfers =
              db.query(
                  "SELECT t.* FROM transfers t JOIN visitor_accounts v ON t.source_id=v.account_id"
                      + " WHERE v.session_id=? ORDER BY t.created_at,t.id",
                  LedgerService.TRANSFER,
                  id);
          var entries =
              db.queryForList(
                  "SELECT e.id,e.transfer_id AS \"transferId\",e.account_id AS"
                      + " \"accountId\",e.side,e.amount_minor AS \"amountMinor\",e.created_at AS"
                      + " \"createdAt\" FROM ledger_entries e JOIN visitor_accounts v ON"
                      + " v.account_id=e.account_id WHERE v.session_id=? ORDER BY e.id",
                  id);
          var holds =
              db.query(
                  "SELECT h.* FROM payment_holds h JOIN visitor_accounts v ON"
                      + " h.account_id=v.account_id WHERE v.session_id=? ORDER BY h.created_at",
                  PaymentService.HOLD,
                  id);
          var events =
              db.queryForList(
                  "SELECT o.id,o.transfer_id AS \"transferId\",o.created_at AS"
                      + " \"createdAt\",o.published_at AS \"publishedAt\" FROM outbox_events o JOIN"
                      + " transfers t ON t.id=o.transfer_id JOIN visitor_accounts v ON"
                      + " v.account_id=t.source_id WHERE v.session_id=? ORDER BY o.created_at",
                  id);
          // Replay keys are returned only to their authenticated owner and never include the
          // service key.
          var keys =
              db.queryForList(
                  "SELECT id,idempotency_key FROM transfers WHERE source_id IN (SELECT account_id"
                      + " FROM visitor_accounts WHERE session_id=?)",
                  id);
          Map<String, Object> keyMap = new LinkedHashMap<>();
          for (var row : keys) {
            String k = row.get("idempotency_key").toString();
            keyMap.put(k.substring(id.toString().length() + 1), Map.of("id", row.get("id")));
          }
          return Map.of(
              "accounts",
              accounts,
              "transfers",
              transfers,
              "entries",
              entries,
              "holds",
              holds,
              "events",
              events,
              "keys",
              keyMap,
              "engine",
              "java-postgresql");
        });
  }

  static String hash(String token) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }
}
