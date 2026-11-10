"""Credentials for operator API clients, scoped to the chosen endpoint."""
from __future__ import annotations

import os
from urllib.parse import urlsplit


def api_headers(api: str) -> dict[str, str]:
    key = os.environ.get('CODERFLEET_API_KEY')
    if key is None and urlsplit(api).hostname in {'localhost', '127.0.0.1', '::1'}:
        from coderfleet.config import get_workspace
        path = get_workspace() / 'api_key.txt'
        if path.is_file():
            key = path.read_text(encoding='utf-8').strip()
    return {'Authorization': f'Bearer {key}'} if key else {}
