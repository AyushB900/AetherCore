package dev.aethercore;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
public class DemoRuntimeConfig {
  @Value("${app.demo-enabled:false}")
  boolean enabled;

  @GetMapping(value = "/demo/runtime-config.js", produces = "application/javascript")
  ResponseEntity<String> config() {
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body("window.AETHERCORE_BACKEND = " + (enabled ? "\"same-origin\"" : "\"\"") + ";");
  }
}
