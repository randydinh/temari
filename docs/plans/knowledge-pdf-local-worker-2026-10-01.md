# Temari Knowledge: local bounded PDF worker

## Decision and current evidence

The current Darwin worker preserves PDF originals and reports
`pdf-memory-boundary-unavailable` because the host rejects its hard
`RLIMIT_AS` cap. That refusal remains correct until the alternative worker is
proven through the actual archive capture path.

An isolated local Lima 2.2.0 VM now runs Alpine 3.22.4 aarch64 under macOS
Virtualization. The image is pinned by the SHA-512 digest in Lima's template.
The Linux guest has cgroup v2. A 64 MiB `memory.max`, zero
`memory.swap.max`, and a 128 MiB allocation produced exit 137 and
`oom_kill=1`. The unchanged Registrar `archive_worker` extracted a synthetic
searchable PDF using `pypdf==6.17.0` inside the same cap and `unshare -n`
network namespace. Its result reported `pdf-text` plus the existing visual
and asset gaps. This proves the primitive on this host, not an integrated Mac
capture or a portable installer.

## Hypothesis and scope

An explicitly configured, local-only Linux PDF backend can let the macOS
archive CLI capture searchable PDF text without weakening the existing
native fail-closed path. The backend must copy only one admitted, byte-capped
PDF into a private guest job, run the existing extractor under a verified
cgroup memory and swap cap and a network namespace, bound wall time and
output bytes, copy the result back, and remove guest job files. The archive
capture policy and request fingerprint must identify the chosen backend and
its worker/dependency profile. Any missing boundary, version mismatch,
failed transfer, timeout, or malformed result must produce a limited
representation while preserving the original bytes.

This increment owns `packages/workflow-runtime/registrar` PDF capture and its
focused tests and operator documentation. It does not change Jev or the
registered-source/local-only policy and makes no hosted-model call. It does
not infer text for scanned pages or visual meaning for embedded images.

## Finish predicate

1. A source registered on this Mac is captured through the actual Registrar
   CLI with an explicit local Linux profile. The archived manifest binds its
   profile; a searchable PDF has an independently readable text
   representation and exact preserved original bytes.
2. A blank or image-only PDF does not claim readable text, and malformed or
   resource-exhausting input yields a visible gap. Missing VM, disabled
   cgroup, nonzero swap, network isolation failure, wrong worker/dependency
   version, and bad output refuse without a parser-only fallback.
3. A repeat with the same request key and different backend/profile refuses;
   archived originals remain readable after a backend failure.
4. Focused Registrar tests and a Mac host smoke run pass, followed by an
   independent exact-commit review and reviewable PR. No production-wide
   PDF, Windows, or lossless claim follows from this host proof.

## Throughput checkpoint

The PDF boundary and source archive policy are coupled, so one builder owns
the implementation. A read-only architect reviews the boundary before code;
an independent reviewer checks the integrated commit. The coordinator owns
the isolated worktree, source verification, decision log, and PR. The
conflicted primary checkout remains untouched.

## Verified candidate

The opt-in `lima-cgroup-v2-v1` bridge now runs through both the Registrar CLI
and Temari `captureArchive` on this Apple silicon Mac. The profile binds the
Lima binary, guest image and Python interpreter identities to the request;
the guest checks a 512 MiB cgroup memory cap, zero swap, a private network
namespace, reduced privileges, and the pinned PDF parser version. The host
copies at most one 8 MiB PDF into a private guest job after arming a detached
45-second cleanup watchdog. The Temari capture is limited to 32 entries and
eight PDF extractions per source. The default unconfigured Mac path still
retains originals and reports `pdf-memory-boundary-unavailable`.

The local smoke captured a searchable PDF, read its `pdf-text` representation,
and recovered the original bytes with the expected SHA-256. Separate host
smokes covered an image-only/blank PDF gap, same-key replay, changed-profile
refusal, wrong-image refusal, unavailable native memory boundary, and a
SIGKILL/concurrent-job cleanup path. The focused Registrar suite passed
10/10, knowledge unit tests passed 43/43, actual-Registrar integration passed
74/74 on the final code, and Nx sync was clean. Exact-commit review and a
reviewable PR are the remaining delivery checks.

This is a first searchable-PDF text unit for one tested Mac and disposable
guest. It does not claim OCR for scanned pages, visual meaning, complete guest
dependency attestation, a default installer route, Windows support, or a
production lossless knowledge system.
