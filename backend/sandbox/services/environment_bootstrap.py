"""Environment lifecycle: lazy repo cloning, setup/maintenance scripts, and compressed state/deps sync.

Designed to work with both local Docker sandboxes and remote cloud containers through the
abstract ``runtime.exec(...)`` interface. When a persistent archive store is mounted at
``/var/lib/nr-store``:

* ``/workspace/<slug>`` always runs on fast local ephemeral disk.
* ``/var/lib/nr-store/state/<env_uuid>.tar.zst`` stores unpushed commits (git bundle),
  uncommitted diffs, and untracked non-ignored files (or non-git project files excluding
  heavy derived directories).
* ``/var/lib/nr-store/deps/<env_uuid>-<lockhash>.tar.zst`` caches derived dependency folders
  (``node_modules``, ``.venv``, ``vendor``) up to 300 MB for fast local-NVMe extraction.
* ``/var/lib/nr-store/deps-dir/<env_uuid>-<lockhash>/`` stores dependency folders larger
  than 300 MB as unpacked directories symlinked into the repo for instant (<0.2s) startup.
* Any cached dependency entry untouched for 7 days is pruned automatically.
"""
from __future__ import annotations

import base64
import json
import logging
from pathlib import PurePosixPath
from urllib.parse import quote

from django.utils import timezone

from authentication.github_connection import get_github_connection
from sandbox.models import Sandbox
from sandbox.services.vm_secrets import resolve_workspace_secrets

logger = logging.getLogger(__name__)

STORE_ROOT = "/var/lib/nr-store"
STATE_DIR = f"{STORE_ROOT}/state"
DEPS_ARCHIVE_DIR = f"{STORE_ROOT}/deps"
DEPS_SYMLINK_DIR = f"{STORE_ROOT}/deps-dir"
DEPS_ARCHIVE_THRESHOLD_BYTES = 300 * 1024 * 1024  # 300 MB
MAX_DEPS_CACHE_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB
MAX_STATE_FILE_BYTES = 50 * 1024 * 1024  # 50 MB per untracked/non-git file
MAX_STATE_TOTAL_BYTES = 1024 * 1024 * 1024  # 1 GB total state archive cap
DEPS_TTL_SECONDS = 7 * 24 * 3600  # 7 days
SETUP_TIMEOUT_SECONDS = 600
MAINTENANCE_TIMEOUT_SECONDS = 300
MAX_SETUP_LOG_CHARS = 16384

LOCKFILES = (
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "uv.lock",
    "poetry.lock",
    "requirements.txt",
    "pyproject.toml",
    "go.sum",
    "Cargo.lock",
)
MANIFEST_FALLBACKS = (
    "package.json",
    "go.mod",
    "Cargo.toml",
)
DERIVED_DEP_DIRS = ("node_modules", ".venv", "venv", "vendor")


def environment_root_path(sandbox: Sandbox) -> str:
    raw = (sandbox.filesystem_path or f"/workspace/{sandbox.slug}").strip().rstrip("/")
    return raw or f"/workspace/{sandbox.slug}"


def environment_working_path(sandbox: Sandbox) -> str:
    root = environment_root_path(sandbox)
    subdir = (getattr(sandbox, "working_subdir", "") or "").strip().strip("/")
    if not subdir:
        return root
    path = PurePosixPath(subdir)
    if ".." in path.parts:
        return root
    return f"{root}/{subdir}"


def _exec_json(runtime, script: str, payload: dict, *, timeout: int = 120) -> dict:
    encoded = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    proc = runtime.exec("python3", "-c", script, encoded, timeout=timeout)
    code = proc.wait(timeout)
    stdout = (proc.stdout.read() or "").strip()
    stderr = (proc.stderr.read() or "").strip()
    last_line = stdout.splitlines()[-1] if stdout else ""
    try:
        data = json.loads(last_line) if last_line else {}
    except json.JSONDecodeError:
        data = {"raw_stdout": stdout[-4000:]}
    data.setdefault("returncode", code)
    if stderr and "stderr" not in data:
        data["stderr"] = stderr[-4000:]
    return data


