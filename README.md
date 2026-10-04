# dagger-workspace

Dagger module for running the LWS conformance test suites against LWS
implementations:

- harnesses: [Touchstone](https://github.com/ebremer/touchstone) (default) and
  [LWS.net](https://github.com/langsamu/LWS.net) (`--harness lws-net`)
- servers: [lws-server](https://github.com/ebremer/lws-server) (default),
  [sparq](https://github.com/sparq-org/sparq) (`--server sparq`),
  [Halcyon](https://github.com/halcyon-project/Halcyon) (`--server halcyon`, the
  `next` branch; see [Notes on Halcyon](#notes-on-halcyon)) and
  [CommunitySolidServer](https://github.com/jeswr/CommunitySolidServer)
  (`--server css`, the `feat/lws` branch; see
  [Notes on CommunitySolidServer](#notes-on-communitysolidserver))

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
dagger call test --harness touchstone --server halcyon
dagger call test --harness lws-net --server halcyon
dagger call test --harness touchstone --server css
dagger call test --harness lws-net --server css
dagger call test --harness rules --server css

# css uses the default remote source (jeswr/CommunitySolidServer, feat/lws); a
# local checkout tests uncommitted changes:
dagger call test --harness touchstone --server css --source ../CommunitySolidServer

# force a local copy of the tests with a relative path
dagger call test --harness lws-net --server lws-server --tests ../lws-test-suite/lws10
```

Expose a service to the host:

```sh
dagger call lws-server-service up --ports 8080:8080
dagger call sparq-service up --ports 3000:3000
dagger call halcyon-service up --ports 8888:8888
dagger call css-service up --ports 3000:3000
```

## Notes on Halcyon

Halcyon targets the `next` branch of
[halcyon-project/Halcyon](https://github.com/halcyon-project/Halcyon) and enforces
authentication (ACP): every storage needs a `:LWSOwner` and anonymous is never
granted. The two harness cells therefore boot the server in different postures:

- **touchstone** — closed, with owner credentials. A minimal in-container OIDC
  fixture wires Halcyon's native `lws10-authn-openid` suite (WebID CIDs +
  discovery + JWKS served on the container's loopback, `lws-oidc.json`
  allow-listing it, and ES256 ID tokens for `alice` and `bob` minted at
  graph-build time). Touchstone reads them from the target registry as
  `token.alice`/`token.bob`/`webid.*` properties, and the seeded root ACR
  grants `alice` full control as owner.
- **lws-net** — DEV-ONLY open mode, since that harness sends no `Authorization`
  header. The module boots Halcyon with `:LWSOpenMode true`, the analogue of
  sparq's `SOLID_SERVER_OPEN_MODE` dev seed (which lives on the repo's
  `feat/open-mode` branch): the seeded root ACR additionally grants the
  **public agent** Read/Write/Append/Control on the root and every descendant,
  so anonymous requests can provision and write. Until `:LWSOpenMode` lands
  upstream, the module overlays the two patched Halcyon files
  (`.dagger/halcyon/patches/`, copies of the edits in `ebremer/Halcyon`) onto
  the source at build time; once merged, the overlay can be deleted. One more
  thing differs for that cell: the lws-net suite resolves the storage root as
  the **site root** (`GET {baseUri}/`), which is true for lws-server/sparq but
  not for a storage mounted at a path, so the module rewrites that relative
  root to `""` for Halcyon — the request then resolves to the storage root
  itself, which serves the description.

Whether a cell is green is a conformance question and expected to move; the
`lws-net x sparq` cell is red for reference.

`dagger call test --server halcyon --source ../ebremer/Halcyon` runs the local
checkout (any branch), which is how uncommitted changes are tested. On CI (and
anywhere `--source` is absent) the Halcyon cells build from a GitHub repo
instead: `--halcyon-repo` (default `halcyon-project/Halcyon`) and `--halcyon-ref`
(default `next`) select the branch, e.g. `--halcyon-repo elf-pavlik/Halcyon
--halcyon-ref open-mode` for a fork containing the patch.

## Notes on CommunitySolidServer

CommunitySolidServer targets the `feat/lws` branch of
[jeswr/CommunitySolidServer](https://github.com/jeswr/CommunitySolidServer) (the
LWS protocol fork of the CommunitySolidServer project; the local checkout
matches this module's default source). Unlike the other cells it never needs
credentials of any kind: the module overlays its own no-auth config
(`.dagger/css/lws-no-auth.json`) onto the source as `config/lws-no-auth.json`,
which boots an **LWS-only** server with **authorization disabled entirely**
(`ldp/authorization/allow-all.json`) and a **single storage rooted at the base
URL** (`storage/location/root.json` with the static pod manager) — so every
harness points straight at `http://css:3000/` with nothing else to configure.
No accounts/IDP and no static root page are enabled on purpose:
`app/init/default.json` (not `static-root.json`) keeps `GET /` serving the
storage description, which the harnesses require (`static-root` would shadow it
with the HTML welcome page).

Touchstone's core derives `$\{identity.bob.webid}` from the target registry,
so the cell passes static `webid.alice`/`webid.bob` properties (plain IRIs).
`token.*` is deliberately absent: with no `Authentication` capability in the
target, the `as:` identities send no `Authorization` header and every
authz/fault test is inapplicable rather than red.

`dagger call test --server css --source ../CommunitySolidServer` runs a local
checkout. On CI (and anywhere `--source` is absent) the css cells build from
GitHub instead: `--css-repo` (default `jeswr/CommunitySolidServer`) and
`--css-ref` (default `feat/lws`) select the fork/branch.

## GitHub Actions

[`.github/workflows/dagger.yml`](.github/workflows/dagger.yml) runs the
conformance suites in CI with the `dagger/dagger-for-github@v8.3.0` action
(engine v0.21.9):

- runs on every push, and manually via **workflow_dispatch**
- executes a 2×4 matrix: `touchstone`/`lws-net` ×
  `lws-server`/`sparq`/`halcyon`/`css`, each cell passing or failing
  independently (`fail-fast: false`); the halcyon and `lws-net x sparq` cells
  are expected red (see [Notes on Halcyon](#notes-on-halcyon)) and can be
  dropped with the commented-out `exclude` block
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

Manual runs can also steer the Halcyon and CommunitySolidServer cells (ignored
for the other servers):

- `halcyon_repo` — the GitHub repo to build Halcyon from (default
  `halcyon-project/Halcyon`, e.g. a fork or patch branch)
- `halcyon_ref` — branch/ref of `halcyon_repo` (default `next`)
- `css_repo` — the GitHub repo to build CommunitySolidServer from (default
  `jeswr/CommunitySolidServer`, e.g. a fork or patch branch)
- `css_ref` — branch/ref of `css_repo` (default `feat/lws`)