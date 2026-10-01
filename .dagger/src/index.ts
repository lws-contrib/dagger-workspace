/**
 * Dagger module for the LWS conformance workspace
 * (https://github.com/lws-contrib/dagger-workspace).
 *
 * Builds the lws-server (https://github.com/ebremer/lws-server), sparq
 * (https://github.com/sparq-org/sparq) and Halcyon
 * (https://github.com/halcyon-project/Halcyon, `next` branch) implementations
 * under test and runs the Touchstone (https://github.com/ebremer/touchstone) or
 * LWS.net (https://github.com/langsamu/LWS.net) conformance harnesses against
 * them.
 *
 * The lws-net harness uses the YAML-LD suite definition (tests.yaml) from
 * the `yaml` branch of https://github.com/elf-pavlik/lws-test-suite by
 * default (converted to N-Triples and mounted as the harness's new.ttl).
 * Pass a relative path to a local checkout (e.g. --tests ../lws-test-suite/lws10)
 * to force use of a local copy instead.
 */
import { dag, Container, Directory, File, object, func, Service } from "@dagger.io/dagger"
import { Buffer } from "node:buffer"
import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

// ---------------------------------------------------------------------------
// Halcyon LWS-OIDC fixtures
//
// Halcyon on the `next` branch (halcyon-project/Halcyon) never grants anonymous
// access: every storage needs a :LWSOwner in settings.ttl, and the conformance
// harnesses must therefore present real bearer credentials. Rather than stand
// up Keycloak, this module wires the authentication suite Halcyon implements
// natively -- lws10-authn-openid -- with a minimal in-container OIDC fixture:
//
//   * an OidcServer (halcyon/oidc/OidcServer.java) serving, on the container's
//     loopback, the controlled-identifier documents for two agents (alice, bob)
//     and the OIDC discovery + JWKS of the OpenID Provider they nominate;
//   * ES256 ID tokens minted here at graph-build time, signed with the same
//     key the fixture's jwks.json publishes. They reach the harness as static
//     tokens (token.alice / token.bob in the target registry) and Halcyon's
//     LwsOidcVerifier via lws-oidc.json, which allow-lists the loopback host
//     past the SSRF guard.
//
// The keypair is generated once per Dagger process so the jwks.json written
// into the Halcyon container and the tokens passed to the harness always match.
// ---------------------------------------------------------------------------

const HALCYON_OIDC_HOST = "127.0.0.1:8891"
const HALCYON_OIDC_BASE = `http://${HALCYON_OIDC_HOST}`
const HALCYON_OIDC_KID = "halcyon-oidc-1"
const HALCYON_ALICE_WEBID = `${HALCYON_OIDC_BASE}/alice`
const HALCYON_BOB_WEBID = `${HALCYON_OIDC_BASE}/bob`

