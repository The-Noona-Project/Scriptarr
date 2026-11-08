package com.scriptarr.raven.downloader;

import com.scriptarr.raven.support.ScriptarrLogger;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/** Exercise real paginated HTML discovery failures and cancellation with a local HTTP source. */
class TitleScraperBulkDiscoveryTest {
    private HttpServer server;

    /** Stop the isolated source server after each test. */
    @AfterEach
    void cleanup() { if (server != null) server.stop(0); }

    /** Keep unknown card types for concrete detail verification while excluding confirmed wrong types. */
    @Test
    void unknownCardTypeMustNotSilentlyDisappear() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data",exchange -> reply(exchange,200,
            card("wrong","Alpha Wrong Type","Manga")
                +"<article class='bg-base-300'><a class='line-clamp-1 link link-hover' href='/series/pending'>Alpha Pending Type</a></article>"));
        server.start();
        BulkBrowseResult result=scraper().browseTitlesAlphabetically("Manhua",false,"a");
        assertEquals(1,result.titles().size());
        assertEquals("Alpha Pending Type",result.titles().getFirst().get("title"));
        assertFalse(result.titles().getFirst().containsKey("type"));
    }

    /** Verify ignored upstream filters cannot introduce another type, prefix or source origin. */
    @Test
    void locallyRequiresRequestedTypePrefixAndOrigin() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data", exchange -> reply(exchange,200,
            card("a","Alpha","Manhua")+card("b","Alpha Wrong Type","Manga")+card("c","Beta","Manhua")
                +"<article class='bg-base-300'><a class='line-clamp-1 link link-hover' href='https://foreign.test/series/evil'>Alpha Foreign</a><strong>Type:</strong><span>Manhua</span></article>"));
        server.start();
        BulkBrowseResult result = scraper().browseTitlesAlphabetically("Manhua",false,"a");
        assertEquals(1,result.titles().size());
        assertEquals("Alpha",result.titles().getFirst().get("title"));
        assertEquals("Manhua",result.titles().getFirst().get("type"));
    }

    /** Verify a failed later page throws instead of silently returning a successful partial browse. */
    @Test
    void laterPageTransportFailureIsExplicit() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data",exchange->{
            calls.incrementAndGet();
            if(exchange.getRequestURI().getRawQuery().contains("offset=0")) reply(exchange,200,card("a","Alpha","Manhua")+more());
            else reply(exchange,503,"source unavailable");
        });
        server.start();
        BulkDiscoveryException error = assertThrows(BulkDiscoveryException.class,()->scraper().browseTitlesAlphabetically("Manhua",false,"a"));
        assertEquals("upstream_failure",error.code());
        assertEquals(1,error.pagesScanned());
        assertTrue(calls.get()>1);
    }

    /** Verify access challenges and repeated pagination are explicit failures. */
    @Test
    void challengesAndRepeatedPagesCannotCompleteDiscovery() throws Exception {
        AtomicBoolean challenge = new AtomicBoolean(false);
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data",exchange->reply(exchange,200,challenge.get()
            ?"<html><body>Checking your browser. Verify you are human.</body></html>"
            :card("a","Alpha","Manhua")+more()));
        server.start();
        assertEquals("repeated_pagination",assertThrows(BulkDiscoveryException.class,()->scraper().browseTitlesAlphabetically("Manhua",false,"a")).code());
        challenge.set(true);
        assertEquals("upstream_challenge",assertThrows(BulkDiscoveryException.class,()->scraper().browseTitlesAlphabetically("Manhua",false,"a")).code());
    }

    /** Challenge phrases in legitimate full-display title and synopsis text must not hide valid results. */
    @Test
    void legitimateResultTextDoesNotBecomeAnAccessChallenge() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data",exchange->reply(exchange,200,
            card("captcha","Captcha: Access Denied, Just a Moment","Manhua")
                +"<p>A story about checking your browser and asking you to verify you are human.</p>"));
        server.start();

        BulkBrowseResult result = scraper().browseTitlesAlphabetically("Manhua",false,"c");
        assertEquals(1,result.titles().size());
        assertEquals("Captcha: Access Denied, Just a Moment",result.titles().getFirst().get("title"));
    }

    /** Explicit access-challenge markup remains fail-closed even alongside otherwise valid result cards. */
    @Test
    void explicitChallengeMarkupStillRejectsResultCards() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data",exchange->reply(exchange,200,
            card("a","Alpha","Manhua")+"<form id='challenge-form'></form>"));
        server.start();

        assertEquals("upstream_challenge",assertThrows(BulkDiscoveryException.class,
            ()->scraper().browseTitlesAlphabetically("Manhua",false,"a")).code());
    }

    /** Verify cancellation after a page prevents requesting the next page. */
    @Test
    void cancellationStopsDiscoveryBetweenPages() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        AtomicBoolean cancelled = new AtomicBoolean();
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data",exchange->{calls.incrementAndGet();reply(exchange,200,card("a","Alpha","Manhua")+more());});
        server.start();
        assertThrows(java.util.concurrent.CancellationException.class,()->scraper().browseTitlesAlphabetically("Manhua",false,"a",cancelled::get,pages->cancelled.set(true)));
        assertEquals(1,calls.get());
    }

    /** Verify only an explicit empty-result response can become a successful empty browse. */
    @Test
    void emptyResultMustBeVerifiable() throws Exception {
        AtomicBoolean empty = new AtomicBoolean();
        server = HttpServer.create(new InetSocketAddress(0),0);
        server.createContext("/search/data",exchange->reply(exchange,200,empty.get()?"<p>No results found.</p>":"<html><body>Unexpected login page</body></html>"));
        server.start();
        assertEquals("malformed_results",assertThrows(BulkDiscoveryException.class,()->scraper().browseTitlesAlphabetically("Manhua",false,"a")).code());
        empty.set(true);
        assertTrue(scraper().browseTitlesAlphabetically("Manhua",false,"a").titles().isEmpty());
    }

    private TitleScraper scraper() { return new TitleScraper(mock(ScriptarrLogger.class),"http://127.0.0.1:"+server.getAddress().getPort()); }
    private static String card(String id,String title,String type) { return "<article class='bg-base-300'><a class='line-clamp-1 link link-hover' href='/series/"+id+"'>"+title+"</a><div><strong>Type:</strong><span>"+type+"</span></div></article>"; }
    private static String more() { return "<button hx-get='/search/data?offset=32'></button>"; }
    private static void reply(HttpExchange exchange,int status,String body) throws IOException {
        byte[] bytes=body.getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().set("Content-Type","text/html");exchange.sendResponseHeaders(status,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
    }
}
