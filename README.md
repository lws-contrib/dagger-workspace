# dagger-workspace

Dagger module for running the LWS conformance test suites against LWS
implementations:

- harnesses: [Touchstone](https://github.com/ebremer/touchstone) (default) and
  [LWS.net](https://github.com/langsamu/LWS.net) (`--harness lws-net`)
- servers: [lws-server](https://github.com/ebremer/lws-server) (default) and
  [sparq](https://github.com/sparq-org/sparq) (`--server sparq`)

The canonical `lws10/` test manifests used by the LWS.net harness come from
git HEAD of [lws-contrib/lws-test-suite](https://github.com/lws-contrib/lws-test-suite)
by default. To force use of a local copy, pass a relative path to it via
`--manifests` (e.g. a checkout of the lws-test-suite repo).

## Usage

```sh
dagger call test --harness touchstone --server lws-server
dagger call test --harness lws-net --server lws-server
dagger call test --harness touchstone --server sparq
dagger call test --harness lws-net --server sparq

# force a local copy of the manifests with a relative path
dagger call test --harness lws-net --server lws-server --manifests ../lws-test-suite/lws10
```

Expose a service to the host:

```sh
dagger call lws-server-service up --ports 8080:8080
dagger call sparq-service up --ports 3000:3000
```