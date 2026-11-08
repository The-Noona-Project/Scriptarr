package com.scriptarr.raven.library;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.util.Map;

/** Narrow authenticated Sage client shared by coordinator and isolated conversion worker. */
public final class IngestBrokerClient {
    private final URI base;
    private final String token;
    private final HttpClient http;
    private final ObjectMapper json = new ObjectMapper();

    /**
     * Configure the existing Sage endpoint and optional dedicated private CA.
     * @param env process configuration
     */
    public IngestBrokerClient(Map<String, String> env) {
        try {
            base = URI.create(env.getOrDefault("SCRIPTARR_SAGE_BASE_URL", "http://scriptarr-sage:3004"));
            if (base.getUserInfo() != null || base.getQuery() != null || base.getFragment() != null) throw new IllegalArgumentException("Invalid broker origin.");
            if ("ingest-worker".equals(env.get("SCRIPTARR_RAVEN_ROLE")) && !"https".equals(base.getScheme())) throw new IllegalArgumentException("Worker broker requires HTTPS.");
            token = env.getOrDefault("SCRIPTARR_SERVICE_TOKEN", "");
            HttpClient.Builder builder = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER);
            String ca = env.get("SCRIPTARR_RAVEN_WORKER_CA_FILE");
            if (ca != null && !ca.isBlank()) {
                KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType()); store.load(null);
                try (InputStream in = Files.newInputStream(Path.of(ca))) { int index = 0; for (var certificate : CertificateFactory.getInstance("X.509").generateCertificates(in)) store.setCertificateEntry("broker-" + index++, certificate); }
                TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trust.init(store);
                SSLContext context = SSLContext.getInstance("TLS"); context.init(null, trust.getTrustManagers(), null); builder.sslContext(context);
            }
            http = builder.build();
        } catch (Exception error) { throw new IllegalArgumentException("Could not configure the ingest broker transport.", error); }
    }

    /**
     * Read or mutate only the focused ingest broker namespace.
     * @param method HTTP method
     * @param path relative ingest route
     * @param body optional JSON body
     * @param leaseToken optional transient worker lease secret
     * @return JSON response, or null for no available work
     * @throws IOException when the broker rejects or cannot acknowledge the operation
     * @throws InterruptedException when transport is cancelled
     */
    public JsonNode json(String method, String path, Object body, String leaseToken) throws IOException, InterruptedException {
        HttpRequest.BodyPublisher publisher = body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body));
        HttpResponse<byte[]> response = http.send(request(path, leaseToken).header("Content-Type", "application/json").method(method, publisher).build(), HttpResponse.BodyHandlers.ofByteArray());
        requireSuccess(response.statusCode());
        return response.statusCode() == 204 || response.body().length == 0 ? null : json.readTree(response.body());
    }

    /**
     * Stream an assigned chapter input directly to worker scratch.
     * @param path lease-scoped input route
     * @param target new worker-local file
     * @param leaseToken transient lease secret
     * @param expectedSize immutable source archive byte length
     * @throws IOException when the broker cannot provide the input
     * @throws InterruptedException when lease cancellation interrupts input
     */
    public void download(String path, Path target, String leaseToken, long expectedSize) throws IOException, InterruptedException {
        if (expectedSize <= 0 || expectedSize > 21_474_836_480L) throw new IOException("Assigned input exceeds the chapter transfer budget.");
        HttpResponse<InputStream> response = http.send(request(path, leaseToken).GET().build(), HttpResponse.BodyHandlers.ofInputStream());
        try (InputStream input = response.body()) {
            requireSuccess(response.statusCode());
            WebpChapterEncoder.copyBounded(input, target, expectedSize, 21_474_836_480L);
        } catch (IOException | RuntimeException failure) { Files.deleteIfExists(target); throw failure; }
    }

    /**
     * Upload WebP artifacts without base64 or in-memory chapter buffering.
     * @param path assigned result route
     * @param artifact worker-local artifact ZIP
     * @param leaseToken transient lease secret
     * @return acknowledged job state
     * @throws IOException when upload is rejected
     * @throws InterruptedException when lease cancellation interrupts upload
     */
    public JsonNode upload(String path, Path artifact, String leaseToken) throws IOException, InterruptedException {
        HttpResponse<byte[]> response = http.send(request(path, leaseToken).header("Content-Type", "application/zip").header("X-Scriptarr-Artifact-Sha256", WebpChapterEncoder.sha256(artifact))
            .POST(HttpRequest.BodyPublishers.ofFile(artifact)).build(), HttpResponse.BodyHandlers.ofByteArray());
        requireSuccess(response.statusCode()); return json.readTree(response.body());
    }

    /** @param path ingest-relative route @param lease optional lease secret @return authenticated request builder */
    private HttpRequest.Builder request(String path, String lease) {
        if (!path.startsWith("/") || path.contains("..")) throw new IllegalArgumentException("Invalid ingest broker route.");
        HttpRequest.Builder request = HttpRequest.newBuilder(base.resolve("/api/internal/raven-ingest" + path)).timeout(Duration.ofSeconds(120)).header("Authorization", "Bearer " + token);
        if (lease != null && !lease.isBlank()) request.header("X-Scriptarr-Lease-Token", lease);
        return request;
    }

    /** @param status HTTP status @throws IOException when an operation was not acknowledged */
    private static void requireSuccess(int status) throws IOException { if (status < 200 || status >= 300) throw new Rejected(status); }

    /** A bounded HTTP rejection that lets workers distinguish lost leases from transient transport outages. */
    public static final class Rejected extends IOException {
        private final int status;
        /** @param status bounded HTTP result */
        private Rejected(int status) { super("Ingest broker rejected operation (HTTP " + status + ")."); this.status = status; }
        /** @return rejected HTTP status */
        public int status() { return status; }
    }
}
