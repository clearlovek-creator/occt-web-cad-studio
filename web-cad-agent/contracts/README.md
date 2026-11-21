# Gateway contracts

`command-batches.v1.schema.json` defines the public `POST /api/command-batches` request accepted by the sibling Gateway. A batch is single-document and is committed under one document lock. `baseRevision` is checked before the first step; each step receives the previous step's revision. A step may reference a prior result with `{"$ref":"step-id.bodyId"}`. Any failure rolls the document back and returns `BATCH_ROLLED_BACK`; replaying only part of a batch returns `IDEMPOTENCY_PARTIAL`.

`spatial-query.v1.schema.json` freezes the current Gateway query semantics: millimetres, global coordinates, Revision-bound AABB/center/size, OCCT-exact OBB when the Worker provides it (with an explicit `aabb-derived` fallback), variables/coordinate systems/materials/history views, and explicitly approximate `bounds-overlap` relations.

`geometry-relation.v1.schema.json` defines the direct `geometry.relation` read result. When the OCCT Worker is available it reports exact BRep distance/intersection provenance (`source: occt-brep`, `exact: true`); deterministic test/fallback adapters are explicitly marked `aabb-derived` and `exact: false`.
