"""Owner-only local runtime files for the POSIX benchmark launcher."""

from __future__ import annotations

import os
import secrets
import stat
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def private_directory(path: Path):
    """Hold the verified directory open so child operations cannot follow a swap."""
    if os.name != "posix":
        raise RuntimeError(
            "Benchmark credentials require a POSIX filesystem with owner-only "
            "permissions. Run on macOS/Linux; Windows permission bits are insufficient."
        )
    path.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.fstat(fd).st_uid != os.getuid():
            raise PermissionError("Benchmark state directory belongs to another user")
        os.fchmod(fd, 0o700)
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o700:
            raise PermissionError("Filesystem cannot enforce private benchmark state")
        yield fd
    finally:
        os.close(fd)


def _open_existing(directory: int, name: str) -> int | None:
    try:
        fd = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.getuid()
        ):
            raise PermissionError("Benchmark credentials require an owned regular file")
        os.fchmod(fd, 0o600)
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o600:
            raise PermissionError("Filesystem cannot enforce private credential files")
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_private(path: Path) -> str | None:
    with private_directory(path.parent) as directory:
        fd = _open_existing(directory, path.name)
        if fd is None:
            return None
        with os.fdopen(fd, encoding="utf-8") as stream:
            return stream.read()


def write_private(path: Path, text: str) -> None:
    """Replace a credential file atomically, without exposing partial or broad files."""
    with private_directory(path.parent) as directory:
        existing = _open_existing(directory, path.name)
        if existing is not None:
            os.close(existing)
        temporary = f".{path.name}.{secrets.token_hex(12)}.tmp"
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                if stat.S_IMODE(os.fstat(stream.fileno()).st_mode) != 0o600:
                    raise PermissionError("Filesystem cannot enforce private files")
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
