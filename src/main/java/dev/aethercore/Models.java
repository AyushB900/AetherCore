package dev.aethercore;

import jakarta.validation.constraints.*;
import java.time.OffsetDateTime;
import java.util.UUID;

public final class Models {
  private Models() {}

  public record CreateAccount(
      @NotBlank @Size(max = 120) String ownerName,
      @Pattern(regexp = "USD", message = "only USD is currently supported") @NotNull
          String currency) {}

  public record MoveMoney(
      @NotNull UUID sourceId,
      @NotNull UUID destinationId,
      @Min(1) @Max(1_000_000_000_000L) long amountMinor,
      @NotNull @Pattern(regexp = "USD") String currency) {}

  public record Deposit(
      @NotNull UUID destinationId,
      @Min(1) @Max(1_000_000_000_000L) long amountMinor,
      @NotNull @Pattern(regexp = "USD") String currency) {}

  public record Account(
      UUID id,
      String ownerName,
      String currency,
      String kind,
      long balanceMinor,
      long heldMinor,
      long availableMinor) {}

  public record Transfer(
      UUID id,
      UUID sourceId,
      UUID destinationId,
      long amountMinor,
      String currency,
      String operation,
      OffsetDateTime createdAt,
      UUID reversalOf) {}

  public record HoldRequest(
      @NotNull UUID accountId,
      @Min(1) @Max(1_000_000_000_000L) long amountMinor,
      @NotBlank @Size(max = 120) String description) {}

  public record CaptureRequest(@NotNull UUID destinationId) {}

  public record Hold(
      UUID id,
      UUID accountId,
      long amountMinor,
      String description,
      String status,
      UUID captureId,
      OffsetDateTime createdAt) {}

  public record Receipt(Transfer transfer, boolean replayed) {}
}
