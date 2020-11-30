package dev.unicorn.email.Config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.PropertySource;
import org.springframework.stereotype.Component;

@Component
public class CustomPropertyConfig {

  @Value("${mail.from}")
  public String mailFrom;
}
