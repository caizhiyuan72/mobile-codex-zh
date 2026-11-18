#!/usr/bin/env python3
"""Package only public signing setup helpers; never keys or recovery files."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile
from setup_api_signing import expected_runtime

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    expected_runtime()
    files = ['setup_api_signing.py', 'crypto-helper.cjs', 'bootstrap-files.json',
             'package.json', 'package-lock.json', 'README.md']
    files.extend(name for name in json.loads((ROOT / 'bootstrap-files.json').read_text()) if name not in files)
    # npm package licenses are part of the redistribution.
    files.extend(['node_modules/libsodium/LICENSE', 'node_modules/libsodium-wrappers/LICENSE'])
    hashes = {name:hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}
    with zipfile.ZipFile(args.output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in files: archive.write(ROOT / name, 'api-signing-setup/' + name)
        archive.writestr('api-signing-setup/SHA256SUMS', ''.join(digest + '  ' + name + '\n' for name, digest in hashes.items()))
    print('Public setup bundle SHA-256:', hashlib.sha256(args.output.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
