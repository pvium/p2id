#!/bin/sh
# Copy the Solidity sources from ../../../ethereum/src into ./ethereum so they ship in the npm
# package and can be imported like `@pvium/p2id-core/ethereum/interfaces/IPviumIdentity.sol`.
# Source of truth is the Hardhat project; this copy is generated (gitignored) at build time.
set -e
cd "$(dirname "$0")/.."
rm -rf ethereum && mkdir -p ethereum
# Whole tree (interfaces/, lib/, top-level contracts), minus test mocks.
OUT="$(pwd)/ethereum"
(cd ../../../ethereum/src && find . -name '*.sol' -not -path './mocks/*' | while read f; do
  mkdir -p "$OUT/$(dirname "$f")" && cp "$f" "$OUT/$f"; done)
echo "synced $(find ethereum -name '*.sol' | wc -l | tr -d ' ') Solidity files"
