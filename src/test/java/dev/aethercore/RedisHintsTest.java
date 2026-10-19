package dev.aethercore;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;

class RedisHintsTest {
    @Test void unavailableRedisNeverBlocksDurableBankingPath() {
        var redis=mock(StringRedisTemplate.class);when(redis.opsForValue()).thenThrow(new IllegalStateException("Redis unavailable"));
        var hints=new RedisHints(redis,true);
        assertThat(hints.acquire("key")).isNull();assertThat(hints.cached("key")).isNull();
        assertThatCode(()->hints.remember("key",UUID.randomUUID())).doesNotThrowAnyException();
        assertThatCode(()->hints.release("key","owner")).doesNotThrowAnyException();
    }
}
