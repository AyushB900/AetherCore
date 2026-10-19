package dev.aethercore;

import java.util.concurrent.TimeUnit;
import org.slf4j.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@ConditionalOnProperty(name="app.outbox-enabled",havingValue="true",matchIfMissing=true)
public class OutboxPublisher {
    private static final Logger log=LoggerFactory.getLogger(OutboxPublisher.class);
    private final JdbcTemplate db;
    private final TransactionTemplate tx;
    private final KafkaTemplate<String,String> kafka;
    private final String topic;
    public OutboxPublisher(JdbcTemplate db,TransactionTemplate tx,KafkaTemplate<String,String> kafka,@Value("${app.settlement-topic}") String topic) {
        this.db=db;this.tx=tx;this.kafka=kafka;this.topic=topic;
    }
    @Scheduled(fixedDelayString="${app.outbox-delay-ms}")
    public void publish() {
        try {
            tx.executeWithoutResult(status -> {
                var events=db.queryForList("SELECT id,transfer_id,payload::text AS payload FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED");
                for(var event:events) {
                    try {
                        kafka.send(topic,event.get("transfer_id").toString(),event.get("payload").toString()).get(12,TimeUnit.SECONDS);
                        db.update("UPDATE outbox_events SET published_at=now() WHERE id=?",event.get("id"));
                    } catch(InterruptedException e) {
                        Thread.currentThread().interrupt(); throw new IllegalStateException("Publisher interrupted",e);
                    } catch(Exception e) { throw new IllegalStateException("Kafka acknowledgement unavailable",e); }
                }
            });
        } catch(RuntimeException e) { log.warn("Outbox batch retained for retry: {}",e.getMessage()); }
    }
}
