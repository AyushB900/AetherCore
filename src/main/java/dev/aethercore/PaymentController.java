package dev.aethercore;

import static dev.aethercore.Models.*;

import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
public class PaymentController {
  private final PaymentService payments;

  public PaymentController(PaymentService payments) {
    this.payments = payments;
  }

  @PostMapping("/holds")
  Hold reserve(@RequestHeader("Idempotency-Key") String key, @Valid @RequestBody HoldRequest r) {
    return payments.reserve(key, r);
  }

  @GetMapping("/holds/{id}")
  Hold hold(@PathVariable UUID id) {
    return payments.hold(id);
  }

  @PostMapping("/holds/{id}/release")
  Hold release(@PathVariable UUID id) {
    return payments.release(id);
  }

  @PostMapping("/holds/{id}/capture")
  Receipt capture(
      @PathVariable UUID id,
      @RequestHeader("Idempotency-Key") String key,
      @Valid @RequestBody CaptureRequest r) {
    return payments.capture(key, id, r.destinationId());
  }

  @PostMapping("/transfers/{id}/reversal")
  Receipt reverse(@PathVariable UUID id, @RequestHeader("Idempotency-Key") String key) {
    return payments.reverse(key, id);
  }
}
