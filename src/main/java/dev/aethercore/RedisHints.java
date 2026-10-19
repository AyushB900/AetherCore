package dev.aethercore;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Component;

/** Advisory only: every request still verifies the durable PostgreSQL idempotency record. */
@Component
public class RedisHints {
    private final StringRedisTemplate redis;
    private final boolean enabled;
    private static final DefaultRedisScript<Long> RELEASE = new DefaultRedisScript<>(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", Long.class);
    public RedisHints(StringRedisTemplate redis, @Value("${app.redis-enabled}") boolean enabled) {
        this.redis = redis; this.enabled = enabled;
    }
    public String acquire(String key) {
        if (!enabled) return null;
        String owner = UUID.randomUUID().toString();
        try { return Boolean.TRUE.equals(redis.opsForValue().setIfAbsent("aether:lock:"+key, owner, Duration.ofSeconds(20))) ? owner : null; }
        catch (RuntimeException ignored) { return null; }
    }
    public UUID cached(String key) {
        if (!enabled) return null;
        try { String id=redis.opsForValue().get("aether:receipt:"+key); return id == null ? null : UUID.fromString(id); }
        catch (RuntimeException ignored) { return null; }
    }
    public void remember(String key, UUID id) {
        if (!enabled) return;
        try { redis.opsForValue().set("aether:receipt:"+key,id.toString(),Duration.ofHours(24)); }
        catch (RuntimeException ignored) { /* Database remains authoritative. */ }
    }
    public void release(String key, String owner) {
        if (!enabled || owner == null) return;
        try { redis.execute(RELEASE,List.of("aether:lock:"+key),owner); }
        catch (RuntimeException ignored) { /* Bounded lease expires on its own. */ }
    }
}
