package dev.aethercore;

import static dev.aethercore.Models.*;

import jakarta.validation.Valid;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/demo-api")
public class VisitorController {
  private final VisitorService visitors;

  public VisitorController(VisitorService visitors) {
    this.visitors = visitors;
  }

  @PostMapping("/sessions")
  Map<String, Object> start() {
    return visitors.start();
  }

  @GetMapping("/workspace")
  Map<String, Object> snapshot(
      @RequestHeader(value = "X-Demo-Token", required = false) String token) {
    return visitors.snapshot(token);
  }

  @PostMapping("/accounts")
  Account create(
      @RequestHeader(value = "X-Demo-Token", required = false) String token,
      @Valid @RequestBody CreateAccount r) {
    return visitors.create(token, r);
  }

  @PostMapping("/transfers")
  Receipt transfer(
      @RequestHeader(value = "X-Demo-Token", required = false) String token,
      @RequestHeader("Idempotency-Key") String key,
      @Valid @RequestBody MoveMoney r) {
    return visitors.move(token, key, r);
  }

  @PostMapping("/deposits")
  Receipt deposit(
      @RequestHeader(value = "X-Demo-Token", required = false) String token,
      @RequestHeader("Idempotency-Key") String key,
      @Valid @RequestBody Deposit r) {
    return visitors.deposit(token, key, r);
  }

  @PostMapping("/holds")
  Hold reserve(
      @RequestHeader(value = "X-Demo-Token", required = false) String token,
      @RequestHeader("Idempotency-Key") String key,
      @Valid @RequestBody HoldRequest r) {
    return visitors.reserve(token, key, r);
  }

  @PostMapping("/holds/{id}/release")
  Hold release(
      @RequestHeader(value = "X-Demo-Token", required = false) String token,
      @PathVariable UUID id) {
    return visitors.release(token, id);
  }

  @PostMapping("/holds/{id}/capture")
  Receipt capture(
      @RequestHeader(value = "X-Demo-Token", required = false) String token,
      @RequestHeader("Idempotency-Key") String key,
      @PathVariable UUID id,
      @Valid @RequestBody CaptureRequest r) {
    return visitors.capture(token, key, id, r.destinationId());
  }

  @PostMapping("/transfers/{id}/reversal")
  Receipt reverse(
      @RequestHeader(value = "X-Demo-Token", required = false) String token,
      @RequestHeader("Idempotency-Key") String key,
      @PathVariable UUID id) {
    return visitors.reverse(token, key, id);
  }
}
