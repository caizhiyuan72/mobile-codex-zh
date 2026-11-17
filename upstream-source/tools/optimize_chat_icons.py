#!/usr/bin/env python3
"""Compatibility entry point for the portable Node/WASM icon generator."""
from pathlib import Path
import subprocess
import sys

if __name__ == '__main__':
    subprocess.run(['node', str(Path(__file__).with_suffix('.mjs')), *sys.argv[1:]], check=True)
