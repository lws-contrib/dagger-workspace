# dagger-workspace

Dagger module for running the LWS conformance test suites against LWS
implementations:

- harnesses: [Touchstone](https://github.com/ebremer/touchstone) (default) and
  [LWS.net](https://github.com/langsamu/LWS.net) (`--harness lws-net`)
- servers: [lws-server](https://github.com/ebremer/lws-server) (default) and
  [sparq](https://github.com/sparq-org/sparq) (`--server sparq`)

The LWS.net harness uses the YAML-LD suite definition `tests.yaml` from the
`yaml` branch of [elf-pavlik/lws-test-suite](https://github.com/elf-pavlik/lws-test-suite)
by default, converted to N-Triples and mounted as the harness's fixed
`new.ttl` resource (see the `bun run ttl2yaml` / `bun run yaml2ttl` scripts
in this workspace). To force use of a local copy, pass a relative path to it
via `--tests` (e.g. a checkout of the lws-test-suite repo).

## Usage

```sh
dagger call test --harness touchstone --server lws-server
dagger call test --harness lws-net --server lws-server
dagger call test --harness touchstone --server sparq
dagger call test --harness lws-net --server sparq

# force a local copy of the tests with a relative path
dagger call test --harness lws-net --server lws-server --tests ../lws-test-suite/lws10
```

Expose a service to the host:

```sh
dagger call lws-server-service up --ports 8080:8080
dagger call sparq-service up --ports 3000:3000
```

## GitHub Actions

[`.github/workflows/dagger.yml`](.github/workflows/dagger.yml) runs the
conformance suites in CI with the `dagger/dagger-for-github@v8.3.0` action
(engine v0.21.9):

- runs on every push, and manually via **workflow_dispatch**
- executes a 2×2 matrix: `touchstone`/`lws-net` × `lws-server`/`sparq`, each
  cell passing or failing independently (`fail-fast: false`)
- the lws-net cells default to `tests.yaml` from the `yaml` branch of
  `elf-pavlik/lws-test-suite` (converted to N-Triples `new.ttl`)

Manual (`workflow_dispatch`) runs accept an optional **local tests copy**
instead of the remote default — the lws-test-suite repo is checked out on the
runner as `./lws-test-suite` and the suites are invoked with
`--tests`:

- `tests_repo` — repo to check out (default `elf-pavlik/lws-test-suite`)
- `tests_ref` — branch/ref (default `yaml`)
- `tests_path` — relative path from the workspace root to the `lws10`
  tree, e.g. `lws-test-suite/lws10` (leave empty to use the remote default)