def _github_clone_url(sandbox: Sandbox, user=None) -> tuple[str, str]:
    """Return (authenticated_clone_url, clean_remote_url) for the environment's repository."""
    raw_url = (sandbox.repo_url or "").strip()
    full_name = (sandbox.repo_full_name or "").strip().strip("/")
    if not raw_url and full_name:
        raw_url = f"https://github.com/{full_name}.git"
    if not raw_url:
        return "", ""
    clean_url = raw_url
    token = ""
    owner = user or sandbox.user
    if owner is not None and "github.com" in raw_url.lower():
        conn = get_github_connection(owner)
        extra = getattr(conn, "extra_data", None) or {}
        token = str(extra.get("access_token") or getattr(conn, "access_token", "") or "").strip() if conn else ""
    if token and raw_url.startswith("https://github.com/"):
        auth_url = raw_url.replace("https://github.com/", f"https://x-access-token:{quote(token, safe='')}@github.com/", 1)
        return auth_url, clean_url
    return raw_url, clean_url


_GUEST_RESTORE_AND_HASH_SCRIPT = r"""
import base64, hashlib, json, os, shutil, subprocess, sys, tarfile, tempfile, time
from pathlib import Path

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
env_id = cfg["env_id"]
root = Path(cfg["root"])
work_dir = Path(cfg["work_dir"])
auth_url = cfg.get("auth_url") or ""
clean_url = cfg.get("clean_url") or ""
branch = cfg.get("default_branch") or ""
store_root = Path(cfg["store_root"])
lockfiles = cfg["lockfiles"]
dep_dirs = cfg["dep_dirs"]
force_setup = bool(cfg.get("force_setup"))

result = {
    "cloned": False,
    "state_restored": False,
    "deps_restored": None,
    "lock_hash": "",
    "suggested_setup": "",
    "needs_setup": False,
}

root.parent.mkdir(parents=True, exist_ok=True)
git_dir = root / ".git"

# 1. Clone repo if missing
if auth_url and not git_dir.exists():
    if root.exists() and not any(root.iterdir()):
        root.rmdir()
    if not root.exists():
        cmd = ["git", "clone", "--depth", "50"]
        if branch:
            cmd += ["--branch", branch]
        cmd += [auth_url, str(root)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 and branch:
            # Retry without --branch in case the branch name was empty/non-default
            proc = subprocess.run(["git", "clone", "--depth", "50", auth_url, str(root)], capture_output=True, text=True)
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "git clone failed").replace(auth_url, clean_url)
            print(json.dumps({"error": err[-2000:], "returncode": proc.returncode}))
            sys.exit(proc.returncode)
        if clean_url and clean_url != auth_url:
            subprocess.run(["git", "-C", str(root), "remote", "set-url", "origin", clean_url], capture_output=True)
        result["cloned"] = True

root.mkdir(parents=True, exist_ok=True)
work_dir.mkdir(parents=True, exist_ok=True)

# Record active env_id -> root mapping so @modal.exit() can checkpoint on idle stop / preemption
try:
    map_path = Path("/tmp/.nr-active-envs.json")
    cur_map = json.loads(map_path.read_text("utf-8")) if map_path.is_file() else {}
    if cur_map.get(env_id) != str(root):
        cur_map[env_id] = str(root)
        map_path.write_text(json.dumps(cur_map), encoding="utf-8")
except Exception:
    pass

# 2. Restore compressed state from /var/lib/nr-store/state/<env_id>.tar.zst (once per container boot)
state_archive = store_root / "state" / f"{env_id}.tar.zst"
restored_marker = Path(f"/tmp/.nr-state-restored-{env_id}")
if store_root.is_dir() and state_archive.is_file() and not restored_marker.exists():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        unpack = subprocess.run(
            ["bash", "-c", f"zstd -dc {str(state_archive)!r} | tar -C {tmp!r} -xf -"],
            capture_output=True, text=True,
        )
        if unpack.returncode == 0:
            meta_file = tmp_path / ".nr_state_meta.json"
            meta = json.loads(meta_file.read_text("utf-8")) if meta_file.is_file() else {}
            mode = meta.get("mode", "git")
            if mode == "git":
                if not (root / ".git").exists():
                    subprocess.run(
                        ["git", "init", "-b", meta.get("branch") or "main", str(root)],
                        capture_output=True,
                    )
                bundle = tmp_path / "unpushed.bundle"
                if bundle.is_file() and bundle.stat().st_size > 0:
                    subprocess.run(
                        ["git", "-C", str(root), "fetch", str(bundle), "+refs/heads/*:refs/nr-bundle/*"],
                        capture_output=True,
                    )
                    head_branch = meta.get("branch") or ""
                    head_sha = meta.get("head") or ""
                    if head_branch and head_sha:
                        subprocess.run(["git", "-C", str(root), "checkout", "-B", head_branch, head_sha], capture_output=True)
                    elif head_sha:
                        subprocess.run(["git", "-C", str(root), "checkout", head_sha], capture_output=True)
                diff_file = tmp_path / "working.patch"
                if diff_file.is_file() and diff_file.stat().st_size > 0:
                    subprocess.run(["git", "-C", str(root), "apply", "--whitespace=nowarn", str(diff_file)], capture_output=True)
                untracked_dir = tmp_path / "untracked"
                if untracked_dir.is_dir():
                    for src in untracked_dir.rglob("*"):
                        rel = src.relative_to(untracked_dir)
                        dst = root / rel
                        if src.is_dir():
                            dst.mkdir(parents=True, exist_ok=True)
                        else:
                            dst.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(src, dst, follow_symlinks=False)
                result["state_restored"] = True
            elif mode == "files":
                files_dir = tmp_path / "files"
                if files_dir.is_dir():
                    for src in files_dir.rglob("*"):
                        rel = src.relative_to(files_dir)
                        dst = root / rel
                        if src.is_dir():
                            dst.mkdir(parents=True, exist_ok=True)
                        else:
                            dst.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(src, dst, follow_symlinks=False)
                    result["state_restored"] = True
    try:
        restored_marker.write_text("ok", encoding="utf-8")
    except OSError:
        pass

# 3. Compute lockfile hash (falling back to manifest files when no lockfile exists) & detect suggested setup script
digest = hashlib.sha256()
found_locks = []
for name in lockfiles:
    p = work_dir / name
    if p.is_file():
        found_locks.append(name)
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(p.read_bytes())
if not found_locks:
    for name in (cfg.get("manifest_fallbacks") or ()):
        p = work_dir / name
        if p.is_file():
            found_locks.append(name)
            digest.update(name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(p.read_bytes())
lock_hash = digest.hexdigest()[:16] if found_locks else ""
result["lock_hash"] = lock_hash

if (work_dir / "pnpm-lock.yaml").is_file():
    result["suggested_setup"] = "pnpm install --frozen-lockfile"
elif (work_dir / "package-lock.json").is_file():
    result["suggested_setup"] = "npm ci"
elif (work_dir / "yarn.lock").is_file():
    result["suggested_setup"] = "yarn install --frozen-lockfile"
elif (work_dir / "package.json").is_file():
    result["suggested_setup"] = "npm install"
elif (work_dir / "uv.lock").is_file():
    result["suggested_setup"] = "uv sync"
elif (work_dir / "requirements.txt").is_file():
    result["suggested_setup"] = "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
elif (work_dir / "go.mod").is_file():
    result["suggested_setup"] = "go mod download"
elif (work_dir / "Cargo.toml").is_file():
    result["suggested_setup"] = "cargo fetch"

# 4. Restore cached deps from /var/lib/nr-store (symlink >300MB or tar.zst <=300MB)
if store_root.is_dir() and lock_hash and not force_setup:
    symlink_store = store_root / "deps-dir" / f"{env_id}-{lock_hash}"
    archive_store = store_root / "deps" / f"{env_id}-{lock_hash}.tar.zst"
    now = time.time()
    if symlink_store.is_dir():
        linked_any = False
        for dep in dep_dirs:
            src = symlink_store / dep
            dst = work_dir / dep
            if src.is_dir():
                if dst.is_symlink() and dst.resolve() == src.resolve():
                    linked_any = True
                    continue
                if dst.is_symlink() or dst.is_file():
                    dst.unlink()
                elif dst.is_dir():
                    shutil.rmtree(dst)
                os.symlink(str(src), str(dst))
                linked_any = True
        if linked_any:
            try:
                os.utime(symlink_store, (now, now))
            except OSError:
                pass
            result["deps_restored"] = "symlink"
    elif archive_store.is_file():
        have_all = any((work_dir / dep).exists() for dep in dep_dirs)
        if not have_all:
            unpack = subprocess.run(
                ["bash", "-c", f"zstd -dc {str(archive_store)!r} | tar -C {str(work_dir)!r} -xf -"],
                capture_output=True, text=True,
            )
            if unpack.returncode == 0:
                try:
                    os.utime(archive_store, (now, now))
                except OSError:
                    pass
                result["deps_restored"] = "archive"
        else:
            result["deps_restored"] = "present"

print(json.dumps(result))
"""

