"""Unpack a fork preview's artifact, which is untrusted: the fork's own run produced it.

Usage: unpack-artifact.py <artifact.zip> <dest>

Accepts only `pr`, `sha` and regular files under `site/`. Anything else — an absolute
path, `..`, a symlink, a `.git` entry, too many or too large files — rejects the whole
artifact rather than skipping the entry, so nothing half-checked gets published.
"""

import os
import stat
import sys
import zipfile
from pathlib import PurePosixPath

MAX_FILES = 5000
MAX_TOTAL_BYTES = 200 * 1024 * 1024
CHUNK = 1024 * 1024


class Rejected(Exception):
    pass


def safe_parts(name: str, is_dir: bool = False) -> tuple[str, ...]:
    if not name or "\\" in name or "\0" in name or name.startswith("/"):
        raise Rejected(f"bad path: {name!r}")
    parts = PurePosixPath(name).parts
    for part in parts:
        if part in ("", ".", "..") or part.lower().startswith(".git"):
            raise Rejected(f"bad path: {name!r}")
    under_site = parts[0] == "site" and (is_dir or len(parts) >= 2)
    if parts not in (("pr",), ("sha",)) and not under_site:
        raise Rejected(f"unexpected entry: {name!r}")
    return parts


def check_entry(info: zipfile.ZipInfo) -> tuple[str, ...] | None:
    """The entry's path parts, or None for a directory entry."""
    # Zip writers often store permission bits without a file type; only a type that is
    # present and not "regular" is refused.
    kind = stat.S_IFMT(info.external_attr >> 16)
    if kind == stat.S_IFLNK:
        raise Rejected(f"symlink: {info.filename!r}")
    if info.is_dir():
        safe_parts(info.filename.rstrip("/"), is_dir=True)
        return None
    if kind not in (0, stat.S_IFREG):
        raise Rejected(f"not a regular file: {info.filename!r}")
    return safe_parts(info.filename)


def extract(zip_path: str, dest: str) -> None:
    os.makedirs(dest)
    root = os.path.realpath(dest)
    with zipfile.ZipFile(zip_path) as archive:
        entries = [(info, check_entry(info)) for info in archive.infolist()]
        files = [(info, parts) for info, parts in entries if parts is not None]
        if len(files) > MAX_FILES:
            raise Rejected(f"{len(files)} files, limit {MAX_FILES}")

        # Counted while reading, not from the header, which the archive's author wrote.
        total = 0
        for info, parts in files:
            target = os.path.join(root, *parts)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if not os.path.realpath(target).startswith(root + os.sep):
                raise Rejected(f"escapes the destination: {info.filename!r}")
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, "wb") as out, archive.open(info) as src:
                while chunk := src.read(CHUNK):
                    total += len(chunk)
                    if total > MAX_TOTAL_BYTES:
                        raise Rejected(f"more than {MAX_TOTAL_BYTES} bytes unpacked")
                    out.write(chunk)

    for required in ("pr", "sha", os.path.join("site", "index.html")):
        if not os.path.isfile(os.path.join(root, required)):
            raise Rejected(f"missing {required}")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        extract(sys.argv[1], sys.argv[2])
    except (Rejected, zipfile.BadZipFile, OSError) as err:
        print(f"artifact rejected: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
