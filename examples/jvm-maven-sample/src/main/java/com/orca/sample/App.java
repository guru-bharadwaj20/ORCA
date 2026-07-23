package com.orca.sample;

import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

/**
 * A minimal HTTP service on the JDK's built-in server — the smallest repo that exercises
 * ORCA's JVM (Maven) recipe: detect pom.xml, build a runnable jar, run it under a JRE.
 * No external dependencies, so the Maven build is hermetic.
 */
public final class App {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", exchange -> {
            byte[] body = "{\"status\":\"ok\",\"service\":\"orca-jvm-sample\"}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
        System.out.println("listening on :" + port);
    }
}
