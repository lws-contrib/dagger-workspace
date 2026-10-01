import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Minimal static web server for the LWS-OIDC fixtures the conformance harness
 * token minting depends on (see the Halcyon service's module code in
 * src/index.ts).
 *
 * <p>Serves three kinds of document from a webroot directory, all generated at
 * Dagger graph-build time:
 * <ul>
 *   <li>{@code /.well-known/openid-configuration} — OIDC discovery on the
 *       fixture issuer ({@code http://127.0.0.1:8891}) that names the JWKS;</li>
 *   <li>{@code /jwks.json} — the public half of the fixture signing key;</li>
 *   <li>{@code /alice} and {@code /bob} — compact JSON-LD controlled-identifier
 *       documents that declare the fixture issuer as their
 *       {@code lws:OpenIdProvider} (the {@code did:service} shape
 *       {CidResolver#modelFromCompactJsonLd} reads).</li>
 * </ul>
 *
 * <p>Halcyon's {@code LwsOidcVerifier} dereferences a presented ID token's
 * {@code sub} (a WebID) to its CID, discovers the issuer it names, fetches the
 * JWKS there and verifies the signature — so this server must be reachable
 * from the Halcyon container on loopback, which is why it binds
 * {@code 127.0.0.1} and why {@code lws-oidc.json} allow-lists
 * {@code 127.0.0.1} in {@code allowedInternalHosts} (the SSRF guard).
 *
 * <p>Deliberately tiny: one GET/HEAD handler, exact-path content types, no
 * directory listing, no redirects (the verifier never follows them either).
 */
public final class OidcServer {

    private OidcServer() {
    }

    public static void main(String[] args) throws IOException {
        Path root = Path.of(args.length > 0 ? args[0] : "webroot").toAbsolutePath().normalize();
        int port = args.length > 1 ? Integer.parseInt(args[1]) : 8891;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/", exchange -> handle(exchange, root));
        server.setExecutor(null); // default: the caller thread pool
        server.start();
        System.out.println("OIDC fixture server on 127.0.0.1:" + port + " serving " + root);
    }

    private static void handle(HttpExchange exchange, Path root) throws IOException {
        try (exchange) {
            String method = exchange.getRequestMethod();
            if (!method.equals("GET") && !method.equals("HEAD")) {
                exchange.getResponseHeaders().set("Allow", "GET, HEAD");
                exchange.sendResponseHeaders(405, -1);
                return;
            }
            String path = exchange.getRequestURI().getRawPath();
            String name = path.startsWith("/") ? path.substring(1) : path;
            if (name.isEmpty()) {
                exchange.sendResponseHeaders(404, -1);
                return;
            }
            Path file = root.resolve(name).normalize();
            if (!file.startsWith(root) || !Files.isRegularFile(file)) {
                exchange.sendResponseHeaders(404, -1);
                return;
            }
            byte[] body = Files.readAllBytes(file);
            String type = switch (name) {
                case "alice", "bob" -> "application/ld+json";
                default -> "application/json";
            };
            exchange.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
            if (method.equals("HEAD")) {
                exchange.getResponseHeaders().set("Content-Length", String.valueOf(body.length));
                exchange.sendResponseHeaders(200, -1);
                return;
            }
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        }
    }
}