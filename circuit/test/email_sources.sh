#!/bin/sh
# Email sources: an email identity proven from Privy email, Google, LinkedIn and Apple accounts
# hashes the same; forged sources are rejected. Requires nargo and node on PATH.
set -e
cd "$(dirname "$0")/.."
python3 test/email_sources.py