/** The fixture keypair, and every document/token derived from it. */
const HALCYON_OIDC = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
  const jwk = publicKey.export({ format: "jwk" }) as unknown as {
    x: string
    y: string
  }
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    kid: HALCYON_OIDC_KID,
    alg: "ES256",
    use: "sig",
  }
  const iss = HALCYON_OIDC_BASE
  const iat = Math.floor(Date.now() / 1000)
  // Long-lived on purpose: the tokens are minted before the Maven build, and
  // must still be valid when the harness finally connects.
  const exp = iat + 6 * 60 * 60
  const mint = (sub: string): string => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const header = { alg: "ES256", typ: "JWT", kid: HALCYON_OIDC_KID }
    const input = `${b64(header)}.${b64({ iss, sub, iat, exp, jti: randomUUID() })}`
    const sig = derToRaw(sign("sha256", Buffer.from(input), privateKey))
    return `${input}.${Buffer.from(sig).toString("base64url")}`
  }
  const cid = (webid: string) =>
    JSON.stringify({
      id: webid,
      service: [
        {
          type: "https://www.w3.org/ns/lws#OpenIdProvider",
          serviceEndpoint: iss,
        },
      ],
    })
  return {
    discovery: JSON.stringify({
      issuer: iss,
      authorization_endpoint: `${iss}/authorize`,
      token_endpoint: `${iss}/token`,
      jwks_uri: `${iss}/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
    }),
    jwks: JSON.stringify({ keys: [publicJwk] }),
    cidAlice: cid(HALCYON_ALICE_WEBID),
    cidBob: cid(HALCYON_BOB_WEBID),
    tokenAlice: mint(HALCYON_ALICE_WEBID),
    tokenBob: mint(HALCYON_BOB_WEBID),
  }
})()

/** DER ECDSA signature -> the fixed-width R||S form JWS uses. */
function derToRaw(der: Buffer): Buffer {
  let p = 0
  if (der[p++] !== 0x30) {
    throw new Error("not a DER sequence")
  }
  p++ // sequence length (single byte for a P-256 signature)
  if (der[p++] !== 0x02) {
    throw new Error("not an integer")
  }
  const rLen = der[p++]
  const r = der.subarray(p, p + rLen)
  p += rLen
  if (der[p++] !== 0x02) {
    throw new Error("not an integer")
  }
  const sLen = der[p++]
  const s = der.subarray(p, p + sLen)
  const to32 = (b: Buffer): Buffer => {
    const out = Buffer.alloc(32)
    const trim = b.length > 32 ? b.subarray(b.length - 32) : b
    trim.copy(out, 32 - trim.length)
    return out
  }
  return Buffer.concat([to32(r), to32(s)])
}

/** settings.ttl for the Halcyon service; `openMode` adds the DEV-ONLY public seed. */
function renderHalcyonSettings(openMode: boolean): string {
  return (
    "PREFIX :    <https://halcyon.is/ns/>\n" +
    "PREFIX lws: <https://www.w3.org/ns/lws#>\n" +
    "<http://localhost> a :HalcyonSettingsFile ;\n" +
    '    :ProxyHostName "http://halcyon:8888" ;\n' +
    "    :HTTPPort 8888 ;\n" +
    '    :RDFStoreLocation "tdb2" ;\n' +
    '    :LWSStoreLocation "lws-tdb2" ;\n' +
    `    :LWSOwner <${HALCYON_ALICE_WEBID}> ;\n` +
    (openMode ? "    :LWSOpenMode true ;\n" : "") +
    "    :hasLWSStorage [ a lws:Storage ; :urlPath \"/W3Clws\" ;\n" +
    "                     :storageRoot <file:///data/lws/W3Clws/> ; :namingPolicy \"uuid\" ] .\n"
  )
}

const HALCYON_LWS_OIDC_JSON =
  "{\n  \"enabled\": true,\n  \"allowedInternalHosts\": [\"127.0.0.1\"]\n}\n"

/**
 * Replaces the jar's packaged application.yml (see the Halcyon service): the
 * jar ships server.ssl with a JKS bundle that needs local keystore files and
 * would force HTTPS, but the conformance harnesses speak plain HTTP, so this
 * boot strips the SSL connector (:HTTPS2enabled is also off in settings.ttl).
 */
const HALCYON_APPLICATION_YML =
  "server:\n" +
  "  port: 8888\n" +
  "spring:\n" +
  "  main:\n" +
  "    keep-alive: true\n" +
  "    allow-circular-references: true\n" +
  "logging:\n" +
  "  level:\n" +
  "    root: INFO\n" +
  "    com.ebremer.lws: INFO\n"

@object()
export class DaggerWorkspace {
  /**
   * The lws-server source: a GitHub clone of
   * https://github.com/ebremer/lws-server (default branch), or a local
   * checkout when a source Directory is passed explicitly.
   */
  private lwsServerSource(source?: Directory): Directory {
    return source ?? dag.git("https://github.com/ebremer/lws-server").head().tree()
  }

  private touchstoneSource(source?: Directory): Directory {
    return source ?? dag.git("https://github.com/ebremer/touchstone").head().tree()
  }

  private sparqSource(source?: Directory): Directory {
    return (
      source ??
      dag
        .git("https://github.com/elf-pavlik/sparq")
        .branch("feat/open-mode")
        .tree()
    )
  }

  private lwsNetSource(source?: Directory): Directory {
    return source ?? dag.git("https://github.com/langsamu/LWS.net").head().tree()
  }

  /**
   * The lws-net suite definition: tests.yaml from the `yaml` branch of
   * https://github.com/elf-pavlik/lws-test-suite by default (the same
   * YAML-LD shape produced by `bun run ttl2yaml` in this workspace), or a
   * local copy when an explicit Directory is passed (e.g. a relative path to
   * a checkout of the lws-test-suite repo).
   */
  private lwsNetTests(tests?: Directory): Directory {
    return (
      tests ??
      dag.git("https://github.com/elf-pavlik/lws-test-suite")
        .branch("yaml")
        .tree()
        .directory("lws10")
    )
  }

  /**
   * The Halcyon source: the `next` branch of
   * https://github.com/halcyon-project/Halcyon by default (or another GitHub
   * repo/branch via halcyonRepo/halcyonRef), or a local checkout when a source
   * Directory is passed explicitly.
   */
  private halcyonSource(
    source?: Directory,
    halcyonRepo?: string,
    halcyonRef?: string,
  ): Directory {
    return (
      source ??
      dag
        .git(halcyonRepo && halcyonRepo.trim() !== ""
          ? halcyonRepo
          : "https://github.com/halcyon-project/Halcyon")
        .branch(halcyonRef && halcyonRef.trim() !== "" ? halcyonRef : "next")
        .tree()
    )
  }

  /**
   * Builds the lws-server (Maven / Spring Boot, JDK 25) from source into a
   * container image. Dependencies are cached in a cache volume.
   */
  private lwsServerBuild(source?: Directory): Container {
    return dag
      .container()
      .from("maven:3.9-eclipse-temurin-25")
      .withMountedCache("/root/.m2/repository", dag.cacheVolume("lws-m2"))
      .withDirectory("/src", this.lwsServerSource(source))
      .withWorkdir("/src")
      .withExec(["mvn", "-q", "-DskipTests", "package"])
  }

  /**
   * Builds and starts the lws-server, returned as a Dagger service.
   *
   * The server runs in LWS "open mode" (no owners, lws.dev.open=true) so it
   * accepts anonymous requests without configuration. It listens on port 8080;
   * lws.base-uri is set to the service hostname (see below).
   *
   * The source defaults to a clone of https://github.com/ebremer/lws-server;
   * pass --source with a local checkout to test uncommitted changes.
   *
   * Bind it from another container with withServiceBinding("lws-server", svc)
   * or expose it to the host with `dagger call lws-server-service ... up --ports 8080:8080`.
   *
   * lws.base-uri is set to the service hostname so every IRI the server mints
   * (storage description, resources, DPoP htu) is resolvable by clients bound
   * to it inside the test network.
   */
  @func()
  lwsServerService(source?: Directory): Service {
    return this.lwsServerBuild(source)
      .withExposedPort(8080)
      .asService({
        args: [
          "java",
          "-Dlws.dev.open=true",
          "-Dlws.owners=",
          "-Dlws.require-https=false",
          "-Dlws.base-uri=http://lws-server:8080",
          "-jar",
          "target/lws-server.jar",
        ],
      })
      .withHostname("lws-server")
  }

  /**
   * Builds the Touchstone conformance harness image, following the same recipe
   * as its Dockerfile: Maven-wrapper build on JDK 21, then a slim JRE runtime
   * carrying the shaded CLI jar plus the requirements catalog and the YAML-LD
   * test definitions (catalog/ and definitions/ at the repo root).
   *
   * Touchstone vendors its own lws10 definitions for now; it does not consume
   * the canonical manifests from lws-contrib/lws-test-suite yet (a future
   * change will wire --manifests into this path as well).
   */
  private touchstoneImage(source?: Directory): Container {
    const src = this.touchstoneSource(source)
    const build = dag
      .container()
      .from("eclipse-temurin:21-jdk")
      .withMountedCache("/root/.m2", dag.cacheVolume("touchstone-m2"))
      .withDirectory("/src", src)
      .withWorkdir("/src")
      .withExec([
        "sh", "./mvnw", "-q", "-B", "-ntp",
        "-pl", "harness-cli", "-am",
        "-Dmaven.test.skip=true", "package",
      ])
    return dag
      .container()
      .from("eclipse-temurin:21-jre")
      .withWorkdir("/opt/touchstone")
      .withFile("touchstone.jar", build.file("/src/harness-cli/target/touchstone.jar"))
      .withDirectory("catalog", src.directory("catalog"))
      .withDirectory("definitions", src.directory("definitions"))
  }

  /**
   * The lws-net suite resolves the storage root as the SITE root: each test GETs
   * `{baseUri}/` (a relative "/"), which the harness's Uri.Evaluate resolves
   * against the configured base — so the storage must live at the host root for
   * that to hit the storage description. lws-server and sparq are mounted there;
   * Halcyon mounts its storage at a path (/W3Clws), where resolving "/" lands
   * on the Wicket home page (HTML, which the JsonPath extractor rejects). For
   * the halcyon cell only, rewrite that relative root to "" so the request
   * resolves to the base itself — the storage root URI, which serves the
   * description (lws10-core: "the storage URI answers with its description").
   */
  private async halcyonLwsNetTests(tests?: Directory): Promise<Directory> {
    const src = this.lwsNetTests(tests)
    const doc = parseYaml(await src.file("tests.yaml").contents()) as {
      tests?: Array<{
        steps?: Array<{ request?: { uri?: { relative?: { value?: string } } } }>
      }>
    }
    for (const t of doc.tests ?? []) {
      for (const step of t.steps ?? []) {
        const relative = step.request?.uri?.relative
        if (relative?.value === "/") {
          relative.value = "" // resolves to the storage root URI (the base)
        }
      }
    }
    return dag.directory().withNewFile("tests.yaml", stringifyYaml(doc))
  }

  /**
   * Runs the Touchstone conformance harness against a bound service.
   *
   * The harness container registers the service as the SUT target in a
   * targets.yaml registry (Touchstone only accepts target ids, never raw
   * URLs) and runs the core module. Reports land in a touchstone-runs cache
   * volume under /work/runs. Exit codes are preserved: 0 conformant, 1
   * non-conformant (fails the run), 2 harness misconfiguration.
   */
  private touchstoneRun(
    server: Service,
    alias: string,
    baseUrl: string,
    properties?: Record<string, string>,
    touchstone?: Directory,
  ): Promise<string> {
    let targets =
      "targets:\n" +
      "  sut:\n" +
      `    baseUrl: ${baseUrl}\n` +
      "    adapter: env\n"
    const props = Object.entries(properties ?? {})
    if (props.length > 0) {
      targets += "    properties:\n"
      for (const [k, v] of props) {
        targets += `      ${k}: '${v}'\n`
      }
    }
    return this.touchstoneImage(touchstone)
      .withServiceBinding(alias, server)
      .withNewFile("/work/targets.yaml", targets)
      .withMountedCache("/work/runs", dag.cacheVolume("touchstone-runs"))
      .withExec([
        "java", "-jar", "/opt/touchstone/touchstone.jar",
        "run",
        "--target", "sut",
        "--module", "core",
        "--targets", "/work/targets.yaml",
        "--report-dir", "/work/runs",
        "--catalog", "catalog",
        "--definitions", "definitions",
      ])
      .stdout()
  }

  /**
   * The service for a named implementation under test.
   */
  private sut(
    server: string,
    harness: string,
    source?: Directory,
    halcyonRepo?: string,
    halcyonRef?: string,
  ): {
    service: Service
    host: string
    baseUrl: string
    targetProperties?: Record<string, string>
  } {
    if (server === "halcyon") {
      // lws-net never sends an Authorization header, so its cell boots Halcyon
      // in DEV-ONLY open mode (:LWSOpenMode): the seeded root ACR grants the
      // public agent full control, and anonymous requests provision the
      // storage. The touchstone cell keeps the closed posture and its harness
      // reads static LWS-OIDC credentials (webid + ID token) for alice and bob
      // from the target registry — minted against the in-container OIDC fixture
      // (see HALCYON_OIDC) — while the owner policy stays the controller.
      if (harness === "lws-net") {
        return {
          service: this.halcyonService(source, true, halcyonRepo, halcyonRef),
          host: "halcyon",
          baseUrl: "http://halcyon:8888/W3Clws/",
        }
      }
      return {
        service: this.halcyonService(source, false, halcyonRepo, halcyonRef),
        host: "halcyon",
        baseUrl: "http://halcyon:8888/W3Clws/",
        targetProperties: {
          "webid.alice": HALCYON_ALICE_WEBID,
          "webid.bob": HALCYON_BOB_WEBID,
          "token.alice": HALCYON_OIDC.tokenAlice,
          "token.bob": HALCYON_OIDC.tokenBob,
        },
      }
    }
    if (server === "sparq") {
      return {
        service: this.sparqService(source),
        host: "sparq",
        baseUrl: "http://sparq:3000/",
      }
    }
    if (server === "lws-server") {
      return {
        service: this.lwsServerService(source),
        host: "lws-server",
        baseUrl: "http://lws-server:8080/",
      }
    }
    throw new Error(
      `unknown server: ${server} (expected lws-server, sparq or halcyon)`,
    )
  }

  /**
   * Runs the selected suite harness against the selected implementation.
   * Fails the run on any failing assertion.
   *
   * CLI:
   *   dagger call test --harness touchstone --server lws-server
   *   dagger call test --harness lws-net --server lws-server
   *   dagger call test --harness touchstone --server sparq
   *   dagger call test --harness lws-net --server sparq
   *   dagger call test --harness touchstone --server halcyon
   *   dagger call test --harness lws-net --server halcyon
   *
   * The lws-net harness uses the YAML-LD suite definition (tests.yaml) from
   * the `yaml` branch of https://github.com/elf-pavlik/lws-test-suite by
   * default (converted to N-Triples and mounted as the harness's new.ttl);
   * force a local copy by passing a relative path:
   *   dagger call test --harness lws-net --server lws-server --tests ../lws-test-suite/lws10
   */
  @func()
  async test(
    // The suite harness: "touchstone" (default) or "lws-net".
    harness: string = "touchstone",
    // The implementation under test: "lws-server" (default), "sparq" or "halcyon".
    server: string = "lws-server",
    // Override the implementation source (local checkout of the server).
    source?: Directory,
    // Halcyon only: the GitHub repo to build from when no local --source is
    // given (default: halcyon-project/Halcyon). e.g. a fork or patch branch.
    halcyonRepo?: string,
    // Halcyon only: the branch/ref of halcyonRepo (default: next).
    halcyonRef?: string,
    // Override the harness source (touchstone / LWS.net repo checkout).
    suite?: Directory,
    // Suite definition for the lws-net harness: default is tests.yaml from
    // the `yaml` branch of https://github.com/elf-pavlik/lws-test-suite
    // (converted to N-Triples new.ttl); pass a relative path to a local
    // checkout of the lws-test-suite repo to force a local copy instead.
    // Touchstone still vendors its own definitions/ and does not consume this.
    tests?: Directory,
  ): Promise<string> {
    const { service, host, baseUrl, targetProperties } =
      this.sut(server, harness, source, halcyonRepo, halcyonRef)
    if (harness === "touchstone") {
      return this.touchstoneRun(service, host, baseUrl, targetProperties, suite)
    }
    if (harness === "lws-net") {
      // The halcyon cell serves its storage at a path, so its suite must resolve
      // relative "/" to the storage root itself (see halcyonLwsNetTests).
      const suiteTests =
        server === "halcyon" ? await this.halcyonLwsNetTests(tests) : tests
      return this.lwsNetSuite(suite, suiteTests)
        .withServiceBinding(host, service)
        .withEnvVariable("Suite__BaseUri", baseUrl)
        .withExec(["dotnet", "test", "Suite/Test"])
        .stdout()
    }
    throw new Error(`unknown harness: ${harness} (expected touchstone or lws-net)`)
  }

  /**
   * Converts the YAML-LD suite definition (tests.yaml) to N-Triples Turtle
   * and returns it as a dagger File, ready to be embedded as the harness's
   * new.ttl. Runs this workspace's yaml-to-ttl.ts with bun (oven/bun image),
   * installing the pinned deps (package.json + bun.lock).
   */
  private lwsNetDefinitionTtl(tests?: Directory): File {
    const work = dag
      .container()
      .from("oven/bun:1")
      .withEntrypoint([]) // the oven/bun image defaults its entrypoint to bun
      .withDirectory("/work", dag.currentModule().source()) // module files: package.json, bun.lock, yaml-to-ttl.ts
      .withFile("/work/tests.yaml", this.lwsNetTests(tests).file("tests.yaml"))
      .withWorkdir("/work")
      .withExec(["bun", "install", "--frozen-lockfile"])
      .withExec(["bun", "yaml-to-ttl.ts", "tests.yaml", "new.ttl"])
    return work.file("/work/new.ttl")
  }

  /**
   * Builds the LWS.net suite container with the suite definition mounted
   * under the harness's fixed embedded resource name (Resources/new.ttl): the
   * external YAML-LD definition is converted to N-Triples first (see
   * lwsNetDefinitionTtl) so the harness keeps parsing Turtle with no changes.
   */
  private lwsNetSuite(suite?: Directory, tests?: Directory): Container {
    return dag
      .container()
      .from("mcr.microsoft.com/dotnet/sdk:10.0")
      .withDirectory("/src", this.lwsNetSource(suite))
      .withFile(
        "/src/Suite/Model/Resources/new.ttl",
        this.lwsNetDefinitionTtl(tests),
      )
      .withWorkdir("/src")
  }

  /**
   * Builds and starts the sparq LWS server (sparq-lws-core from the sparq
   * workspace, https://github.com/sparq-org/sparq), returned as a Dagger
   * service bound as "sparq" on port 3000.
   *
   * Serves an ephemeral in-memory store (PSS_SPARQ_BACKEND default) in open mode:
   * SOLID_SERVER_OPEN_MODE=1 (a dev seed on the feat/open-mode branch) grants the
   * public foaf:Agent Read/Write/Append/Control on the storage root, so anonymous
   * clients can provision and write.
   *
   * The source defaults to the feat/open-mode branch of the
   * https://github.com/elf-pavlik/sparq fork; pass --source with a local checkout
   * to test uncommitted changes.
   */
  /**
   * Builds and starts the W3C Linked Web Storage server embedded in Halcyon
   * (https://github.com/halcyon-project/Halcyon, `next` branch), returned as a
   * Dagger service bound as "halcyon" on port 8888.
   *
   * The storage serves the LWS Protocol over plain HTTP on a single mount,
   * /W3Clws (uuid naming), with alice (the fixture WebID) as its owner;
   * Keycloak is off (no :AuthServer). The jar's packaged application.yml is
   * replaced via --spring.config.location so the server.ssl JKS bundle never
   * comes into play; :HTTPS2enabled is off in settings.ttl as well.
   *
   * Authentication uses the embedded lws10-authn-openid fixture: the
   * OidcServer + lws-oidc.json + the minted ID tokens this module generates
   * (see HALCYON_OIDC), so the touchstone harness can present bearer
   * credentials. In open mode (for harnesses that send none, e.g. lws-net) the
   * storage is additionally seeded :LWSOpenMode, which grants the public agent
   * full control on the root and descendants.
   *
   * The source defaults to the `next` branch of
   * https://github.com/halcyon-project/Halcyon; pass --source with a local
   * checkout to test uncommitted changes.
   *
   * @param openMode DEV/TEST ONLY: boot with :LWSOpenMode so the seeded root
   *   ACR also grants the public agent full control (harnesses that send no
   *   bearer token, e.g. lws-net). Implies overlaying the LWS open-mode source
   *   patch (halcyon/patches) until it lands upstream; the touchstone cell uses
   *   the default closed posture with LWS-OIDC credentials instead.
   */
  @func()
  halcyonService(
    source?: Directory,
    openMode: boolean = false,
    halcyonRepo?: string,
    halcyonRef?: string,
  ): Service {
    const runtime = this.halcyonBuild(source, openMode, halcyonRepo, halcyonRef)
      .withNewFile("/opt/halcyon/application.yml", HALCYON_APPLICATION_YML)
      .withNewFile("/opt/halcyon/settings.ttl", renderHalcyonSettings(openMode))
      .withNewFile("/opt/halcyon/lws-oidc.json", HALCYON_LWS_OIDC_JSON)
      .withFile(
        "/opt/halcyon-oidc/OidcServer.java",
        dag.currentModule().source().file("halcyon/oidc/OidcServer.java"),
      )
      .withNewFile(
        "/opt/halcyon-oidc/www/.well-known/openid-configuration",
        HALCYON_OIDC.discovery,
      )
      .withNewFile("/opt/halcyon-oidc/www/jwks.json", HALCYON_OIDC.jwks)
      .withNewFile("/opt/halcyon-oidc/www/alice", HALCYON_OIDC.cidAlice)
      .withNewFile("/opt/halcyon-oidc/www/bob", HALCYON_OIDC.cidBob)
      .withExec([
        "sh",
        "-c",
        "mkdir -p /data/lws/W3Clws /opt/halcyon/logs && " +
          "javac -d /opt/halcyon-oidc /opt/halcyon-oidc/OidcServer.java",
      ])
    return runtime
      .withExposedPort(8888)
      .asService({
        args: [
          "sh",
          "-c",
          "java -cp /opt/halcyon-oidc OidcServer /opt/halcyon-oidc/www 8891 & " +
            "sleep 2; cd /opt/halcyon && " +
            "exec java -jar /opt/halcyon.jar --spring.config.location=file:/opt/halcyon/application.yml",
        ],
      })
      .withHostname("halcyon")
  }

  /**
   * Builds Halcyon (Maven / Spring Boot 4, JDK 25) into a container image,
   * copying the runnable jar to /opt/halcyon.jar. Dependencies are cached in a
   * cache volume; the reactor's first-party artifacts (BeakGraph et al.) come
   * anonymously from the Halcyon Maven repo.
   */
  private halcyonBuild(
    source?: Directory,
    openMode: boolean = false,
    halcyonRepo?: string,
    halcyonRef?: string,
  ): Container {
    let build = dag
      .container()
      .from("maven:3.9-eclipse-temurin-25")
      .withMountedCache("/root/.m2/repository", dag.cacheVolume("halcyon-m2"))
      .withDirectory("/src", this.halcyonSource(source, halcyonRepo, halcyonRef))
      .withWorkdir("/src")
    if (openMode) {
      // :LWSOpenMode is not on halcyon-project/Halcyon next yet, so overlay the
      // patched files (copies of the local-clone edits in ebremer/Halcyon) to
      // make the lws-net cell work against the plain remote tree. Remove once
      // the patch is merged upstream.
      const patch = dag.currentModule().source().directory("halcyon/patches")
      build = build
        .withFile(
          "/src/HalcyonLWS/src/main/java/com/ebremer/lws/acp/AcpBootstrap.java",
          patch.file("AcpBootstrap.java"),
        )
        .withFile(
          "/src/HalcyonLWS/src/main/java/com/ebremer/lws/config/LwsSettings.java",
          patch.file("LwsSettings.java"),
        )
    }
    return build.withExec([
      "sh",
      "-c",
      // The Halcyon reactor resolves its first-party artifacts (BeakGraph,
      // vandegraph, cygnus, ...) from the private Nexus cursus.bmi
      // .stonybrookmedicine.edu, whose reads are anonymous. Under request
      // pressure it answers 403 — Halcyon's own CI documents this (M28: "a cold
      // full download is itself a failure mode") and mitigates with a warm
      // ~/.m2, which a dagger CI run does not have. Retry with backoff: each
      // attempt resumes from the same local repo, so downloaded artifacts carry
      // over and the rate-limited window passes.
      "mkdir -p /opt && " +
        "for i in 1 2 3 4 5; do " +
        "if mvn -q -B -ntp -Daether.connector.basic.connectTimeout=60000 " +
        "-Dmaven.test.skip=true -pl Halcyon -am package; then " +
        "cp Halcyon/target/Halcyon-*.jar /opt/halcyon.jar && exit 0; fi; " +
        'echo "halcyon maven build failed (attempt $i of 5); retrying in $((i * 30))s"; ' +
        "sleep $((i * 30)); done; exit 1",
    ])
  }

  @func()
  sparqService(source?: Directory): Service {
    const build = dag
      .container()
      .from("rust:1.97-slim-bookworm")
      .withMountedCache("/usr/local/cargo/registry", dag.cacheVolume("sparq-registry"))
      .withMountedCache("/build/target", dag.cacheVolume("sparq-target"))
      .withDirectory("/build", this.sparqSource(source))
      .withWorkdir("/build")
      // dagger materializes git trees with deterministic mtimes and cargo
      // fingerprints sources by mtime, so a changed branch would silently skip
      // recompiling. Touch the crate sources to force a rebuild.
      .withExec(["sh", "-c", "touch crates/sparq-lws-core/src/*.rs"])
      .withExec(["cargo", "build", "-p", "sparq-lws-core"])
    return build
      .withExposedPort(3000)
      .withEnvVariable("SOLID_SERVER_BIND", "0.0.0.0:3000")
      .withEnvVariable("SOLID_SERVER_BASE_URL", "http://sparq:3000")
      .withEnvVariable("SOLID_SERVER_OPEN_MODE", "1")
      .asService({ args: ["/build/target/debug/sparq-lws-core"] })
      .withHostname("sparq")
  }
}
