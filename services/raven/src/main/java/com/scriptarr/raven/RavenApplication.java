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
        if ("ingest-worker".equals(System.getenv("SCRIPTARR_RAVEN_ROLE"))) {
            try { com.scriptarr.raven.library.IngestWorkerRuntime.run(System.getenv()); }
            catch (Exception error) { throw new IllegalStateException("Isolated ingest worker stopped.", error); }
            return;
        }
        SpringApplication.run(RavenApplication.class, args);
    }
}
