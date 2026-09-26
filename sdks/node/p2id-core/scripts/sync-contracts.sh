#!/bin/sh
# Copy the Solidity sources from ../../../contracts/src into ./contracts so they ship in the npm
# package and can be imported like `@pvium/p2id-core/contracts/interfaces/IPviumIdentity.sol`.
# Source of truth is the Hardhat project; this copy is generated (gitignored) at build time.
set -e
cd "$(dirname "$0")/.."
rm -rf contracts && mkdir -p contracts
# Whole tree (interfaces/, lib/, top-level contracts), minus test mocks.
OUT="$(pwd)/contracts"
(cd ../../../contracts/src && find . -name '*.sol' -not -path './mocks/*' | while read f; do
  mkdir -p "$OUT/$(dirname "$f")" && cp "$f" "$OUT/$f"; done)
echo "synced $(find contracts -name '*.sol' | wc -l | tr -d ' ') Solidity files"