_GUEST_CACHE_DEPS_SCRIPT = r"""
import base64, hashlib, json, os, shutil, subprocess, sys, time
from pathlib import Path

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
env_id = cfg["env_id"]
work_dir = Path(cfg["work_dir"])
store_root = Path(cfg["store_root"])
lock_hash = cfg.get("lock_hash") or ""
lockfiles = cfg.get("lockfiles") or ()
manifest_fallbacks = cfg.get("manifest_fallbacks") or ()
dep_dirs = cfg["dep_dirs"]
threshold = int(cfg["threshold_bytes"])
max_cache_bytes = int(cfg.get("max_cache_bytes") or 5 * 1024 * 1024 * 1024)

# Recompute lock_hash AFTER setup_script so newly generated lockfiles (package-lock.json, uv.lock, etc.) match next boot
if lockfiles:
    digest = hashlib.sha256()
    found = []
    for name in lockfiles:
        p = work_dir / name
        if p.is_file():
            found.append(name)
            digest.update(name.encode("utf-8"))
            digest.update(b"\0")
            digest.update(p.read_bytes())
    if not found:
        for name in manifest_fallbacks:
            p = work_dir / name
            if p.is_file():
                found.append(name)
                digest.update(name.encode("utf-8"))
                digest.update(b"\0")
                digest.update(p.read_bytes())
    if found:
        lock_hash = digest.hexdigest()[:16]

if not store_root.is_dir() or not lock_hash:
    print(json.dumps({"cached": False, "mode": None, "lock_hash": lock_hash}))
    sys.exit(0)

present = [d for d in dep_dirs if (work_dir / d).is_dir() and not (work_dir / d).is_symlink()]
if not present:
    print(json.dumps({"cached": False, "mode": None, "lock_hash": lock_hash}))
    sys.exit(0)

total_bytes = 0
for d in present:
    for root_d, _, files in os.walk(work_dir / d, followlinks=False):
        for f in files:
            try:
                total_bytes += os.lstat(os.path.join(root_d, f)).st_size
            except OSError:
                pass

if total_bytes > max_cache_bytes:
    print(json.dumps({"cached": False, "mode": "skipped_too_large", "bytes": total_bytes, "lock_hash": lock_hash}))
    sys.exit(0)

deps_archive_dir = store_root / "deps"
deps_symlink_dir = store_root / "deps-dir"
deps_archive_dir.mkdir(parents=True, exist_ok=True)
deps_symlink_dir.mkdir(parents=True, exist_ok=True)

if total_bytes > threshold:
    # >300 MB: move unpacked directories to Volume and symlink back for <0.2s warm starts
    target = deps_symlink_dir / f"{env_id}-{lock_hash}"
    tmp_target = deps_symlink_dir / f".{env_id}-{lock_hash}.tmp-{os.getpid()}"
    if tmp_target.exists():
        shutil.rmtree(tmp_target, ignore_errors=True)
    tmp_target.mkdir(parents=True, exist_ok=True)
    for d in present:
        shutil.copytree(work_dir / d, tmp_target / d, symlinks=True)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    tmp_target.rename(target)
    for d in present:
        shutil.rmtree(work_dir / d, ignore_errors=True)
        os.symlink(str(target / d), str(work_dir / d))
    now = time.time()
    os.utime(target, (now, now))
    print(json.dumps({"cached": True, "mode": "symlink", "bytes": total_bytes, "lock_hash": lock_hash}))
else:
    archive = deps_archive_dir / f"{env_id}-{lock_hash}.tar.zst"
    tmp_archive = deps_archive_dir / f".{env_id}-{lock_hash}.tmp-{os.getpid()}.tar.zst"
    quoted_dirs = " ".join(repr(d) for d in present)
    pack = subprocess.run(
        ["bash", "-c", f"set -o pipefail; tar -C {str(work_dir)!r} -cf - {quoted_dirs} | zstd -3 -T0 -q -o {str(tmp_archive)!r}"],
        capture_output=True, text=True,
    )
    if pack.returncode == 0 and tmp_archive.is_file():
        tmp_archive.replace(archive)
        print(json.dumps({"cached": True, "mode": "archive", "bytes": archive.stat().st_size, "lock_hash": lock_hash}))
    else:
        tmp_archive.unlink(missing_ok=True)
        print(json.dumps({"cached": False, "mode": "archive_failed", "lock_hash": lock_hash, "stderr": (pack.stderr or "")[-1000:]}))
"""

