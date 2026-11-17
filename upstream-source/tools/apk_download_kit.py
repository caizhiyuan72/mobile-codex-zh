#!/usr/bin/env python3
"""Transfer a source-built APK using verified compressed members from an older APK.

The reconstructed unsigned APK must match the complete CI APK byte for byte.
This changes distribution size, never the build or application contents.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import zipfile

CHUNK = 256 * 1024
MAX_APK = 512 * 1024 * 1024


def file_hash(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def transfer(source, destination, length):
    hashed = hashlib.sha256()
    while length:
        block = source.read(min(CHUNK, length))
        if not block:
            raise ValueError('Truncated APK or kit')
        destination.write(block)
        hashed.update(block)
        length -= len(block)
    return hashed.hexdigest()


def member_offset(stream, member):
    stream.seek(member.header_offset)
    header = stream.read(30)
    if len(header) != 30 or header[:4] != b'PK\x03\x04':
        raise ValueError('Invalid local APK header')
    name, extra = struct.unpack_from('<HH', header, 26)
    return member.header_offset + 30 + name + extra


def make_kit(apk, directory, threshold=1024 * 1024):
    apk, directory = Path(apk), Path(directory)
    if not 0 < apk.stat().st_size <= MAX_APK:
        raise ValueError('APK size is outside limits')
    directory.mkdir(parents=True, exist_ok=True)
    skeleton = directory / 'apk-skeleton.bin'
    recipe = []
    previous = 0
    with zipfile.ZipFile(apk) as archive, apk.open('rb') as source, skeleton.open('wb') as literal:
        if len(set(archive.namelist())) != len(archive.namelist()):
            raise ValueError('Duplicate APK members')
        members = sorted(archive.infolist(), key=lambda item: item.header_offset)
        for member in members:
            # DEX, resources and manifests depend on the commit/build variant.
            # Only runtime/devtool members are eligible for reuse across builds.
            if (member.compress_size < threshold or not member.filename.startswith(
                    ('lib/', 'assets/runtime/', 'assets/devtools/'))):
                continue
            offset = member_offset(source, member)
            if offset < previous or offset + member.compress_size > archive.start_dir:
                raise ValueError('Overlapping APK members')
            source.seek(previous)
            length = offset - previous
            recipe.append({'literal': literal.tell(), 'length': length})
            transfer(source, literal, length)
            digest = hashlib.sha256()
            length = member.compress_size
            while length:
                block = source.read(min(CHUNK, length))
                if not block:
                    raise ValueError('Truncated APK member')
                digest.update(block)
                length -= len(block)
            recipe.append({'member': member.filename, 'length': member.compress_size,
                           'method': member.compress_type, 'sha256': digest.hexdigest()})
            previous = offset + member.compress_size
        source.seek(previous)
        length = apk.stat().st_size - previous
        recipe.append({'literal': literal.tell(), 'length': length})
        transfer(source, literal, length)
    metadata = {'schema': 1, 'apk': apk.name, 'apkBytes': apk.stat().st_size,
                'apkSha256': file_hash(apk), 'skeletonSha256': file_hash(skeleton),
                'skeletonBytes': skeleton.stat().st_size, 'recipe': recipe}
    (directory / 'apk-reconstruction.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return metadata


def reconstruct(base, directory, destination):
    base, directory, destination = Path(base), Path(directory), Path(destination)
    metadata_path = directory / 'apk-reconstruction.json'
    if metadata_path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('Kit metadata exceeds limit')
    data = json.loads(metadata_path.read_text())
    skeleton = directory / 'apk-skeleton.bin'
    if (data['schema'] != 1 or not 0 < data['apkBytes'] <= MAX_APK
            or skeleton.stat().st_size != data['skeletonBytes']
            or file_hash(skeleton) != data['skeletonSha256']):
        raise ValueError('Invalid kit identity or skeleton checksum')
    if len(data['recipe']) > 20000 or sum(part['length'] for part in data['recipe']) != data['apkBytes']:
        raise ValueError('Invalid reconstruction size')
    if destination.exists():
        if file_hash(destination) == data['apkSha256']:
            return destination
        raise FileExistsError('Refusing to replace an existing different APK')
    temporary = None
    try:
        with zipfile.ZipFile(base) as archive, base.open('rb') as source, skeleton.open('rb') as literal, tempfile.NamedTemporaryFile(
                prefix='.apk-kit-', suffix='.tmp', dir=destination.parent, delete=False) as target:
            temporary = Path(target.name)
            if len(set(archive.namelist())) != len(archive.namelist()):
                raise ValueError('Duplicate base APK members')
            for part in data['recipe']:
                length = part['length']
                if type(length) is not int or not 0 <= length <= MAX_APK:
                    raise ValueError('Invalid reconstruction segment')
                if 'literal' in part:
                    offset = part['literal']
                    if type(offset) is not int or offset < 0 or offset + length > data['skeletonBytes']:
                        raise ValueError('Invalid literal range')
                    literal.seek(offset)
                    transfer(literal, target, length)
                else:
                    member = archive.getinfo(part['member'])
                    if member.compress_size != length or member.compress_type != part['method']:
                        raise ValueError('Base APK member differs: ' + member.filename)
                    offset = member_offset(source, member)
                    source.seek(offset)
                    if transfer(source, target, length) != part['sha256']:
                        raise ValueError('Base APK compressed checksum differs: ' + member.filename)
        if temporary.stat().st_size != data['apkBytes'] or file_hash(temporary) != data['apkSha256']:
            raise ValueError('Reconstructed APK differs from complete CI APK')
        temporary.rename(destination)
        return destination
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('make')
    make.add_argument('apk', type=Path)
    make.add_argument('directory', type=Path)
    restore = commands.add_parser('reconstruct')
    restore.add_argument('base', type=Path)
    restore.add_argument('directory', type=Path)
    restore.add_argument('destination', type=Path)
    args = parser.parse_args()
    if args.command == 'make':
        info = make_kit(args.apk, args.directory)
        print(json.dumps({key: value for key, value in info.items() if key != 'recipe'}, indent=2))
    else:
        print(reconstruct(args.base, args.directory, args.destination))


if __name__ == '__main__':
    main()
