#!/usr/bin/env python3
"""Build the Every Airfield desktop apps for Windows, macOS (Apple Silicon and Intel) and Linux.

  python3 desktop/build.py                          build all four into downloads/
  python3 desktop/build.py --release OWNER/REPO     …and point the website's Download buttons at the
                                                    GitHub release v<version> of that repository
  python3 desktop/build.py --only linux             build one system (windows, mac or linux)

What it does, for each system:
  1. downloads Electron's official prebuilt app (cached) and checks it against Electron's SHA-256 sums
  2. puts Every Airfield (desktop/ plus the website and airport data) inside it and renames it
  3. on Mac, re-signs the app ad hoc with rcodesign, which Apple Silicon needs once an app is changed
     (set RCODESIGN=/path/to/rcodesign, or have rcodesign on your PATH)
  4. zips it, keeping file permissions and links, and records its size and SHA-256 in index.html

Only Python 3 is needed (plus rcodesign for the Mac builds). The zips are 120–160 MB each, too big for a
GitHub repository, so attach them to a GitHub release instead (see the README).
"""
import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
import zlib
from pathlib import Path

ELECTRON_VERSION = "44.4.5"
ROOT = Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "desktop"
OUT = ROOT / "downloads"
CACHE = Path(os.environ.get("EA_BUILD_CACHE", Path.home() / ".cache" / "every-airfield-build"))
SITE_FILES = ["index.html", "airports.txt", "world.json", "countries.json", "airspace.json"]
APP_FILES = ["package.json", "main.js", "preload.js"]
BASE_URL = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}"
BUNDLE_ID = "app.everyairfield.desktop"
# (os key, Electron platform, file name, button label)
TARGETS = [
    ("windows", "win32-x64", "EveryAirfield-windows-x64.zip", "Windows (64-bit)"),
    ("mac", "darwin-arm64", "EveryAirfield-mac-apple-silicon.zip", "Mac with Apple Silicon (M1 or newer)"),
    ("mac", "darwin-x64", "EveryAirfield-mac-intel.zip", "Mac with Intel"),
    ("linux", "linux-x64", "EveryAirfield-linux-x64.zip", "Linux (64-bit)"),
]


def log(msg):
    print(msg, flush=True)


# ---------- Electron downloads, checked against the published checksums ----------

def electron_zip(platform):
    CACHE.mkdir(parents=True, exist_ok=True)
    name = f"electron-v{ELECTRON_VERSION}-{platform}.zip"
    sums_file = CACHE / f"SHASUMS256-v{ELECTRON_VERSION}.txt"
    if not sums_file.exists():
        urllib.request.urlretrieve(f"{BASE_URL}/SHASUMS256.txt", sums_file)
    sums = dict(reversed(line.split(" *", 1)) for line in sums_file.read_text().splitlines() if " *" in line)
    want = sums.get(name)
    if not want:
        raise SystemExit(f"{name} isn't listed in Electron's checksums.")
    path = CACHE / name
    if not path.exists() or sha256(path) != want:
        log(f"  downloading {name} …")
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(f"{BASE_URL}/{name}", tmp)
        tmp.rename(path)
    if sha256(path) != want:
        path.unlink()
        raise SystemExit(f"{name} didn't match Electron's published checksum; deleted it. Run again to re-download.")
    return path


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------- unzip / zip keeping permissions and symbolic links (the Mac app needs its links) ----------

def extract(zip_path, dest):
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            if name.startswith("/") or ".." in Path(name).parts:
                raise SystemExit(f"unsafe path in {zip_path.name}: {name}")
            target = dest / name
            mode = info.external_attr >> 16
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if stat.S_ISLNK(mode):
                os.symlink(z.read(info).decode(), target)
            else:
                with z.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
                if mode & 0o777:
                    os.chmod(target, mode & 0o777)


