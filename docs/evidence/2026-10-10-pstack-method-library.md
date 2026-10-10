# Complete P-stack method in the public Temari package

The current public packager now carries the complete portable P-stack inventory
behind the existing public entries. The internal `method/pstack/` tree has 216
allowlisted source files plus its provenance and generated catalog. It contains
53 skill entries, including 23 principles, 24 playbooks and three agents. Root
discovery remains the existing six public skills, and public policy bytes are
unchanged.

The design uses the existing portable provenance allowlist rather than recursive
copying or a Markdown-only dependency closure. Recursive copying would include
local dependencies. A link-only closure would miss skills and principles named
in prose. The inventory and catalog encode the method's shape; direct relocated
checks establish that recipients receive the actual resources.

The public loading guide puts policy and source scope before host mapping,
selected playbook, needed helpers and relevant principles. Historical adapters,
installers, receipts and Orchestrate storage remain method references. They do
not replace the canonical runtime or admit additional routes. A checkout-specific
plan checker command now uses an explicit installed method root, and original
source-layout skeleton paths are labeled as template inputs.

## Change impact and verification

| Outcome | Changed risk and existing proof | Level and required evidence | Observed result |
| --- | --- | --- | --- |
| Complete method after packaging and relocation | Filesystem membership, mode and source provenance. Existing outer manifest and relocation tests provide the integrity boundary. | Focused integration. Compare every portable member, reconstruct the catalog, reject missing/extra files and directories, altered bytes, symlinks, mode drift and broken references. | Passed in unit and relocated public-entry tests. |
| Predictable resource loading through current entries | Public skill references and host interpretation. Existing conversation/QA reference traversal covers the public guidance chain. | Focused integration. Reach the method guide, catalog, host mapping, helper skills and principle leaves from each engineering entry; validate skill frontmatter. | Passed. An installed-only independent navigation exercise found no blocker for a provisional feature request. |
| Trusted startup and resume retain current policy | Shared public artifact validation now also checks method metadata and executable modes before request intake. Existing feature, QA, resume and closeout tests exercise the consumers. | Broader regression within the public-entry surface. Run its complete test set, including required host proof, unsupported routes, persisted stages and negative closeout cases. | 18 focused tests and 58 complementary tests passed, including six library unit tests. No selected tests failed or were cancelled. |
| Standalone Knowledge packaging stays narrow | Knowledge packaging consumes the changed public packager, then selects its own files. | Smoke. Check the standalone inventory and payload with the existing packaging test. | One packaging smoke test passed. |

Two uncached Nx public-entry invocations covered complementary name selections:
the feature, relocation, admission and closeout selection passed 18 tests; the
remaining selection, including all method unit tests, passed 58. Together they
covered 76 tests. The retained local `remaining-tests.log` contains the second
run; the first run's result was observed in the host terminal. A separate
Knowledge packaging smoke passed one test. All changed public skill frontmatter
checks and `git diff --check` passed. The P-stack graph was regenerated.

The tested development artifact has 486 inventoried files. Its outer manifest
SHA-256 is `2747afa84965f22be452f3dd9e3a87756a88cb1003c219f60e47d3c125b6231b`.
The artifact records source HEAD `255b46865b434252d9e97adcb15d72ce72ceaf15`
with `dirty: true`; it is local development evidence, not a clean release.
`public-package` and `public-check` both completed through Nx, and the check
passed after copying the artifact to a new location. The local task's selection
file retains the exact artifact location, manifest digest and method digests.

The source workspace's inherited `workflow-runtime:check` prerequisite refused
pre-existing `skills/poteto-mode/scripts/node_modules/.bin/tsc` in the vendored
asset tree. Those local dependencies were preserved and excluded by the new
allowlist packager. This source-tree gate is not reported as passed.

## Review, limits and next action

Independent source review found no blocking defect. Its defensive residual is
that source reads verify the supplied asset root and its descendants, while
ancestors above that trust root can include symlinks. Exact inventory hashes and
modes still govern accepted bytes. The independent installed-only exercise read
only the relocated artifact and could reach the method resources, distinguish
lightweight from full feature work and retain missing-candidate/host-proof gaps.
It did not execute an application or establish canonical feature admission.

Required packaging and public-entry checks are satisfied. Additional native
Windows installation and a real application journey are separate promotion
evidence. Host tools, external companion dependencies, global model configuration,
runtime admission, private overlays and active plugin installation were not
changed. No Temari completion receipt or task acceptance is claimed by this
implementation handoff.

The recommended next increment is a single tested marketplace installation and
upgrade path using a clean release artifact. Extend playbook execution admission
after that, one contract and real host journey at a time.
