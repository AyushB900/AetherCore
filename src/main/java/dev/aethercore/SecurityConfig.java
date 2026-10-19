package dev.aethercore;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.filter.OncePerRequestFilter;

@Configuration
public class SecurityConfig {
    @Bean
    SecurityFilterChain security(HttpSecurity http, @Value("${app.api-key}") String key) throws Exception {
        if(key.isBlank() || key.length()<24) throw new IllegalArgumentException("AETHER_API_KEY must contain at least 24 characters");
        var filter=new OncePerRequestFilter() {
            @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain) throws ServletException,IOException {
                String candidate=request.getHeader("X-API-Key");
                if(candidate!=null && MessageDigest.isEqual(key.getBytes(StandardCharsets.UTF_8),candidate.getBytes(StandardCharsets.UTF_8)))
                    SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken("banking-service",null,List.of(new SimpleGrantedAuthority("ROLE_SERVICE"))));
                chain.doFilter(request,response);
            }
        };
        return http.csrf(c->c.disable()).sessionManagement(s->s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(a->a.requestMatchers("/actuator/health").permitAll().anyRequest().authenticated())
            .exceptionHandling(e->e.authenticationEntryPoint((req,res,ex)->res.sendError(401)))
            .addFilterBefore(filter,UsernamePasswordAuthenticationFilter.class).build();
    }
}
