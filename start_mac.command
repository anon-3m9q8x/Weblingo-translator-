#!/bin/bash
cd "$(dirname "$0")" || exit 1
python3 -m pip install -r requirements.txt || exit 1
python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
