package com.scriptarr.raven.support;

import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.stereotype.Service;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;

@Service
public class ScriptarrLogger implements InitializingBean {
    private static final String LATEST_LOG = "latest.log";
    private static final int MAX_LOGS = 5;
    private static final DateTimeFormatter FILE_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd_HH-mm-ss");
    private static final DateTimeFormatter LINE_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final List<String> recentErrors = new CopyOnWriteArrayList<>();
    private Path downloadsRoot;
    private Path logsRoot;
    private BufferedWriter writer;
    private boolean debugEnabled;

    @Override
    public void afterPropertiesSet() throws Exception {
        debugEnabled = parseDebug(System.getenv("DEBUG"));
        downloadsRoot = resolveDownloadsRoot();
        logsRoot = resolveLogsRoot(downloadsRoot);
        Files.createDirectories(downloadsRoot);
        Files.createDirectories(logsRoot);
        rotateLogs();
        writer = Files.newBufferedWriter(
            logsRoot.resolve(LATEST_LOG),
            StandardOpenOption.CREATE,
            StandardOpenOption.APPEND
        );
        info("LOGGER", "Scriptarr Raven logger ready.", "downloadsRoot=" + downloadsRoot.toAbsolutePath());
    }

    public Path getDownloadsRoot() {
        return downloadsRoot;
    }

    public Path getLogsRoot() {
        return logsRoot;
    }

    public List<String> recentErrors() {
        return List.copyOf(recentErrors);
    }

    public void info(String tag, String message) {
        write("INFO", tag, message, null);
    }

    public void info(String tag, String message, String detail) {
        write("INFO", tag, message, detail);
    }

    public void warn(String tag, String message) {
        write("WARN", tag, message, null);
    }

    public void warn(String tag, String message, String detail) {
        write("WARN", tag, message, detail);
    }

    public void debug(String tag, String message) {
        if (!debugEnabled) {
            return;
        }
        write("DEBUG", tag, message, null);
    }

    public void error(String tag, String message, Throwable error) {
        String detail = error != null ? sanitize(error.getMessage()) : "";
        if (!detail.isBlank()) {
            recentErrors.add(detail);
            while (recentErrors.size() > 25) {
                recentErrors.remove(0);
            }
        }
        write("ERROR", tag, message, detail);
    }

    @PreDestroy
    public void close() throws IOException {
        if (writer != null) {
            writer.close();
        }
    }

    private synchronized void write(String level, String tag, String message, String detail) {
        StringBuilder line = new StringBuilder()
            .append(LocalDateTime.now().format(LINE_FORMAT))
            .append(" [").append(level).append("]")
            .append(" [").append(sanitize(tag)).append("] ")
            .append(sanitize(message));
        if (detail != null && !detail.isBlank()) {
            line.append(" | ").append(sanitize(detail));
        }
        String rendered = line + System.lineSeparator();
        System.out.print(rendered);

        if (writer != null) {
            try {
                writer.write(rendered);
                writer.flush();
            } catch (IOException ignored) {
                writer = null;
            }
        }
    }

    private Path resolveDownloadsRoot() {
        String explicit = System.getenv("SCRIPTARR_RAVEN_DATA_ROOT");
        if (explicit != null && !explicit.isBlank()) {
            return Path.of(explicit.trim());
        }
        return Path.of("/downloads");
    }

    private Path resolveLogsRoot(Path root) {
        String explicit = System.getenv("SCRIPTARR_RAVEN_LOG_DIR");
        if (explicit != null && !explicit.isBlank()) {
            return Path.of(explicit.trim());
        }
        return root.resolve("logs");
    }

    private void rotateLogs() throws IOException {
        Path latestLog = logsRoot.resolve(LATEST_LOG);
        if (Files.exists(latestLog) && Files.size(latestLog) > 0L) {
            String archivedName = FILE_FORMAT.format(LocalDateTime.now()) + ".log";
            Files.move(latestLog, logsRoot.resolve(archivedName), StandardCopyOption.REPLACE_EXISTING);
        }

        try (Stream<Path> stream = Files.list(logsRoot)
            .filter(path -> path.getFileName().toString().endsWith(".log"))
            .filter(path -> !path.getFileName().toString().equals(LATEST_LOG))
            .sorted(Comparator.comparingLong(this::modifiedAt).reversed())) {
            stream.skip(MAX_LOGS - 1L).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException ignored) {
                }
            });
        }
    }

    private long modifiedAt(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ignored) {
            return 0L;
        }
    }

    private boolean parseDebug(String value) {
        if (value == null) {
            return false;
        }
        return switch (value.trim().toLowerCase(Locale.ROOT)) {
            case "1", "true", "yes", "on" -> true;
            default -> false;
        };
    }

    private String sanitize(String value) {
        if (value == null) {
            return "";
        }
        return value.replaceAll("[\\r\\n]+", " ").replaceAll("\\s{2,}", " ").trim();
    }
}
