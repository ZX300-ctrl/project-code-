#!/usr/bin/env python3
"""Minimal dashboard-only server if the full bridge fails."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
from serial_bridge import HTTP_HOST, HTTP_PORT, start_http

if __name__ == "__main__":
    print(f"HTTP only: http://{HTTP_HOST}:{HTTP_PORT}/")
    start_http()
