# Pinned Markdown relationship pilot, 2026-10-01

## Result

An operator-run local adapter published 98 `links-to` relationships from 70
explicitly selected Markdown files in a previously captured Registrar snapshot.
Each accepted relationship cites the exact link token and a target excerpt in
the retained UTF-8 representation. It made no hosted-model call and did not
read current originals. The selected source ID, file paths, excerpts, graph
draft and private search reports remain outside Git.

The receipt recorded 184 unsupported destinations, six targets outside the
explicit path list, five unavailable target texts and one unavailable source
text. The graph contains only verified edges; those omissions prevent a claim
of complete Markdown relationship coverage.

Two selected top-three BM25 plus one-hop trials illustrate the current
boundary. In one, the graph recovered the gold document that BM25 missed
(recall 0 to 1), with two added archive excerpts verified. In another, the
graph did not recover a different gold document (0 to 0) because the bounded
one-hop policy selected other linked neighbors first. These cases were chosen
after inspecting the captured graph, so they are diagnostic examples rather
than a held-out measure of net retrieval benefit. Graph ranking remains an
experimental trial and is not the default.

## Verification and limits

The actual Registrar integration suite passed 35 tests and Temari knowledge
typecheck passed for the adapter candidate. The integration exercises exact
graph anchors, repeated link occurrences, omitted syntax, source revocation,
historical replay after live original deletion and one-hop recovery. A
directional regression ensures a `links-to` edge is traversed from the linking
document to its target, not backward as if the target linked to the source.

Only simple relative `.md` and `.markdown` inline links are interpreted.
Code, images, external URLs, fragments, query strings, encoded destinations
and unsupported syntax remain omissions. HTML `href` destinations are absent
from the current archived visible-text representation, so HTML links are not
inferred. This adapter does not establish semantic agreement, dependency,
answer quality, or native Graphify extraction. The PDF text coverage gap from
the retrieval gate remains unresolved on this macOS host.