_GUEST_SAVE_STATE_SCRIPT = r"""
import base64, hashlib, json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
env_id = cfg["env_id"]
root = Path(cfg["root"])
store_root = Path(cfg["store_root"])
ttl_seconds = int(cfg.get("ttl_seconds") or 7 * 24 * 3600)
skip_dirs = set(cfg.get("skip_dirs") or ())
max_file_bytes = int(cfg.get("max_file_bytes") or 50 * 1024 * 1024)
max_total_bytes = int(cfg.get("max_total_bytes") or 1024 * 1024 * 1024)

if not store_root.is_dir() or not root.is_dir():
    print(json.dumps({"saved": False, "skipped": "no_store_or_root"}))
    sys.exit(0)

# Opportunistically prune expired >7d deps entries in this workspace store
now = time.time()
pruned = 0
for sub in ("deps", "deps-dir"):
    folder = store_root / sub
    if not folder.is_dir():
        continue
    for entry in list(folder.iterdir()):
        if entry.name.startswith("."):
            continue
        try:
            age = now - entry.stat().st_mtime
            if age > ttl_seconds:
                shutil.rmtree(entry, ignore_errors=True) if entry.is_dir() else entry.unlink(missing_ok=True)
                pruned += 1
        except OSError:
            pass

state_dir = store_root / "state"
state_dir.mkdir(parents=True, exist_ok=True)
state_archive = state_dir / f"{env_id}.tar.zst"
fp_file = Path(f"/tmp/.nr-state-fp-{env_id}")

is_git = (root / ".git").exists()
if is_git:
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"], capture_output=True, text=True).stdout.strip()
    branch = subprocess.run(["git", "-C", str(root), "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    unpushed = subprocess.run(["git", "-C", str(root), "rev-list", "--all", "--not", "--remotes"], capture_output=True, text=True).stdout.strip()
    diff_out = subprocess.run(["git", "-C", str(root), "diff", "HEAD"], capture_output=True).stdout if head else b""
    untracked_raw = subprocess.run(["git", "-C", str(root), "ls-files", "--others", "--exclude-standard"], capture_output=True, text=True).stdout
    untracked_candidates = [
        line for line in untracked_raw.splitlines()
        if line.strip() and not (skip_dirs & set(Path(line).parts))
    ]
    untracked = []
    skipped_large = []
    untracked_total_bytes = 0
    for rel in sorted(untracked_candidates):
        p = root / rel
        try:
            st = p.lstat()
        except OSError:
            continue
        if p.is_file() and not p.is_symlink() and st.st_size > max_file_bytes:
            skipped_large.append(rel)
            continue
        if p.is_file() and not p.is_symlink():
            if untracked_total_bytes + st.st_size > max_total_bytes:
                skipped_large.append(rel)
                continue
            untracked_total_bytes += st.st_size
        untracked.append(rel)

    fp_hash = hashlib.sha256()
    fp_hash.update((head + "\n" + branch + "\n" + unpushed + "\n").encode("utf-8"))
    fp_hash.update(diff_out)
    for rel in untracked:
        p = root / rel
        if p.is_file():
            st = p.lstat()
            fp_hash.update(f"{rel}:{st.st_size}:{st.st_mtime_ns}\n".encode("utf-8"))
    fp = fp_hash.hexdigest()

    if not unpushed and not diff_out and not untracked:
        if state_archive.is_file():
            state_archive.unlink(missing_ok=True)
        fp_file.write_text(fp, encoding="utf-8")
        print(json.dumps({"saved": False, "clean": True, "bytes": 0, "pruned_deps": pruned, "skipped_large_files": skipped_large[:20]}))
        sys.exit(0)

    if fp_file.is_file() and fp_file.read_text("utf-8").strip() == fp and state_archive.is_file():
        print(json.dumps({"saved": False, "unchanged": True, "bytes": state_archive.stat().st_size, "pruned_deps": pruned, "skipped_large_files": skipped_large[:20]}))
        sys.exit(0)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / ".nr_state_meta.json").write_text(json.dumps({"mode": "git", "head": head, "branch": branch}), encoding="utf-8")
        staged_bytes = len(diff_out)
        if unpushed:
            bundle_path = tmp_path / "unpushed.bundle"
            subprocess.run(["git", "-C", str(root), "bundle", "create", str(bundle_path), "--all", "--not", "--remotes"], capture_output=True)
            if bundle_path.is_file():
                staged_bytes += bundle_path.stat().st_size
        if staged_bytes + untracked_total_bytes > max_total_bytes:
            print(json.dumps({"saved": False, "skipped": "state_too_large", "bytes": staged_bytes + untracked_total_bytes, "max_bytes": max_total_bytes, "pruned_deps": pruned, "skipped_large_files": skipped_large[:20]}))
            sys.exit(0)
        if diff_out:
            (tmp_path / "working.patch").write_bytes(diff_out)
        if untracked:
            udir = tmp_path / "untracked"
            for rel in untracked:
                src = root / rel
                if src.is_file() or src.is_symlink():
                    dst = udir / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst, follow_symlinks=False)
        tmp_arc = state_dir / f".{env_id}.tmp-{os.getpid()}.tar.zst"
        pack = subprocess.run(
            ["bash", "-c", f"set -o pipefail; tar -C {tmp!r} -cf - . | zstd -3 -T0 -q -o {str(tmp_arc)!r}"],
            capture_output=True, text=True,
        )
        if pack.returncode != 0:
            tmp_arc.unlink(missing_ok=True)
            print(json.dumps({"saved": False, "error": (pack.stderr or "")[-1000:], "pruned_deps": pruned}))
            sys.exit(1)
        tmp_arc.replace(state_archive)
        fp_file.write_text(fp, encoding="utf-8")
        print(json.dumps({"saved": True, "mode": "git", "bytes": state_archive.stat().st_size, "pruned_deps": pruned, "skipped_large_files": skipped_large[:20]}))
else:
    fp_hash = hashlib.sha256()
    files_to_pack = []
    skipped_large = []
    total_non_git_bytes = 0
    for cur_root, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in skip_dirs)
        for f in sorted(files):
            full = Path(cur_root) / f
            rel = full.relative_to(root)
            try:
                st = full.lstat()
            except OSError:
                continue
            if full.is_file() and not full.is_symlink():
                if st.st_size > max_file_bytes or total_non_git_bytes + st.st_size > max_total_bytes:
                    skipped_large.append(str(rel))
                    continue
                total_non_git_bytes += st.st_size
            fp_hash.update(f"{rel}:{st.st_size}:{st.st_mtime_ns}\n".encode("utf-8"))
            files_to_pack.append(rel)
    fp = fp_hash.hexdigest()
    if not files_to_pack:
        print(json.dumps({"saved": False, "clean": True, "bytes": 0, "pruned_deps": pruned, "skipped_large_files": skipped_large[:20]}))
        sys.exit(0)
    if fp_file.is_file() and fp_file.read_text("utf-8").strip() == fp and state_archive.is_file():
        print(json.dumps({"saved": False, "unchanged": True, "bytes": state_archive.stat().st_size, "pruned_deps": pruned, "skipped_large_files": skipped_large[:20]}))
        sys.exit(0)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        (tmp_path / ".nr_state_meta.json").write_text(json.dumps({"mode": "files"}), encoding="utf-8")
        fdir = tmp_path / "files"
        for rel in files_to_pack:
            src = root / rel
            dst = fdir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst, follow_symlinks=False)
        tmp_arc = state_dir / f".{env_id}.tmp-{os.getpid()}.tar.zst"
        pack = subprocess.run(
            ["bash", "-c", f"set -o pipefail; tar -C {tmp!r} -cf - . | zstd -3 -T0 -q -o {str(tmp_arc)!r}"],
            capture_output=True, text=True,
        )
        if pack.returncode != 0:
            tmp_arc.unlink(missing_ok=True)
            print(json.dumps({"saved": False, "error": (pack.stderr or "")[-1000:], "pruned_deps": pruned}))
            sys.exit(1)
        tmp_arc.replace(state_archive)
        fp_file.write_text(fp, encoding="utf-8")
        print(json.dumps({"saved": True, "mode": "files", "bytes": state_archive.stat().st_size, "pruned_deps": pruned, "skipped_large_files": skipped_large[:20]}))
"""


