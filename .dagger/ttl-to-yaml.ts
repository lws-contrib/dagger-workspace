/**
 * Convert a Turtle (.ttl) file to YAML via JSON-LD, compacted with
 * a context using @vocab: http://example.com/.
 *
 * Usage: bun ttl-to-yaml.ts <input.ttl> <output.yaml>
 */
import { readFile, writeFile } from "node:fs/promises";
import { Parser, Writer } from "n3";
import jsonld from "jsonld";
import { stringify } from "yaml";

const [, , ttlPath, yamlPath] = process.argv;

if (!ttlPath || !yamlPath) {
  console.error("Usage: bun ttl-to-yaml.ts <input.ttl> <output.yaml>");
  process.exit(1);
}

// Key order for the serialized YAML; keys not listed keep their original
// relative order after the listed ones (sortMapEntries sorts every map
// with this rank).
const KEY_ORDER = [
  "@context",
  "@vocab",
  "type",
  "name",
  "tests",
  "steps",
  "assertion",
  "request",
  "method",
  "uri",
  "base",
  "relative",
  "param",
  "value",
  "extractors",
  "path",
  "header",
];

function keyRank(key: unknown): number {
  const index = typeof key === "string" ? KEY_ORDER.indexOf(key) : -1;
  return index === -1 ? KEY_ORDER.length : index;
}

// 1. Parse Turtle into RDF quads
const ttl = await readFile(ttlPath, "utf8");
const quads = new Parser().parse(ttl);

// 2. Serialize quads as N-Quads (input required by jsonld.fromRDF)
const writer = new Writer({ format: "N-Quads" });
for (const quad of quads) writer.addQuad(quad);
const nquads = await new Promise<string>((resolve, reject) =>
  writer.end((error, result) => (error ? reject(error) : resolve(result))),
);

// 3. Convert RDF to JSON-LD (expanded form; one entry per node)
const nodes = await jsonld.fromRDF(nquads, { format: "application/n-quads" });

// 3b. Frame with an exact nested frame so only the expected keys survive
// (per-level @explicit). jsonld.js always emits @id for framed nodes, so
// blank-node @ids are stripped after compaction.
const context = {
  "@vocab": "http://example.com/",
  // RDF collections in the Turtle become plain arrays in the output
  tests: { "@container": "@list" },
  steps: { "@container": "@list" },
  extractors: { "@container": "@list" },
  // Keyword alias for @type as `type`; @type: "@id" marks the values as
  // IRIs so they compact as IRIs via @vocab (types are always IRIs).
  type: { "@id": "@type", "@type": "@id" },
};

const frame = {
  "@context": context,
  "@explicit": true, // top-level node: only name + tests
  name: {},
  tests: {
    "@explicit": true, // test: only name + steps + assertion
    name: {},
    steps: {
      "@explicit": true, // step: only request + extractors
      request: {
        "@explicit": true, // request: only method + uri
        method: {},
        uri: {}, // uri: keep base/relative/param
      },
      extractors: {}, // extractors: keep @type/param/path/header
    },
    assertion: {
      "@explicit": true, // assertion: only type (rdf:type) + param + value
      "@type": {},
      param: {},
      value: {},
    },
  },
};

const framed = await jsonld.frame(nodes, frame, {
  expandContext: context,
  embed: "@always",
});
// The top frame also matches test nodes (they share `name`); the root is
// the only entry carrying a `tests` property.
const root = (framed["@graph"] ?? [framed]).find((node) => "tests" in node);
if (!root) {
  console.error("No top-level node with `tests` found in the frame output");
  process.exit(1);
}

// Drop blank-node @id values; their content is already embedded by framing.
function stripBlankNodeIds(value: any): any {
  if (Array.isArray(value)) return value.map(stripBlankNodeIds);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "@id" && typeof val === "string" && val.startsWith("_:")) continue;
      out[key] = stripBlankNodeIds(val);
    }
    return out;
  }
  return value;
}

// 4. Compact, drop blank-node @ids, and serialize as YAML (key ordering
// is applied only here). expandContext is needed: the frame output already
// uses short (compacted) keys, and compact expands its input first.
const jsonLd = await jsonld.compact(root, context, { expandContext: context });
await writeFile(
  yamlPath,
  stringify(stripBlankNodeIds(jsonLd), {
    sortMapEntries: (a, b) => keyRank(a.key.value) - keyRank(b.key.value),
  }),
);
console.log(`Wrote ${yamlPath}`);