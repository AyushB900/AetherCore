package dev.aethercore;

import org.springframework.http.HttpStatus;

public class BankingException extends RuntimeException {
    final HttpStatus status;
    final String code;
    public BankingException(HttpStatus status, String code, String message) {
        super(message); this.status = status; this.code = code;
    }
}
