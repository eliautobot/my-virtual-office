"""Secret files in the data folder: private, but never taken away from their owner (v0.10.1 upgrade fix).

In Docker the office usually runs as root and the data folder is often a bind mount owned by the person who
installed it. Rewriting a file through a temp file and a rename makes a NEW file, owned by whoever runs the
office; that used to turn vo-config.json and the other secret files into root-only files the owner could no
longer read. Every secret writer goes through here instead:

- the mode is 0600, or 0640 when the file was group-readable before (its group keeps reading it);
  world access always goes;
- a rewrite keeps the file's owner and group;
- a new file takes the owner and group of its folder when the office runs as root (otherwise the office's own).
Owner changes are best effort: a non-root office cannot give a file away, and that is fine.
"""
import os
import stat
import tempfile

_UNSET = object()


def private_mode_for(mode):
    """The private mode for a file that had ``mode``: 0640 when group-readable, else 0600."""
    return 0o640 if (mode or 0) & stat.S_IRGRP else 0o600


def private_mode(path):
    """The private mode ``path`` should have (0600 for a new file)."""
    try:
        return private_mode_for(stat.S_IMODE(os.stat(path).st_mode))
    except OSError:
        return 0o600


def _running_as_root():
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid) and geteuid() == 0


def snapshot(path):
    """(uid, gid, mode) a rewrite of ``path`` must keep; for a new file (uid, gid) is the folder's when
    running as root, else None, and the mode is 0600. Take it BEFORE creating or replacing the file."""
    try:
        st = os.stat(path)
        return st.st_uid, st.st_gid, private_mode_for(stat.S_IMODE(st.st_mode))
    except OSError:
        pass
    if _running_as_root():
        try:
            st = os.stat(os.path.dirname(os.path.abspath(path)))
            return st.st_uid, st.st_gid, 0o600
        except OSError:
            pass
    return None, None, 0o600


def adopt(fd, path, before=_UNSET):
    """Give the open file ``fd`` (a temp file about to replace ``path``, or ``path`` itself just created)
    the owner, group and private mode ``path`` should have. ``before`` = snapshot(path) taken earlier."""
    uid, gid, mode = snapshot(path) if before is _UNSET else before
    if uid is not None:
        try:
            os.fchown(fd, uid, gid)
        except OSError:
            try:
                os.fchown(fd, -1, gid)  # not root: keeping the group may still be allowed
            except OSError:
                pass
    try:
        os.fchmod(fd, mode)
    except OSError:
        pass


def tighten(path):
    """Make an existing file private without changing its owner or group. True when it is private now."""
    try:
        if not os.path.isfile(path):
            return False
        current = stat.S_IMODE(os.stat(path).st_mode)
        want = private_mode_for(current)
        if current != want:
            os.chmod(path, want)
        return True
    except OSError:
        return False


# The data folder's secret files (docs/UPDATING.md "File permissions") and the backups the office and the provider
# layer keep of them (.bak, .pre-hp, .pre-pl hold the same secrets). Every start makes them private again, so a file an
# older office opened to everyone (0.7.x chmodded every file 0666 and /data 0777 at each container start) does not stay
# open until its next write, or for ever for a key that is only read.
SECRET_FILES = (
    "vo-config.json", "access.json", "agent-providers.json", "provider-secrets.json", "openclaw-device.json",
    ".openclaw-proxy-secret", "provider-media.key", "provider-layer.key", "license.json",
    os.path.join("provider-layer", ".principal-secret"),
)
SECRET_BACKUP_SUFFIXES = (".bak", ".pre-hp", ".pre-pl")
# (folders that hold them: anyone who may write in a folder can swap a private file in it for one of their own)
SECRET_FOLDERS = ("", "provider-layer")


def private_dir_mode_for(mode):
    """The mode for a folder holding secrets that had ``mode``: 0700, or 0750 when its group could list it (the
    group keeps reading, as with files); nobody else, and never group write."""
    return 0o750 if (mode or 0) & stat.S_IRGRP else 0o700


def tighten_dir(path):
    """Make an existing folder that holds secrets private without changing its owner or group. True when it changed.
    Only where it is safe: as root or as the folder's owner (anyone else could not chmod it anyway, and a folder the
    office reaches only through its group or the world bits must not be taken away from the office itself)."""
    try:
        st = os.stat(path)
        if not stat.S_ISDIR(st.st_mode):
            return False
        geteuid = getattr(os, "geteuid", None)
        if geteuid and geteuid() not in (0, st.st_uid):
            return False
        current = stat.S_IMODE(st.st_mode)
        want = private_dir_mode_for(current) | (current & stat.S_ISGID)   # (a setgid folder keeps handing down its group)
        if current == want:
            return False
        os.chmod(path, want)
        return True
    except OSError:
        return False


def tighten_data_secrets(data_dir, log=None):
    """At start: the data folder's secret files and their backups private (``tighten``: 0600, or 0640 when the group
    could read; owner and group kept), the folders holding them too (``tighten_dir``). Returns the names changed
    (relative to ``data_dir``); never raises. ``log``: a print-like function for what could not be done."""
    changed = []
    if not data_dir or not os.path.isdir(data_dir):
        return changed
    for name in SECRET_FILES:
        for candidate in (name,) + tuple(name + suffix for suffix in SECRET_BACKUP_SUFFIXES):
            path = os.path.join(data_dir, candidate)
            try:
                if not os.path.isfile(path) or os.path.islink(path):   # (a link: its target is not ours to change)
                    continue
                before = stat.S_IMODE(os.stat(path).st_mode)
            except OSError:
                continue
            if not tighten(path) and log:
                log(f"[data] could not make {candidate} private")
            try:
                if stat.S_IMODE(os.stat(path).st_mode) != before:
                    changed.append(candidate)
            except OSError:
                pass
    for name in SECRET_FOLDERS:
        path = os.path.join(data_dir, name) if name else data_dir
        if not os.path.islink(path) and tighten_dir(path):
            changed.append(name or ".")
    return changed


def keep_owner(source, copy):
    """A copy (``shutil.copy2`` keeps the mode, not the owner) gets ``source``'s owner and group back."""
    try:
        st = os.stat(source)
        os.chown(copy, st.st_uid, st.st_gid)
    except OSError:
        pass


def private_dir(path):
    """Create a private folder (0700) inside the data folder; one the office creates as root takes its
    parent's owner and group, like a new file. An existing folder is left as it is."""
    if os.path.isdir(path):
        return
    os.makedirs(path, mode=0o700, exist_ok=True)
    if _running_as_root():
        try:
            st = os.stat(os.path.dirname(os.path.abspath(path)))
            os.chown(path, st.st_uid, st.st_gid)
        except OSError:
            pass


def write_private(path, data):
    """Atomically replace (or create) ``path`` with ``data`` (bytes or str): temp file in the same folder,
    owner/group/mode as above, fsync, rename. Raises OSError; the temp file never stays behind. The one
    writer for secret files (vo-config secrets, keys, the OpenClaw device file)."""
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    before = snapshot(path)
    fd, tmp = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.tmp-", dir=folder)  # 0600, O_EXCL
    try:
        adopt(fd, path, before)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data.encode("utf-8") if isinstance(data, str) else data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
