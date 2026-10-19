package dev.aethercore;

import static dev.aethercore.Models.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
@Validated
public class BankingController {
    private final LedgerService ledger;
    private final JdbcTemplate db;
    public BankingController(LedgerService ledger, JdbcTemplate db) { this.ledger=ledger; this.db=db; }
    @PostMapping("/accounts")
    @ResponseStatus(HttpStatus.CREATED)
    Account create(@Valid @RequestBody CreateAccount r) { return ledger.create(r); }
    @GetMapping("/accounts/{id}")
    Account account(@PathVariable UUID id) { return ledger.account(id); }
    @GetMapping("/accounts/{id}/entries")
    List<Map<String,Object>> entries(@PathVariable UUID id, @RequestParam(defaultValue="0") @Min(0) long after,
                                    @RequestParam(defaultValue="50") @Min(1) @Max(200) int limit) {
        return ledger.entries(id,after,limit);
    }
    @PostMapping("/transfers")
    ResponseEntity<Transfer> transfer(@RequestHeader("Idempotency-Key") String key, @Valid @RequestBody MoveMoney r) {
        return response(ledger.move(key,r,false));
    }
    /** Privileged simulated external funding. Does not interact with any real payment rail. */
    @PostMapping("/deposits")
    ResponseEntity<Transfer> deposit(@RequestHeader("Idempotency-Key") String key, @Valid @RequestBody Deposit r) {
        return response(ledger.move(key,new MoveMoney(LedgerService.CLEARING,r.destinationId(),r.amountMinor(),r.currency()),true));
    }
    @GetMapping("/transfers/{id}")
    Transfer transfer(@PathVariable UUID id) { return ledger.transfer(id); }
    @GetMapping("/reconciliation")
    Map<String,Object> reconciliation() {
        // One SQL statement gives a consistent MVCC snapshot even while transfers commit.
        return db.queryForMap("""
            WITH projected AS (
              SELECT a.id,a.balance_minor,coalesce(sum(CASE WHEN e.side='CREDIT' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END),0) AS actual
              FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id
            ), journals AS (
              SELECT t.id,count(e.id) AS n,coalesce(sum(CASE WHEN e.side='CREDIT' THEN e.amount_minor::numeric ELSE -e.amount_minor::numeric END),0) AS net
              FROM transfers t LEFT JOIN ledger_entries e ON e.transfer_id=t.id GROUP BY t.id
            )
            SELECT (SELECT count(*) FROM projected WHERE balance_minor<>actual) AS drifted_accounts,
                   (SELECT count(*) FROM journals WHERE n<>2 OR net<>0) AS unbalanced_transfers,
                   (SELECT coalesce(sum(balance_minor::numeric),0) FROM accounts) AS net_balance_minor,
                   (SELECT count(*) FROM transfers) AS transfer_count,
                   (SELECT count(*) FROM outbox_events WHERE published_at IS NULL) AS pending_events
            """);
    }
    private ResponseEntity<Transfer> response(Receipt r) {
        return ResponseEntity.status(r.replayed()?HttpStatus.OK:HttpStatus.CREATED)
            .header("Idempotency-Replayed",Boolean.toString(r.replayed())).body(r.transfer());
    }
}