def make_zip(src_dir, top_name, zip_path):
    """Zip src_dir as top_name/…, keeping Unix permissions and symlinks."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dirpath, dirnames, filenames in os.walk(src_dir):
            dirnames.sort()
            rel_dir = Path(dirpath).relative_to(src_dir)
            for name in sorted(filenames) + sorted(d for d in dirnames if (Path(dirpath) / d).is_symlink()):
                p = Path(dirpath) / name
                arc = str(Path(top_name) / rel_dir / name)
                info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
                info.create_system = 3                     # Unix, so unzip tools restore the modes
                if p.is_symlink():
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    z.writestr(info, os.readlink(p))
                else:
                    info.external_attr = (stat.S_IFREG | (p.stat().st_mode & 0o777)) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with open(p, "rb") as f:
                        z.writestr(info, f.read())
            dirnames[:] = [d for d in dirnames if not (Path(dirpath) / d).is_symlink()]


# ---------- the app icon, drawn here so no image files or tools are needed ----------

def icon_png(size):
    """The Every Airfield mark: an amber dot in a compass ring, on a navy rounded square."""
    navy, white, amber = (12, 32, 51), (242, 246, 249), (232, 161, 12)
    s, c = size, (size - 1) / 2
    rows = []
    for y in range(s):
        row = bytearray([0])
        for x in range(s):
            dx, dy = x - c, y - c
            # rounded square background (corner radius 22%)
            r = 0.22 * s
            qx, qy = max(abs(dx) - (c - r), 0), max(abs(dy) - (c - r), 0)
            bg = max(0.0, min(1.0, r - (qx * qx + qy * qy) ** 0.5 + 0.5))
            col, a = navy, bg
            d = (dx * dx + dy * dy) ** 0.5
            ring = max(0.0, min(1.0, 0.024 * s - abs(d - 0.33 * s) + 0.5))       # compass ring
            tick = 0.0
            for ax, ay in ((dx, dy), (dy, dx)):                                  # N/S/E/W ticks
                if abs(ax) < 0.018 * s and 0.20 * s < abs(ay) < 0.44 * s:
                    tick = max(tick, min(1.0, 0.018 * s - abs(ax) + 0.5))
            w = max(ring, tick)
            col = tuple(round(col[i] * (1 - w) + white[i] * w) for i in range(3))
            dot = max(0.0, min(1.0, 0.13 * s - d + 0.5))                          # amber centre
            col = tuple(round(col[i] * (1 - dot) + amber[i] * dot) for i in range(3))
            row += bytes(col) + bytes([round(255 * a)])
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", s, s, 8, 6, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


def icns(pngs):
    """macOS icon file holding PNG images (ic07 128, ic08 256, ic09 512, ic10 1024)."""
    body = b"".join(t + struct.pack(">I", len(p) + 8) + p for t, p in pngs)
    return b"icns" + struct.pack(">I", len(body) + 8) + body


# ---------- Electron fuses: switches compiled into the binary that turn off risky abilities ----------
# Layout (Electron's documented format): a 32-byte sentinel, a version byte, a length byte, then one
# byte per fuse: '1' on, '0' off. Turned off here:
#   0 RunAsNode                         ELECTRON_RUN_AS_NODE can't turn the app into plain Node.js
#   2 EnableNodeOptionsEnvironmentVariable   NODE_OPTIONS can't inject code at start-up
#   3 EnableNodeCliInspectArguments     --inspect can't attach a debugger
#   7 GrantFileProtocolExtraPrivileges  file:// pages get no extra powers (the app uses app:// only)
FUSE_SENTINEL = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
FUSES_OFF = (0, 2, 3, 7)


def flip_fuses(binary):
    data = bytearray(binary.read_bytes())
    i = data.find(FUSE_SENTINEL)
    if i < 0 or data.count(FUSE_SENTINEL) != 1:
        raise SystemExit(f"Couldn't find Electron's fuses in {binary.name}; not building an app without them.")
    version, length = data[i + 32], data[i + 33]
    if version != 1 or length < max(FUSES_OFF) + 1:
        raise SystemExit(f"Unexpected fuse layout in {binary.name} (version {version}, {length} fuses).")
    start = i + 34
    for k in FUSES_OFF:
        if data[start + k] not in b"01":
            raise SystemExit(f"Fuse {k} in {binary.name} is in an unknown state.")
        data[start + k] = ord("0")
    binary.write_bytes(bytes(data))
    return bytes(data[start:start + length]).decode()


# ---------- building one app ----------

def put_app(app_dir, icon512):
    app_dir.mkdir(parents=True)
    for f in APP_FILES:
        shutil.copy2(DESKTOP / f, app_dir / f)
    site = app_dir / "site"
    site.mkdir()
    for f in SITE_FILES:
        shutil.copy2(ROOT / f, site / f)
    (site / "icon.png").write_bytes(icon512)


def rcodesign_path():
    for cand in (os.environ.get("RCODESIGN"), shutil.which("rcodesign")):
        if cand and Path(cand).exists():
            return cand
    return None


def build(target, icons, work):
    os_key, platform, out_name, label = target
    log(f"\n{label}")
    src = electron_zip(platform)
    stage = work / platform
    extract(src, stage)
    if os_key == "mac":
        signer = rcodesign_path()
        if not signer:
            log("  skipped: rcodesign is needed to sign Mac apps (see the top of this file)")
            return None
        app = stage / "Every Airfield.app"
        (stage / "Electron.app").rename(app)
        res = app / "Contents" / "Resources"
        (res / "default_app.asar").unlink(missing_ok=True)
        put_app(res / "app", icons[512])
        (res / "electron.icns").write_bytes(icns([(b"ic07", icons[128]), (b"ic08", icons[256]), (b"ic09", icons[512]), (b"ic10", icons[1024])]))
        plist_path = app / "Contents" / "Info.plist"
        plist = plistlib.loads(plist_path.read_bytes())
        plist.update({"CFBundleName": "Every Airfield", "CFBundleDisplayName": "Every Airfield", "CFBundleIdentifier": BUNDLE_ID,
                      "CFBundleShortVersionString": app_version(), "CFBundleVersion": app_version(),
                      "NSLocationWhenInUseUsageDescription": "Every Airfield uses your location to find the cheapest fuel near you."})
        plist_path.write_bytes(plistlib.dumps(plist))
        fw = app / "Contents" / "Frameworks" / "Electron Framework.framework" / "Versions" / "A" / "Electron Framework"
        log(f"  fuses: {flip_fuses(fw)}")
        log("  signing (ad hoc) …")
        subprocess.run([signer, "sign", str(app)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        top, root_dir = "Every Airfield.app", app
    elif os_key == "windows":
        (stage / "resources" / "default_app.asar").unlink(missing_ok=True)
        put_app(stage / "resources" / "app", icons[512])
        (stage / "electron.exe").rename(stage / "Every Airfield.exe")
        log(f"  fuses: {flip_fuses(stage / 'Every Airfield.exe')}")
        top, root_dir = "Every Airfield", stage
    else:
        (stage / "resources" / "default_app.asar").unlink(missing_ok=True)
        put_app(stage / "resources" / "app", icons[512])
        (stage / "electron").rename(stage / "every-airfield")
        log(f"  fuses: {flip_fuses(stage / 'every-airfield')}")
        for f in ("start.sh", "add-to-menu.sh"):
            shutil.copy2(DESKTOP / "linux" / f, stage / f)
            os.chmod(stage / f, 0o755)
        (stage / "icon.png").write_bytes(icons[512])
        top, root_dir = "every-airfield", stage
    OUT.mkdir(exist_ok=True)
    zip_path = OUT / out_name
    log("  zipping …")
    if os_key == "mac":
        # the zip holds the .app itself at the top, as Mac users expect
        tmp_root = work / (platform + "-zip")
        tmp_root.mkdir()
        root_dir.rename(tmp_root / top)
        make_zip(tmp_root / top, top, zip_path)
    else:
        make_zip(root_dir, top, zip_path)
    info = {"file": out_name, "label": label, "size": zip_path.stat().st_size, "sha256": sha256(zip_path)}
    log(f"  {out_name}: {info['size'] / 1e6:.0f} MB")
    return os_key, info


def app_version():
    return json.loads((DESKTOP / "package.json").read_text())["version"]


def update_page(files, release):
    """Write the version, files, sizes and checksums into the DOWNLOADS block of index.html."""
    html_path = ROOT / "index.html"
    html = html_path.read_text(encoding="utf-8")
    m = re.search(r"  const DOWNLOADS = \{.*?\n  \};", html, re.S)
    if not m:
        raise SystemExit("Couldn't find the DOWNLOADS block in index.html.")
    files_js = json.dumps(files, indent=2).replace("\n", "\n    ")      # JSON is valid JavaScript
    block = ("  const DOWNLOADS = {\n"
             f"    version: {json.dumps(app_version())},\n"
             f"    release: {json.dumps(release)},\n"
             f"    files: {files_js},\n"
             "  };")
    html_path.write_text(html.replace(m.group(0), block), encoding="utf-8")
    subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "csp.py")], check=True)   # the script changed: new hash


def main():
    subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "csp.py")], check=True)   # policy matches the script
    args = sys.argv[1:]
    release = ""
    if "--release" in args:
        release = args[args.index("--release") + 1]
        if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", release):
            raise SystemExit("Use --release OWNER/REPO, e.g. --release yourname/every-airfield")
    only = args[args.index("--only") + 1] if "--only" in args else None
    targets = [t for t in TARGETS if not only or t[0] == only]
    log(f"Every Airfield {app_version()} with Electron {ELECTRON_VERSION}")
    log("Drawing the icon …")
    icons = {n: icon_png(n) for n in (128, 256, 512, 1024)}
    manifest_path = OUT / "manifest.json"
    files = json.loads(manifest_path.read_text()) if manifest_path.exists() and only else {}
    with tempfile.TemporaryDirectory() as tmp:
        for t in targets:
            res = build(t, icons, Path(tmp))
            if res:
                os_key, info = res
                files.setdefault(os_key, [])
                files[os_key] = [f for f in files[os_key] if f["file"] != info["file"]] + [info]
    order = [t[2] for t in TARGETS]
    for k in files:
        files[k].sort(key=lambda f: order.index(f["file"]) if f["file"] in order else 99)
    OUT.mkdir(exist_ok=True)
    manifest_path.write_text(json.dumps(files, indent=2))
    update_page(files, release)
    log(f"\nDone. Files are in {OUT}. index.html's Download page now lists them"
        + (f" from the GitHub release v{app_version()} of {release}." if release else " from the downloads/ folder."))
    if release:
        log(f"Next: on GitHub, open {release} → Releases → Draft a new release, set the tag to v{app_version()},")
        log("attach every .zip from downloads/, and publish. Then commit and push index.html.")


if __name__ == "__main__":
    main()
