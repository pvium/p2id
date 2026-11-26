#!/usr/bin/env bash
# Build the Solana (Sunspot) verifier for the P2ID circuit, for one environment:
#
#   sunspot-build.sh sandbox      keys from `sunspot setup` (single party, NOT a trusted setup):
#                                 devnet and local testing only
#   sunspot-build.sh production   keys from the phase-2 ceremony (sunspot-ceremony.sh), which must
#                                 have produced target/sunspot/production/pvium_identity.{pk,vk}
#
# Steps, each skipped when its output is newer than its inputs:
#   1. nargo compile with the Noir release Sunspot reads (NARGO_SUNSPOT, 1.0.0-beta.22), in a staging
#      copy outside circuit/ (nargo resolves the outermost package above the working directory) so
#      the EVM path's artifact in target/ (newer nargo + Barretenberg) is left alone. beta.22's
#      Brillig-constraint lint rejects the sha256 library this circuit uses (a false positive the
#      later compiler no longer reports); the lint is skipped, which changes nothing in the circuit.
#   2. sunspot compile: ACIR -> gnark R1CS (.ccs); shared by both environments
#   3. keys: sandbox -> sunspot setup; production -> require the ceremony's keys
#   4. sunspot deploy: the Groth16 verifier program (.so) with the vk baked in, plus its program
#      keypair. An existing keypair is kept: the P2ID verifier is built against this program id.
#
# Output: circuit/target/sunspot/pvium_identity.{json,ccs} and
#         circuit/target/sunspot/<environment>/pvium_identity.{pk,vk,so,-keypair.json}
# solana-anchor/releases.json points at these paths; `yarn deploy --cluster <c>` deploys them.
#
# Needs `source .tools/env.sh` (circuit/scripts/sunspot-install.sh).
set -euo pipefail

usage() { sed -n '2,20p' "$0"; exit 2; }
ENVIRONMENT=${1:-}
case "$ENVIRONMENT" in sandbox|production) ;; *) usage ;; esac
shift
FORCE=0
for arg in "$@"; do
  case "$arg" in --force) FORCE=1 ;; *) usage ;; esac
done

CIRCUIT=$(cd "$(dirname "$0")/.." && pwd)
NAME=pvium_identity
OUT=$CIRCUIT/target/sunspot
ENV_OUT=$OUT/$ENVIRONMENT
STAGE=${P2ID_TOOLS_DIR:-$CIRCUIT/../.tools}/stage/$NAME
: "${NARGO_SUNSPOT:?source .tools/env.sh first (circuit/scripts/sunspot-install.sh)}"
: "${SUNSPOT_BIN:?source .tools/env.sh first}"
: "${GNARK_VERIFIER_BIN:?source .tools/env.sh first}"
command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH (Solana CLI)" >&2; exit 1; }
command -v solana-keygen >/dev/null || { echo "solana-keygen not on PATH (Solana CLI)" >&2; exit 1; }

mkdir -p "$ENV_OUT"
newest_src=$(find "$CIRCUIT/src" "$CIRCUIT/Nargo.toml" -type f -newer "$OUT/$NAME.json" 2>/dev/null | head -1 || true)
fresh() { # fresh <output> <inputs...>: output exists and is newer than every input
  [ "$FORCE" = 0 ] || return 1
  [ -f "$1" ] || return 1
  local out=$1; shift
  for input in "$@"; do [ "$out" -nt "$input" ] || return 1; done
}

# 1. ACIR
if fresh "$OUT/$NAME.json" "$CIRCUIT/Nargo.toml" && [ -z "$newest_src" ]; then
  echo "ACIR up to date: $OUT/$NAME.json"
else
  echo "Compiling $NAME with $("$NARGO_SUNSPOT" --version | head -1)"
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  cp "$CIRCUIT/Nargo.toml" "$STAGE/" && cp -R "$CIRCUIT/src" "$STAGE/src"
  (cd "$STAGE" && "$NARGO_SUNSPOT" compile --skip-brillig-constraints-check)
  cp "$STAGE/target/$NAME.json" "$OUT/$NAME.json"
  echo "ACIR: $OUT/$NAME.json"
