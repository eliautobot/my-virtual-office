"""The office's own folders and files keep the data folder's owner (v0.11).

In Docker the office usually runs as root and the data folder is often a bind mount owned by the person who
installed it. Folders and files the office made there as root (agent-pc/, office-life/, projects-md/,
presence-snapshot.json, ...) used to be root's: readable for a backup, but the owner could not manage them.
Like private_files' secret files, what the office makes in its data folder now takes the owner and group of the
folder it is made in, and what an earlier start made as root is given back at the next start (give_back_data).

Nothing changes when the office is not root (it cannot give files away), or when the folder is root's own (Docker's
default named volume): a new folder or file then keeps root, exactly as before. Owner changes never follow a symlink
and are best effort: a folder or file the office cannot give away stays as it is and the office keeps working.
"""
import os
import stat

import private_files


def running_as_root():
    return private_files._running_as_root()


def folder_owner(folder):
    """(uid, gid) of ``folder`` when the office runs as root in a folder someone else owns (a bind-mounted data
    folder); None otherwise (not root, a root-owned folder such as a named volume, or no such folder)."""
    if not running_as_root():
        return None
    try:
        st = os.stat(folder)
    except OSError:
        return None
    return None if st.st_uid == 0 else (st.st_uid, st.st_gid)


def adopt(path):
    """``path`` (a folder or file the office just made, as root) takes the owner and group of the folder it is in,
    when that folder is someone else's. A path that is not root's, or a symlink, is left alone."""
    if not running_as_root():
        return
    try:
        parent = os.stat(os.path.dirname(os.path.abspath(path)))
        if parent.st_uid == 0:
            return
        st = os.lstat(path)
        if st.st_uid != 0 or stat.S_ISLNK(st.st_mode):
            return
        os.lchown(path, parent.st_uid, parent.st_gid)
    except OSError:
        pass


def adopt_fd(fd, folder):
    """A file the office has open (a temp file about to be renamed into ``folder``) takes ``folder``'s owner and
    group, so the final file is never root's for a moment. Same rules as adopt()."""
    if not running_as_root():
        return
    try:
        parent = os.stat(folder)
        if parent.st_uid != 0 and os.fstat(fd).st_uid == 0:
            os.fchown(fd, parent.st_uid, parent.st_gid)
    except OSError:
        pass


def makedirs(path, mode=0o777, exist_ok=False):
    """os.makedirs() (same arguments); every folder it creates takes the owner and group of the folder it is made in
    (adopt())."""
    path = os.path.abspath(path)
    missing = []
    probe = path
    while probe and not os.path.isdir(probe):
        missing.append(probe)
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    os.makedirs(path, mode=mode, exist_ok=exist_ok)
    for folder in reversed(missing):   # (top down: each one takes the owner its parent has by then)
        adopt(folder)


def adopt_tree(top):
    """adopt() for a folder the office just made as a whole (shutil.copytree) and everything in it, top down."""
    adopt(top)
    if os.path.isdir(top) and not os.path.islink(top):
        for folder, dirs, files in os.walk(top):
            for name in dirs + files:
                adopt(os.path.join(folder, name))


def open_new(path, mode="w", **kwargs):
    """open(); a file this call creates takes its folder's owner (adopt()). For appends and plain writes."""
    existed = os.path.lexists(path)
    handle = open(path, mode, **kwargs)
    if not existed:
        adopt(path)
    return handle


def give_back(paths, uid, gid, *, keep=None):
    """Gives folders and files the office made as root (an earlier start) back to the data folder's owner, whole
    folders included. Never follows a symlink, never leaves the folder's file system (a mount inside it is not the
    office's), never gives away a file with more than one hard link (the other name may be outside the folder).
    ``keep(path, lstat)`` -> True keeps a path as it is. Best effort. Returns how many were given back."""
    given = 0

    def entries(top):
        if os.path.isdir(top) and not os.path.islink(top):
            device = os.lstat(top).st_dev
            for folder, dirs, files in os.walk(top):   # (os.walk does not follow symlinked folders)
                dirs[:] = [d for d in dirs if _same_device(os.path.join(folder, d), device)]
                yield folder
                yield from (os.path.join(folder, f) for f in files)
                yield from (os.path.join(folder, d) for d in dirs if os.path.islink(os.path.join(folder, d)))
        else:
            yield top

    for top in paths:
        if not os.path.lexists(top) or os.path.islink(top):
            continue
        for p in entries(top):
            try:
                st = os.lstat(p)
                if st.st_uid != 0 or (stat.S_ISREG(st.st_mode) and st.st_nlink > 1):
                    continue
                if keep and keep(p, st):
                    continue
                os.lchown(p, uid, gid)
                given += 1
            except OSError:
                pass
    return given


def _same_device(path, device):
    try:
        st = os.lstat(path)
        return stat.S_ISLNK(st.st_mode) or st.st_dev == device
    except OSError:
        return False


def give_back_data(data_dir, log=print):
    """At start: folders and files owned by root in a data folder someone else owns (an earlier start's, or a
    bind-mount folder Docker made as root at this start) go back to that owner. Secret files directly in the data folder (private: no access for others) keep their owner, as
    private_files promises (vo-config.json and friends from an older office stay as they are); everything in the
    office's own folders is given back (relfix2 does the same for provider-layer/). Returns how many."""
    owner = folder_owner(data_dir)
    if not owner:
        return 0
    top = os.path.abspath(data_dir)

    def keep(path, st):
        return (os.path.dirname(path) == top and stat.S_ISREG(st.st_mode)
                and not stat.S_IMODE(st.st_mode) & 0o007)

    try:
        names = [os.path.join(top, n) for n in os.listdir(top)]
    except OSError:
        return 0
    given = give_back(names, *owner, keep=keep)
    if given:
        log(f"[data] gave {given} folder(s)/file(s) owned by root back to the data folder's owner "
            f"(uid {owner[0]})")
    return given
