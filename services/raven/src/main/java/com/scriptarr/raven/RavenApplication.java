package com.scriptarr.raven;

import com.scriptarr.raven.library.LibraryService;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class RavenApplication {

    public static void main(String[] args) {
        SpringApplication.run(RavenApplication.class, args);
    }

    @Bean
    public LibraryService libraryService() {
        return LibraryService.seedDefault();
    }
}
