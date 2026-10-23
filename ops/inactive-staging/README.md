# Inactive artifact staging

Local proposed missing transfer step only. No network connection or host action has been performed. This is not deployment acceptance and does not generate an exclusion receipt, host plan, runtime manifest, owner evidence or approval.

## Exact bounded operation

`stage_artifact.py` receives a previously reviewed uncompressed USTAR archive and a separately SHA256-pinned JSON manifest. Only files named in that manifest may be copied. Regular files have exact size, SHA256 and 0644/0755 mode. Explicit relative dependency links must resolve directly to a manifest-listed regular file inside the same root; directory links, chains, absolute/escaping links, hardlinks, special objects, duplicate entries, extension headers, traversal and unknown entries fail. Limits: 2 GiB archive, 4 GiB declared expanded bytes, 512 MiB per file, 100,000 filesystem objects including implicit parent directories, 32 MiB manifest. USTAR header scanning rejects extensions before tarfile can allocate their payloads.

The production CLI requires root and pre-existing root-controlled, non-group/world-writable ancestry. It accepts only release or package destination roots already created by the separately approved gate installer:
- /var/lib/bubblewash-release/releases/<40-or-64-hex-name>
- /var/lib/bubblewash-release/packages/<40-or-64-hex-name>

It reserves a NEW directory exclusively at 0700, copies only verified content with exclusive no-follow file creation, checks the complete resulting tree, fsyncs, then makes that new root 0755. It never overwrites, renames over or adopts an existing/partial target. Partial destinations remain protected and retained for explicit inspection; no automatic removal/retry. Newly created internal directories are explicitly normalized to 0755 independent of umask. Obvious root data/backups trees and exact live .env files are rejected, while .env.production.example remains permitted. This is not a general secret scanner: the final exact artifact review must exclude credentials and private runtime data. No recursive chown, dependency install, code execution from the archive, service lifecycle, current-pointer mutation, DB/config access, receipt creation or credentials.

A successful result means only inactive bytes match the reviewed transfer manifest. Existing integration `verify_source`, `runtime_manifest`, `dependency_manifest`, real Git bindings, runtime traces/image checks, owner compatibility and `materialize_plan.py` still must accept the staged artifact before any selection. This avoids copying their release rules into another framework. The exact packaging manifest and archive must come from the reviewed final assembly; this tool does not bless arbitrary inputs or generate release pins.

## Existing transport

`emit_command.py` only prints a source-SHA-pinned Python receiver command; it never connects. With `--stream --archive`, it emits an eight-byte big-endian manifest length, exact manifest bytes, then exact verified archive bytes to stdout. The same arguments bind source digest, manifest digest, kind and new target name. The receiver compiles only those pinned source bytes in memory; no host-imported module/cache code is used. Source/manifest metadata are not secrets. The generated command contains no host facts or archive contents.

After explicit review/approval, the existing tailnet SSH stdin route can carry that binary stream to the printed receiver command at the approved existing host. No such invocation occurred here. Receiver saves the incoming archive to a new root-owned 0600 `.incoming-*.tar` file under the chosen base, bounded while streaming. It retains this file on success or failure for explicit recoverable cleanup. This temporary copy must be included in the disk budget alongside extraction, both runtimes and backup. Fixed output reports only success/count/digest or a generic inspect-before-retry failure; raw paths, accounts, exceptions and credentials are not emitted.

An interrupted write/connection has uncertain outcome: inspect the new target and incoming artifact before any retry. Existing destinations are always refused. Even success does not authorize runtime selection. No absolute exclusion claim against an uncoordinated privileged actor is made.

## Manifest shape

Schema is `bubblewash-inactive-artifact/v1`, with `archiveSha256` and `files`. Each relative file entry is `{type: file, size: integer, mode: 420 or 493, sha256: 64 lowercase hex}`; each permitted link is `{type: link, target: relative string}`. Duplicate JSON keys are refused. The manifest itself is pinned by an externally supplied SHA256, not trusted from inside the archive.

## Local verification

Run `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s . -p test_stage.py -v`.
Tests cover exact content, repeated/existing targets, malformed paths, duplicate entries/JSON, dangerous links/special objects, hash mismatches, retained interrupted extraction, archive symlink rejection, byte limits, unsafe ancestry, parent/file collisions, extension headers and offline transport framing. The emitted receiver is exercised locally as an unprivileged process and must reject before host writes. Real root/systemd/SSH operation is not claimed.

Independent review and exact package pinning are required before use. No source publication or host installation permission is implied by this local implementation.
