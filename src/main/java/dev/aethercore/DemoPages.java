package dev.aethercore;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class DemoPages {
  @GetMapping({"/demo", "/demo/"})
  public String workspace() {
    return "forward:/demo/index.html";
  }
}