def _run_shell_script(runtime, script: str, *, cwd: str, env_vars: dict[str, str], timeout: int) -> tuple[int, str]:
    runner = (
        "import base64, json, os, subprocess, sys\n"
        "cfg = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))\n"
        "env = os.environ.copy()\n"
        "env.update({str(k): str(v) for k, v in (cfg.get('env') or {}).items()})\n"
        "proc = subprocess.run(['bash', '-lc', cfg['script']], cwd=cfg['cwd'], env=env, "
        "stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n"
        "sys.stdout.write(proc.stdout or '')\n"
        "sys.exit(proc.returncode)\n"
    )
    encoded = base64.b64encode(json.dumps({"script": script, "cwd": cwd, "env": env_vars}).encode("utf-8")).decode("ascii")
    proc = runtime.exec("python3", "-c", runner, encoded, timeout=timeout)
    code = proc.wait(timeout)
    out = (proc.stdout.read() or "") + (proc.stderr.read() or "")
    return code, out[-MAX_SETUP_LOG_CHARS:]


def ensure_environment_ready(sandbox: Sandbox, runtime, *, user=None, force_setup: bool = False) -> dict:
    """Idempotently prepare an Environment inside ``runtime`` (clone, restore state, deps cache / setup)."""
    root = environment_root_path(sandbox)
    work_dir = environment_working_path(sandbox)
    auth_url, clean_url = _github_clone_url(sandbox, user=user)

    prep = _exec_json(
        runtime,
        _GUEST_RESTORE_AND_HASH_SCRIPT,
        {
            "env_id": str(sandbox.uuid),
            "root": root,
            "work_dir": work_dir,
            "auth_url": auth_url,
            "clean_url": clean_url,
            "default_branch": sandbox.default_branch or "",
            "store_root": STORE_ROOT,
            "lockfiles": list(LOCKFILES),
            "manifest_fallbacks": list(MANIFEST_FALLBACKS),
            "dep_dirs": list(DERIVED_DEP_DIRS),
            "force_setup": force_setup,
        },
        timeout=300,
    )
    if prep.get("error"):
        Sandbox.objects.filter(pk=sandbox.pk).update(
            setup_status=Sandbox.SETUP_STATUS_FAILED,
            setup_last_run_at=timezone.now(),
            setup_last_log=str(prep["error"])[-MAX_SETUP_LOG_CHARS:],
            updated_at=timezone.now(),
        )
        sandbox.refresh_from_db()
        return {"ready": False, "error": prep["error"], **prep}

    lock_hash = prep.get("lock_hash") or ""
    deps_restored = prep.get("deps_restored")
    setup_script = (sandbox.setup_script or "").strip()
    needs_setup = bool(setup_script) and (
        force_setup
        or (deps_restored is None and (sandbox.setup_status != Sandbox.SETUP_STATUS_READY or (lock_hash and lock_hash != sandbox.deps_lock_hash)))
    )

    if deps_restored and not force_setup:
        updates = {"updated_at": timezone.now()}
        if lock_hash:
            updates["deps_lock_hash"] = lock_hash
        if setup_script and sandbox.setup_status != Sandbox.SETUP_STATUS_READY:
            updates["setup_status"] = Sandbox.SETUP_STATUS_READY
        Sandbox.objects.filter(pk=sandbox.pk).update(**updates)
        sandbox.refresh_from_db()
        return {"ready": True, "setup_ran": False, **prep}

    if not needs_setup:
        if lock_hash and lock_hash != sandbox.deps_lock_hash:
            Sandbox.objects.filter(pk=sandbox.pk).update(deps_lock_hash=lock_hash, updated_at=timezone.now())
            sandbox.deps_lock_hash = lock_hash
        return {"ready": True, "setup_ran": False, **prep}

    # Run setup_script with merged workspace + environment secrets
    Sandbox.objects.filter(pk=sandbox.pk).update(setup_status=Sandbox.SETUP_STATUS_RUNNING, updated_at=timezone.now())
    secrets = resolve_workspace_secrets(sandbox.workspace, sandbox=sandbox)
    code, output = _run_shell_script(runtime, setup_script, cwd=work_dir, env_vars=secrets, timeout=SETUP_TIMEOUT_SECONDS)
    now = timezone.now()
    if code != 0:
        Sandbox.objects.filter(pk=sandbox.pk).update(
            setup_status=Sandbox.SETUP_STATUS_FAILED,
            setup_last_run_at=now,
            setup_last_log=output,
            updated_at=now,
        )
        sandbox.refresh_from_db()
        return {"ready": False, "setup_ran": True, "returncode": code, "log": output, **prep}

    # Cache newly installed derived dependency directories into /var/lib/nr-store
    cache_res = _exec_json(
        runtime,
        _GUEST_CACHE_DEPS_SCRIPT,
        {
            "env_id": str(sandbox.uuid),
            "work_dir": work_dir,
            "store_root": STORE_ROOT,
            "lock_hash": lock_hash,
            "lockfiles": list(LOCKFILES),
            "manifest_fallbacks": list(MANIFEST_FALLBACKS),
            "dep_dirs": list(DERIVED_DEP_DIRS),
            "threshold_bytes": DEPS_ARCHIVE_THRESHOLD_BYTES,
            "max_cache_bytes": MAX_DEPS_CACHE_BYTES,
        },
        timeout=300,
    )
    final_lock_hash = cache_res.get("lock_hash") or lock_hash
    Sandbox.objects.filter(pk=sandbox.pk).update(
        setup_status=Sandbox.SETUP_STATUS_READY,
        setup_last_run_at=now,
        setup_last_log=output,
        deps_lock_hash=final_lock_hash,
        updated_at=now,
    )
    sandbox.refresh_from_db()
    return {"ready": True, "setup_ran": True, "returncode": 0, "log": output, "deps_cache": cache_res, **prep, "lock_hash": final_lock_hash}


