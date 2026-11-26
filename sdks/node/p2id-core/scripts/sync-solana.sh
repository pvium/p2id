#!/bin/sh
# Copy the Anchor IDLs of the Solana programs from ../../../solana-anchor/target/idl into
# ./solana/idl so they ship in the npm package (`@pvium/p2id-core/solana/idl/p2id_vault.json`).
# Source of truth is the Anchor workspace; this copy is generated (gitignored) at build time and
# requires `anchor build` to have run there.
set -e
cd "$(dirname "$0")/.."
SRC=../../../solana-anchor/target/idl
rm -rf solana/idl && mkdir -p solana/idl
n=0
for p in p2id_router p2id_policy p2id_vault p2id_solana_verifier; do
  if [ -f "$SRC/$p.json" ]; then cp "$SRC/$p.json" solana/idl/ && n=$((n + 1)); else echo "missing $SRC/$p.json (run anchor build in solana-anchor); IDL not shipped" >&2; fi
done
echo "synced $n Anchor IDLs"
