# Station uptime explanation evidence

Request: Explain station-report.js and compare with current Cobalt pilot policy; product unchanged.
Owner/method: Temari explanation with Knowledge source retrieval and scoped Poteto code inspection; no engineering execution profile or QA disposition.
Need: required; code and policy were not supplied.
Scope: station-report.js and registered source 2bbc01bed06a4a979f75b37af5005da3 only. Query unknown, at most 5 documents, one policy read bounded to 12000 characters. Current registered project policy required.
Observations: Read station-report.js lines 1–3. No graphify-out/graph.json exists; used direct inspection without building a graph. knowledge_discover returned cobalt-policy.md; knowledge_read returned all 590 characters with verified source bytes/spans and no gaps.
Evidence: cobalt-policy.md, revision 2026-10-09, lines 1–5 (substantive rule at line 5); source 2bbc01bed06a4a979f75b37af5005da3; generation 279187854003445e9399d537c289ef5f; SHA256 a877045c45dea76eaee4e9b3d9e284ab2463d3b6bfba53c17212ef4a225b5224. Provider checked local bytes; current authority is established by workspace instructions.
Result: retrieved. Subtraction matches the conservative numerator rule. Unknown remains a separate classification from confirmed downtime and remains eligible. The function alone cannot establish proper upstream classification, per-port inputs, maintenance exclusions, or separate reporting of unknown minutes and communication/charging metrics. No product changes or tests required for this explanation.
