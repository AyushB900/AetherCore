package dev.aethercore;

import static dev.aethercore.Models.*;
import static org.assertj.core.api.Assertions.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.IntStream;
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.*;
import org.testcontainers.kafka.KafkaContainer;
import org.testcontainers.utility.DockerImageName;

@Testcontainers
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT)
class BankingIntegrationTest {
    static final String KEY="integration-test-service-key-123456789";
    @Container static PostgreSQLContainer<?> postgres=new PostgreSQLContainer<>("postgres:17-alpine");
    @Container static GenericContainer<?> redis=new GenericContainer<>(DockerImageName.parse("redis:7.4-alpine")).withExposedPorts(6379);
    @Container static KafkaContainer kafka=new KafkaContainer("apache/kafka:3.9.1");
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url",postgres::getJdbcUrl);
        r.add("spring.datasource.username",postgres::getUsername);
        r.add("spring.datasource.password",postgres::getPassword);
        r.add("spring.data.redis.host",redis::getHost);
        r.add("spring.data.redis.port",()->redis.getMappedPort(6379));
        r.add("spring.kafka.bootstrap-servers",kafka::getBootstrapServers);
        r.add("app.api-key",()->KEY);
        r.add("app.outbox-delay-ms",()->600000);
    }
    @Autowired LedgerService ledger;
    @Autowired JdbcTemplate db;
    @Autowired TransactionTemplate tx;
    @Autowired OutboxPublisher outbox;
    @Autowired TestRestTemplate http;
    @LocalServerPort int port;

    Account account() { return ledger.create(new CreateAccount("Integration customer","USD")); }
    String key() { return UUID.randomUUID().toString(); }
    void fund(Account a,long amount) { ledger.move(key(),new MoveMoney(LedgerService.CLEARING,a.id(),amount,"USD"),true); }
    MoveMoney move(Account a,Account b,long amount) { return new MoveMoney(a.id(),b.id(),amount,"USD"); }
    long count(String table) { return db.queryForObject("SELECT count(*) FROM "+table,Long.class); }
    void invariant() {
        assertThat(db.queryForObject("SELECT coalesce(sum(balance_minor::numeric),0) FROM accounts",Long.class)).isZero();
        assertThat(db.queryForObject("""
            SELECT count(*) FROM accounts a WHERE a.balance_minor <> (SELECT coalesce(sum(CASE WHEN side='CREDIT' THEN amount_minor::numeric ELSE -amount_minor::numeric END),0) FROM ledger_entries WHERE account_id=a.id)
            """,Long.class)).isZero();
        assertThat(count("ledger_entries")).isEqualTo(2*count("transfers"));
    }
    @Test void postsBalancedJournalAndReplaysOriginalReceipt() {
        var a=account();var b=account();fund(a,10000);String k=key();var request=move(a,b,2500);
        Receipt first=ledger.move(k,request,false);Receipt retry=ledger.move(k,request,false);
        assertThat(first.replayed()).isFalse();assertThat(retry.replayed()).isTrue();
        assertThat(retry.transfer()).isEqualTo(first.transfer());
        assertThat(ledger.account(a.id()).balanceMinor()).isEqualTo(7500);
        assertThat(ledger.account(b.id()).balanceMinor()).isEqualTo(2500);
        assertThat(db.queryForObject("SELECT count(*) FROM outbox_events WHERE transfer_id=?",Long.class,first.transfer().id())).isOne();invariant();
    }
    @Test void rejectsReusingKeyForDifferentPayload() {
        var a=account();var b=account();fund(a,1000);String k=key();ledger.move(k,move(a,b,100),false);
        assertThatThrownBy(()->ledger.move(k,move(a,b,101),false)).isInstanceOfSatisfying(BankingException.class,e->assertThat(e.code).isEqualTo("IDEMPOTENCY_CONFLICT"));invariant();
    }
    @Test void insufficientFundsRollsBackAndSameKeyCanBeRetriedAfterFunding() {
        var a=account();var b=account();String k=key();long before=count("transfers");
        assertThatThrownBy(()->ledger.move(k,move(a,b,100),false)).isInstanceOf(BankingException.class);
        assertThat(count("transfers")).isEqualTo(before);fund(a,100);
        assertThat(ledger.move(k,move(a,b,100),false).replayed()).isFalse();invariant();
    }
    <T> List<T> concurrently(int n,java.util.function.IntFunction<T> job) throws Exception {
        try(var executor=Executors.newFixedThreadPool(16)) {
            CountDownLatch gate=new CountDownLatch(1);
            var jobs=IntStream.range(0,n).mapToObj(i->executor.submit(()->{gate.await();return job.apply(i);})).toList();
            gate.countDown();List<T> results=new ArrayList<>();
            for(var future:jobs) results.add(future.get(45,TimeUnit.SECONDS));return results;
        }
    }
    @Test void thirtyTwoConcurrentNetworkRetriesChargeExactlyOnce() throws Exception {
        var a=account();var b=account();fund(a,1000);String k=key();
        var receipts=concurrently(32,i->ledger.move(k,move(a,b,100),false));
        assertThat(receipts.stream().filter(x->!x.replayed()).count()).isOne();
        assertThat(receipts.stream().map(x->x.transfer().id()).distinct().count()).isOne();
        assertThat(ledger.account(a.id()).balanceMinor()).isEqualTo(900);invariant();
    }
    @Test void fortyConcurrentWithdrawalsCannotOverdraw() throws Exception {
        var a=account();var b=account();fund(a,1000);
        var results=concurrently(40,i->{try {ledger.move(key(),move(a,b,100),false);return true;}
            catch(BankingException e){assertThat(e.code).isEqualTo("INSUFFICIENT_FUNDS");return false;}});
        assertThat(results.stream().filter(Boolean::booleanValue).count()).isEqualTo(10);
        assertThat(ledger.account(a.id()).balanceMinor()).isZero();assertThat(ledger.account(b.id()).balanceMinor()).isEqualTo(1000);invariant();
    }
    @Test void oppositeDirectionTransfersUseConsistentLockOrder() throws Exception {
        var a=account();var b=account();fund(a,10000);fund(b,10000);
        concurrently(40,i->ledger.move(key(),i%2==0?move(a,b,10):move(b,a,10),false));
        assertThat(ledger.account(a.id()).balanceMinor()).isEqualTo(10000);
        assertThat(ledger.account(b.id()).balanceMinor()).isEqualTo(10000);invariant();
    }
    @Test void databaseRejectsMissingJournalEvenForDirectSql() {
        var a=account();var b=account();long before=count("transfers");
        assertThatThrownBy(()->tx.executeWithoutResult(s->db.update("INSERT INTO transfers(id,idempotency_key,fingerprint,source_id,destination_id,currency,amount_minor,operation) VALUES (?,?,?,?,?,'USD',1,'TRANSFER')",UUID.randomUUID(),key(),"0".repeat(64),a.id(),b.id())))
            .isInstanceOf(RuntimeException.class);
        assertThat(count("transfers")).isEqualTo(before);invariant();
    }
    @Test void journalAndTransfersAreImmutable() {
        var a=account();fund(a,100);var id=db.queryForObject("SELECT transfer_id FROM ledger_entries WHERE account_id=? LIMIT 1",UUID.class,a.id());
        assertThatThrownBy(()->db.update("DELETE FROM ledger_entries WHERE transfer_id=?",id)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->db.update("UPDATE transfers SET amount_minor=1 WHERE id=?",id)).isInstanceOf(RuntimeException.class);invariant();
    }
    @Test void outboxFailureRollsBackMoneyJournalAndIdempotency() {
        var a=account();var b=account();fund(a,1000);long before=count("transfers");String k=key();
        db.execute("CREATE FUNCTION test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outbox disk failure'; END $$");
        db.execute("CREATE TRIGGER test_outbox_failure BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION test_fail_outbox()");
        try { assertThatThrownBy(()->ledger.move(k,move(a,b,100),false)).isInstanceOf(RuntimeException.class); }
        finally { db.execute("DROP TRIGGER test_outbox_failure ON outbox_events");db.execute("DROP FUNCTION test_fail_outbox()"); }
        assertThat(count("transfers")).isEqualTo(before);assertThat(ledger.account(a.id()).balanceMinor()).isEqualTo(1000);
        assertThat(ledger.move(k,move(a,b,100),false).replayed()).isFalse();invariant();
    }
    @Test void outboxPublishesRealKafkaEventWithStableEventId() {
        var a=account();fund(a,100);var b=account();Receipt receipt=ledger.move(key(),move(a,b,10),false);
        Properties props=new Properties();props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG,kafka.getBootstrapServers());
        props.put(ConsumerConfig.GROUP_ID_CONFIG,key());props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG,"earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,StringDeserializer.class);
        String expected=db.queryForObject("SELECT id::text FROM outbox_events WHERE transfer_id=?",String.class,receipt.transfer().id());
        outbox.publish();
        assertThat(db.queryForObject("SELECT published_at IS NOT NULL FROM outbox_events WHERE transfer_id=?",Boolean.class,receipt.transfer().id())).isTrue();
        try(var consumer=new KafkaConsumer<String,String>(props)) {
            consumer.subscribe(List.of("aethercore.settlements.v1"));boolean found=false;long end=System.nanoTime()+Duration.ofSeconds(25).toNanos();
            while(!found && System.nanoTime()<end) for(var event:consumer.poll(Duration.ofMillis(500)))
                if(event.key().equals(receipt.transfer().id().toString())) {assertThat(event.value()).contains(expected).contains("TransferPosted");found=true;}
            assertThat(found).as("expected settlement event consumed from Kafka").isTrue();
        }
    }
    HttpHeaders headers() {var h=new HttpHeaders();h.set("X-API-Key",KEY);h.setContentType(MediaType.APPLICATION_JSON);return h;}
    String url(String path) {return "http://localhost:"+port+path;}
    @Test void apiEnforcesAuthenticationValidationAndReplaySemantics() {
        assertThat(http.getForEntity(url("/actuator/health"),String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(http.getForEntity(url("/api/v1/reconciliation"),String.class).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        var invalid=http.postForEntity(url("/api/v1/accounts"),new HttpEntity<>("{\"ownerName\":\"\",\"currency\":\"USD\"}",headers()),String.class);
        assertThat(invalid.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        var a=account();var b=account();fund(a,100);var h=headers();h.set("Idempotency-Key",key());
        var request=new HttpEntity<>(move(a,b,10),h);
        var first=http.postForEntity(url("/api/v1/transfers"),request,Transfer.class);
        var retry=http.postForEntity(url("/api/v1/transfers"),request,Transfer.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.CREATED);assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(retry.getHeaders().getFirst("Idempotency-Replayed")).isEqualTo("true");
        assertThat(retry.getBody()).isEqualTo(first.getBody());
        assertThat(http.postForEntity(url("/api/v1/transfers"),new HttpEntity<>(move(a,b,-1),h),String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }
}