def run_maintenance_script(sandbox: Sandbox, runtime, worktree_path: str) -> dict:
    """Run the environment's optional maintenance_script inside a newly created worktree."""
    script = (getattr(sandbox, "maintenance_script", "") or "").strip()
    if not script:
        return {"ran": False}
    subdir = (getattr(sandbox, "working_subdir", "") or "").strip().strip("/")
    cwd = f"{worktree_path.rstrip('/')}/{subdir}" if subdir and ".." not in PurePosixPath(subdir).parts else worktree_path
    secrets = resolve_workspace_secrets(sandbox.workspace, sandbox=sandbox)
    code, output = _run_shell_script(runtime, script, cwd=cwd, env_vars=secrets, timeout=MAINTENANCE_TIMEOUT_SECONDS)
    return {"ran": True, "returncode": code, "log": output}


def save_environment_state(sandbox: Sandbox, runtime) -> dict:
    """Persist unpushed commits and uncommitted/untracked changes into /var/lib/nr-store/state."""
    res = _exec_json(
        runtime,
        _GUEST_SAVE_STATE_SCRIPT,
        {
            "env_id": str(sandbox.uuid),
            "root": environment_root_path(sandbox),
            "store_root": STORE_ROOT,
            "ttl_seconds": DEPS_TTL_SECONDS,
            "skip_dirs": [*DERIVED_DEP_DIRS, ".next", "dist", "build", "target", "__pycache__", ".git"],
            "max_file_bytes": MAX_STATE_FILE_BYTES,
            "max_total_bytes": MAX_STATE_TOTAL_BYTES,
        },
        timeout=120,
    )
    if res.get("saved") or res.get("clean"):
        Sandbox.objects.filter(pk=sandbox.pk).update(
            state_saved_at=timezone.now(),
            state_size_bytes=int(res.get("bytes") or 0),
            updated_at=timezone.now(),
        )
    return res


