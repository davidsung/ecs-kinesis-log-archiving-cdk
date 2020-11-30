package dev.unicorn.email.Controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthzController {
	Logger logger = LoggerFactory.getLogger(HealthzController.class);

	@RequestMapping(value = "/healthz", method = RequestMethod.GET)
	public ResponseEntity healthz() {
		logger.info("Health Check Endpoint");
		return new ResponseEntity(HttpStatus.OK);
	}
}
