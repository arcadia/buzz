"""Runtime credentials stay private across reuse, linked paths, and failed writes."""

import os
import stat
from types import SimpleNamespace

import pytest

from harbor_buzz_testbed import private_state

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX filesystem boundary")


@posix_only
def test_private_state_repairs_reused_permissions_and_replaces_atomically(tmp_path):
    directory = tmp_path / ".benchmark"
    path = directory / "state.json"
    private_state.write_private(path, "first")
    assert private_state.read_private(path) == "first"
    directory.chmod(0o777)
    path.chmod(0o666)
    assert private_state.read_private(path) == "first"
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    original_inode = path.stat().st_ino
    private_state.write_private(path, "second")
    assert private_state.read_private(path) == "second"
    assert path.stat().st_ino != original_inode
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(directory.iterdir()) == [path]


@posix_only
@pytest.mark.parametrize("kind", ["symlink", "hardlink", "fifo", "directory"])
@pytest.mark.parametrize("operation", ["read", "write"])
def test_private_state_rejects_indirect_or_nonregular_files(tmp_path, kind, operation):
    directory = tmp_path / ".benchmark"
    directory.mkdir()
    outside = tmp_path / "outside"
    outside.write_text("unchanged")
    outside.chmod(0o644)
    path = directory / "state.json"
    if kind == "symlink":
        path.symlink_to(outside)
    elif kind == "hardlink":
        os.link(outside, path)
    elif kind == "fifo":
        os.mkfifo(path)
    else:
        path.mkdir()
    with pytest.raises(OSError):
        if operation == "read":
            private_state.read_private(path)
        else:
            private_state.write_private(path, "replacement")
    assert outside.read_text() == "unchanged"
    assert stat.S_IMODE(outside.stat().st_mode) == 0o644


@posix_only
def test_private_state_rejects_linked_directory(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o755)
    directory = tmp_path / ".benchmark"
    directory.symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        private_state.write_private(directory / "state.json", "replacement")
    assert not list(outside.iterdir())
    assert stat.S_IMODE(outside.stat().st_mode) == 0o755


@posix_only
def test_failed_replace_keeps_previous_credentials_and_removes_temporary_file(
    tmp_path, monkeypatch
):
    path = tmp_path / ".benchmark" / "state.json"
    private_state.write_private(path, "previous")

    def fail_replace(*args, **kwargs):
        raise OSError("injected interrupted replace")

    monkeypatch.setattr(private_state.os, "replace", fail_replace)
    with pytest.raises(OSError, match="interrupted"):
        private_state.write_private(path, "replacement")
    assert private_state.read_private(path) == "previous"
    assert list(path.parent.iterdir()) == [path]


def test_non_posix_refuses_before_creating_credential_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(private_state, "os", SimpleNamespace(name="nt"))
    directory = tmp_path / ".benchmark"
    with pytest.raises(RuntimeError, match="POSIX filesystem"):
        private_state.write_private(directory / "state.json", "value")
    assert not directory.exists()