fi

# 2. R1CS
if fresh "$OUT/$NAME.ccs" "$OUT/$NAME.json"; then
  echo "CCS up to date: $OUT/$NAME.ccs"
else
  (cd "$OUT" && "$SUNSPOT_BIN" compile "$NAME.json")
fi
if [ -n "${CCSINFO_BIN:-}" ] && [ -x "$CCSINFO_BIN" ]; then
  "$CCSINFO_BIN" "$OUT/$NAME.ccs"
fi

# 3. Keys
ln -sfn "../$NAME.ccs" "$ENV_OUT/$NAME.ccs"
case "$ENVIRONMENT" in
  sandbox)
    if fresh "$ENV_OUT/$NAME.vk" "$OUT/$NAME.ccs" && fresh "$ENV_OUT/$NAME.pk" "$OUT/$NAME.ccs"; then
      echo "sandbox keys up to date"
    else
      echo "WARNING: single-party Groth16 setup; whoever ran it could forge proofs. Sandbox only."
      (cd "$ENV_OUT" && "$SUNSPOT_BIN" setup "$NAME.ccs")
    fi
    ;;
  production)
    if [ ! -f "$ENV_OUT/$NAME.vk" ] || [ ! -f "$ENV_OUT/$NAME.pk" ]; then
      echo "production keys missing: $ENV_OUT/$NAME.{pk,vk} come from the ceremony (sunspot-ceremony.sh finish)" >&2
      exit 1
    fi
    if [ "$OUT/$NAME.ccs" -nt "$ENV_OUT/$NAME.vk" ]; then
      echo "the constraint system changed after the ceremony keys were made; a new circuit needs a new ceremony" >&2
      exit 1
    fi
    ;;
esac

# 4. Verifier program
if fresh "$ENV_OUT/$NAME.so" "$ENV_OUT/$NAME.vk"; then
  echo "verifier program up to date: $ENV_OUT/$NAME.so"
else
  keypair=$ENV_OUT/$NAME-keypair.json
  kept=""
  if [ -f "$keypair" ]; then kept=$(mktemp) && cp "$keypair" "$kept"; fi
  (cd "$ENV_OUT" && "$SUNSPOT_BIN" deploy "$NAME.vk")
  if [ -n "$kept" ]; then
    cp "$kept" "$keypair" && rm -f "$kept"
    echo "kept the existing program keypair (the P2ID verifier is built for its id)"
  fi
fi

vk_hash=$(shasum -a 256 "$ENV_OUT/$NAME.vk" | cut -d' ' -f1)
program_id=$(solana-keygen pubkey "$ENV_OUT/$NAME-keypair.json")
cat <<EOF

$ENVIRONMENT Sunspot verifier
  program id : $program_id   ($ENV_OUT/$NAME-keypair.json)
  program    : $ENV_OUT/$NAME.so ($(stat -f%z "$ENV_OUT/$NAME.so") bytes)
  vk sha256  : 0x$vk_hash   (releases.json circuits.2.zkVerifier.$ENVIRONMENT.vkHash)
  proving key: $ENV_OUT/$NAME.pk (SUNSPOT_PK_PATH for http-prover, with SUNSPOT_CCS_PATH=$OUT/$NAME.ccs
               and SUNSPOT_ACIR_PATH=$OUT/$NAME.json)

Next: cd solana-anchor && yarn deploy --cluster <devnet|mainnet>   (deploys it, builds the P2ID
verifier with P2ID_ZK_VERIFIER=$program_id, records the vkHash)
EOF
case "$ENVIRONMENT" in production)
  echo "Vault $ENV_OUT/$NAME-keypair.json and point SOL_ZK_VERIFIER_KEYPAIR_PROD at the vaulted copy." ;;
esac
