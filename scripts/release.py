"""Create the bridge-v1 release asset from the production PWA."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
site = root / "dist/code"
for name in ("index.html", "manifest.webmanifest", "sw.js", "THIRD_PARTY_NOTICES.md"):
    if not (site / name).is_file():
        raise SystemExit(f"Missing build output: {name}")
with ZipFile(root / "dist/WorkCode-v1.zip", "w") as output:
    for file in sorted(site.rglob("*")):
        if file.is_file():
            entry = ZipInfo(file.relative_to(site).as_posix())
            entry.create_system = 3
            output.writestr(entry, file.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
