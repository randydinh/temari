# Local PDF text capture on macOS

**Audience:** the operator of a dedicated Temari Knowledge installation on an
Apple silicon Mac. This is an opt-in first unit. A Mac without this profile
continues to preserve PDF originals and report
`pdf-memory-boundary-unavailable` for their text representation.

## Before you begin

- Use a dedicated, local [Lima](https://lima-vm.io/docs/installation/) 2.2.0
  aarch64 VM with the `vz` driver, `plain: true`, and no host mounts. The
  verified host used the Alpine 3.22.4 image pinned by SHA-512 in Lima's
  `alpine-3.22` template. Do not use a VM that holds other private work.
- The guest needs Python 3.12, `pypdf==6.17.0`, `PyYAML==6.0.3`, and cgroup v2
  mounted at `/sys/fs/cgroup` with the memory controller available. The
  Registrar copies its current parser source into each guest job; the guest
  environment is never a source of archive authority.
- The operator controls a JSON profile file with mode `0600`. It contains no
  API key. Temari uses the direct TypeSafe Keychain credential only on the
  separately admitted Jev path; PDF extraction makes no hosted-model call.
- Register the source first. Mark it local-only when its content must not be
  sent to TypeSafe. The PDF worker itself runs locally for either setting.

The verified VM was started with `limactl start --yes --name temari-pdf
--vm-type vz --memory 2 --disk 10 --cpus 2 --plain template:alpine-3.22`.
The exact image digest must be checked in `limactl list --json temari-pdf`
before recording the profile. On Alpine, mount cgroup v2 after a VM reboot if
`/sys/fs/cgroup/cgroup.controllers` is absent:

```sh
limactl shell --tty=false temari-pdf -- sudo mount -t cgroup2 none /sys/fs/cgroup
```

The worker refuses a missing controller, a nonzero swap allowance, any host
mount, a wrong image or interpreter hash, a wrong `pypdf` version, or a
missing network namespace. It never retries an unsafe PDF on the native Mac
parser.

## Create the local profile

Use absolute paths from this host. Derive the binary hash with
`shasum -a 256 /absolute/path/to/limactl`, the guest interpreter hash with
`limactl shell --tty=false temari-pdf -- sha256sum /absolute/guest/python`, and
the aarch64 image digest from `limactl list --json temari-pdf`. Store this
shape in a regular JSON file owned by your macOS account and run `chmod 600`
on it:

```json
{
  "schema": 1,
  "backend": "lima-cgroup-v2-v1",
  "limactl": "/absolute/path/to/limactl",
  "limactl_sha256": "<64 lowercase hex characters>",
  "lima_home": "/absolute/path/to/lima-home",
  "instance": "temari-pdf",
  "image_digest": "sha512:<128 lowercase hex characters>",
  "guest_python": "/absolute/guest/python",
  "guest_python_sha256": "<64 lowercase hex characters>"
}
```

The profile pins the expected guest interpreter file and `pypdf` version.
It does not attest every byte of the installed Python packages. Rebuild the
profile after an intentional VM or dependency upgrade, and use a new archive
request key; an old key cannot silently replay with different settings.

## Capture and verify

Pass the profile to the Registrar CLI's `archive capture` command with
`--pdf-worker-profile /absolute/path/to/profile.json`. Temari's
`captureArchive` accepts the same path as `pdfWorkerProfilePath`; it pins the
raw profile SHA-256 in the immutable capture binding and sends that hash to
Registrar. This first unit admits at most 32 entries and extracts at most
eight PDFs in one opted-in source capture. Later PDFs keep originals with an
explicit limit gap. Capture is synchronous and can hold the Registrar
writer lock for several minutes. Use a small dedicated document source.

Inspect the published generation. A searchable PDF has an exact original
hash and a `pdf-text` representation. A blank or image-only PDF keeps the
original and reports `pdf-no-extractable-text`; visual meaning and embedded
assets remain explicit gaps. Verify the original through the archive's
`recover` operation and read the text through its pinned `read` operation.
The local Mac smoke tested a synthetic searchable and blank PDF, replay,
profile conflict, wrong-image refusal, and original recovery. It does not
establish scanned-document OCR or arbitrary PDF quality.

## Recovery

If a valid profile points to an unavailable VM or boundary, capture retains
originals and records a PDF worker gap. A malformed profile is refused before
capture. If the VM disappears during a job, a detached guest watchdog is
expected to remove the private guest copy after 45 seconds when the guest is
still running; the capture does not publish unverified PDF text.

An abrupt failure before that watchdog starts can leave an empty root-owned
job marker. New jobs then refuse with `pdf-worker-busy-or-stale-job`. After
confirming that no capture is active, stop and start the dedicated VM to
clear its tmpfs and cgroup state, remount cgroup v2 if needed, and retry with
a new request key. Never delete a marker while a capture may be active.

This path has been verified only on the tested Apple silicon Mac and its
dedicated local VM. It is not a default installer feature or Windows proof.