def clear_environment_deps_cache(sandbox: Sandbox, runtime=None) -> dict:
    """Remove cached dependency archives/directories for this environment and reset setup status."""
    removed = 0
    if runtime is not None:
        script = (
            "import base64, json, shutil, sys\n"
            "from pathlib import Path\n"
            "cfg = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))\n"
            "store = Path(cfg['store_root'])\n"
            "prefix = cfg['env_id'] + '-'\n"
            "count = 0\n"
            "for sub in ('deps', 'deps-dir'):\n"
            "  d = store / sub\n"
            "  if not d.is_dir(): continue\n"
            "  for entry in list(d.iterdir()):\n"
            "    if entry.name.startswith(prefix):\n"
            "      shutil.rmtree(entry, ignore_errors=True) if entry.is_dir() else entry.unlink(missing_ok=True)\n"
            "      count += 1\n"
            "print(json.dumps({'removed': count}))\n"
        )
        res = _exec_json(runtime, script, {"store_root": STORE_ROOT, "env_id": str(sandbox.uuid)}, timeout=60)
        removed = int(res.get("removed") or 0)
    Sandbox.objects.filter(pk=sandbox.pk).update(
        setup_status=Sandbox.SETUP_STATUS_IDLE,
        deps_lock_hash="",
        updated_at=timezone.now(),
    )
    sandbox.refresh_from_db()
    return {"cleared": True, "removed": removed}
