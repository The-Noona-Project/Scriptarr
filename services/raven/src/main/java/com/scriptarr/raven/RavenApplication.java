package com.scriptarr.raven;

import com.scriptarr.raven.library.LibraryService;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

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

    /**
     * Create the shared in-memory library projection.
     *
     * @return the shared library projection service
     */
    @Bean
    public LibraryService libraryService() {
        return LibraryService.empty();
    }
}
