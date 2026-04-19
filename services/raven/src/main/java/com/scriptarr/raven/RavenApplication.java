package com.scriptarr.raven;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Spring Boot entry point for the Scriptarr Raven service.
 */
@SpringBootApplication
public class RavenApplication {

    /**
     * Launch the Raven application.
     *
     * @param args standard Spring Boot command-line arguments
     */
    public static void main(String[] args) {
        SpringApplication.run(RavenApplication.class, args);
    }
}
