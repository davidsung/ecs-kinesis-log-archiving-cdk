package dev.unicorn.email.Controller;

import dev.unicorn.email.Mail;
import dev.unicorn.email.Service.EmailSenderService;
import dev.unicorn.email.Config.CustomPropertyConfig;
import java.util.HashMap;
import java.util.Map;
import javax.mail.MessagingException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class MailController {
	private Logger logger = LoggerFactory.getLogger(MailController.class);

	private EmailSenderService emailSenderService;
	private CustomPropertyConfig customPropertyConfig;

	@PostMapping(value = "/send")
	public String sendMail() throws MessagingException {
		logger.info("Send email Endpoint");
		Mail mail = getMail();
		emailSenderService.sendEmail(mail);
		return "Check your email";
	}

	private Mail getMail() {
		Mail mail = new Mail();
		mail.setFrom(customPropertyConfig.mailFrom);
		mail.setTo("<toWhomEver@gmail.com>");
		mail.setSubject("Simple mail");
		Map<String, Object> model = new HashMap<>();
		model.put("templateVariable", "Simple mail with aws..");
		mail.setModel(model);
		return mail;
	}
}
