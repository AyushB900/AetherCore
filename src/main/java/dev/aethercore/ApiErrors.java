package dev.aethercore;

import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.*;
import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.ServletRequestBindingException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
public class ApiErrors {
  private static final Logger log = LoggerFactory.getLogger(ApiErrors.class);

  @ExceptionHandler(BankingException.class)
  ResponseEntity<ProblemDetail> banking(BankingException e) {
    return problem(e.status, e.code, e.getMessage());
  }

  @ExceptionHandler({
    MethodArgumentNotValidException.class,
    ConstraintViolationException.class,
    HandlerMethodValidationException.class,
    ServletRequestBindingException.class,
    MethodArgumentTypeMismatchException.class,
    HttpMessageNotReadableException.class
  })
  ResponseEntity<ProblemDetail> validation(Exception e) {
    return problem(
        HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Check field types, required values and limits");
  }

  @ExceptionHandler(PessimisticLockingFailureException.class)
  ResponseEntity<ProblemDetail> busy(Exception e) {
    return problem(
        HttpStatus.SERVICE_UNAVAILABLE, "RETRY_TRANSACTION", "Retry with the same Idempotency-Key");
  }

  @ExceptionHandler(DataIntegrityViolationException.class)
  ResponseEntity<ProblemDetail> integrity(DataIntegrityViolationException e) {
    if (e.getMostSpecificCause() instanceof java.sql.SQLException sql
        && "23503".equals(sql.getSQLState()))
      return problem(HttpStatus.NOT_FOUND, "ACCOUNT_NOT_FOUND", "Account not found");
    if (e.getMostSpecificCause() instanceof java.sql.SQLException sql
        && "23514".equals(sql.getSQLState())
        && sql.getMessage().contains("available_nonnegative"))
      return problem(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "INSUFFICIENT_FUNDS",
          "Insufficient available balance for this reservation");
    log.error("Database invariant rejected an operation", e);
    return problem(
        HttpStatus.CONFLICT, "INVARIANT_VIOLATION", "Operation violates a ledger constraint");
  }

  private ResponseEntity<ProblemDetail> problem(HttpStatus status, String code, String detail) {
    ProblemDetail p = ProblemDetail.forStatusAndDetail(status, detail);
    p.setTitle(code);
    p.setProperty("code", code);
    return ResponseEntity.status(status).body(p);
  }
}
