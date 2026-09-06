# Vendored LDtk schema

`schema.json` is the unmodified official [LDtk 1.5.3 JSON schema](https://raw.githubusercontent.com/deepnight/ldtk/v1.5.3/docs/JSON_SCHEMA.json), downloaded on 2026-09-06. SHA-256: `b96ca8a106d12c5bf8aa42da223a4ceb02e93dcfbb0d1b49fbbaeb9959264bda`. The [LDtk JSON documentation](https://ldtk.io/json/) identifies 1.5.3 as its documented JSON version. The adjacent MIT license is copied from the same release tag.

The compiler validates this full schema with Ajv 8.20.0 before applying Edgefall invariants. Ajv's bundled draft-07 meta-schema uses an HTTP identifier, so an HTTPS alias resolves the official schema's declaration locally. Strict keyword mode is disabled for the official editor metadata containers; coercion, defaults, field removal and asynchronous remote schema loading are not enabled. This does not disable instance validation.

Update the editor schema only with an explicit compiler compatibility change and fresh positive/negative fixtures. Do not reformat the vendored source: its byte identity is recorded above. This is a build-time dependency and must not enter runtime bundles.
