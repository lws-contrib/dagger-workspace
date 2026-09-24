/**
 * Dagger module for the LWS conformance workspace
 * (https://github.com/lws-contrib/dagger-workspace).
 *
 * Builds the lws-server (https://github.com/ebremer/lws-server) and sparq
 * (https://github.com/sparq-org/sparq) implementations under test and runs
 * the Touchstone (https://github.com/ebremer/touchstone) or LWS.net
 * (https://github.com/langsamu/LWS.net) conformance harnesses against them.
 *
 * The canonical lws10/ test manifests are taken from git HEAD of
 * https://github.com/lws-contrib/lws-test-suite by default. Pass a relative
 * path to a local checkout (e.g. --manifests ../lws-test-suite/lws10) to
 * force use of a local copy instead.
 */
import { dag, Container, Directory, object, func, Service } from "@dagger.io/dagger"

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
   * The canonical lws10/ manifest tree: git HEAD of the canonical
   * https://github.com/lws-contrib/lws-test-suite repo by default, or a local
   * copy when an explicit Directory is passed (e.g. a relative path to a
   * checkout of the lws-test-suite repo). Never the stale copy embedded in
   * the LWS.net repo.
   */
  private lws10Manifests(manifests?: Directory): Directory {
    return (
      manifests ??
      dag.git("https://github.com/lws-contrib/lws-test-suite").head().tree().directory("lws10")
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
    touchstone?: Directory,
  ): Promise<string> {
    return this.touchstoneImage(touchstone)
      .withServiceBinding(alias, server)
      .withNewFile(
        "/work/targets.yaml",
        "targets:\n" +
          "  sut:\n" +
          `    baseUrl: ${baseUrl}\n` +
          "    adapter: env\n",
      )
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
    source?: Directory,
  ): { service: Service; host: string; baseUrl: string } {
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
    throw new Error(`unknown server: ${server} (expected lws-server or sparq)`)
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
   *
   * The lws-net harness uses the canonical manifests from git HEAD of
   * https://github.com/lws-contrib/lws-test-suite by default; force a local
   * copy by passing a relative path:
   *   dagger call test --harness lws-net --server lws-server --manifests ../lws-test-suite/lws10
   */
  @func()
  async test(
    // The suite harness: "touchstone" (default) or "lws-net".
    harness: string = "touchstone",
    // The implementation under test: "lws-server" (default) or "sparq".
    server: string = "lws-server",
    // Override the implementation source (local checkout of the server).
    source?: Directory,
    // Override the harness source (touchstone / LWS.net repo checkout).
    suite?: Directory,
    // Override the lws10 manifest tree (default: git HEAD of
    // https://github.com/lws-contrib/lws-test-suite). Pass a relative path to
    // a local checkout (e.g. ../lws-test-suite/lws10) to force a local copy.
    // Only the lws-net harness consumes these today; touchstone still vendors
    // its own definitions/ and will pick this up in a future change.
    manifests?: Directory,
  ): Promise<string> {
    const { service, host, baseUrl } = this.sut(server, source)
    if (harness === "touchstone") {
      return this.touchstoneRun(service, host, baseUrl, suite)
    }
    if (harness === "lws-net") {
      return this.lwsNetSuite(suite, manifests)
        .withServiceBinding(host, service)
        .withEnvVariable("Suite__BaseUri", baseUrl)
        .withExec(["dotnet", "test", "Suite/Test"])
        .stdout()
    }
    throw new Error(`unknown harness: ${harness} (expected touchstone or lws-net)`)
  }

  /**
   * Builds the LWS.net suite container with NON-stale manifests: the canonical
   * lws10/ tree (git HEAD of https://github.com/lws-contrib/lws-test-suite, or
   * an explicitly passed local copy) is copied into the suite's embedded
   * Resources before compilation (dash -> underscore, the mapping Resources.cs
   * applies at lookup), so the stale copy checked into the LWS.net repo can
   * never be used.
   */
  private lwsNetSuite(suite?: Directory, manifests?: Directory): Container {
    const manifestsSync =
      "set -e; " +
      "rm -rf /src/Suite/Model/Resources; " +
      "mkdir -p /src/Suite/Model/Resources; " +
      "cp -r /manifests/containers /manifests/context.jsonld /manifests/linksets " +
      "/manifests/manifest.jsonld /manifests/resources /manifests/mnt " +
      "/src/Suite/Model/Resources/; " +
      // The canonical root manifest includes auth/*/manifest.jsonld files that
      // do not exist yet in lws10 (the generated auth manifests live under
      // mnt/user-data/outputs/lws-tests/...); relink those includes, exactly
      // like the suite's own vendored copy did (content stays canonical).
      "sed -E -i '" +
      "s#\"auth/(did[-_]key|oidc|saml)/manifest.jsonld\"#" +
      "\"mnt/user-data/outputs/lws-tests/auth/\\1/manifest.jsonld\"#g' " +
      "/src/Suite/Model/Resources/manifest.jsonld; " +
      "find /src/Suite/Model/Resources -depth -name '*-*' | while read -r p; do " +
      "  mv \"$p\" \"$(dirname \"$p\")/$(basename \"$p\" | tr - _)\"; done"
    return dag
      .container()
      .from("mcr.microsoft.com/dotnet/sdk:10.0")
      .withDirectory("/src", this.lwsNetSource(suite))
      .withDirectory("/manifests", this.lws10Manifests(manifests))
      .withWorkdir("/src")
      .withExec(["sh", "-c", manifestsSync])
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
