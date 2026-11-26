#!/usr/bin/env bash
# Make one Solana (Groth16) proof with an environment's proving key and check it against its
# verifying key. For tests and smoke checks; the http-prover does this in production.
#
#   sunspot-prove.sh <sandbox|production> [--name N] [--jwt FILE] [--pubkey PEM] [--type T] [--value V]
#                    [--wallet ADDRESS]
#
# Defaults: the repository's sample Privy token and key (circuit/test/fixtures), identity
# email test-9988@privy.io, the token's Solana wallet, name "sample-solana".
#
# Output in circuit/target/sunspot/<environment>/proofs/<name>.*:
#   .witness.gz   the Noir execution witness (contains the token: keep private)
#   .proof .pw    the Groth16 proof and Sunspot's serialized public witness (12 + 11*32 bytes)
#   .json         what a verifier call takes: base64 proof and public witness, the wallet, the hashes
#
# Needs `source .tools/env.sh` and a prior `sunspot-build.sh <environment>`.
set -euo pipefail

usage() { sed -n '2,17p' "$0"; exit 2; }
ENVIRONMENT=${1:-}
case "$ENVIRONMENT" in sandbox|production) ;; *) usage ;; esac
shift

CIRCUIT=$(cd "$(dirname "$0")/.." && pwd)
NAME=pvium_identity
OUT=$CIRCUIT/target/sunspot
ENV_OUT=$OUT/$ENVIRONMENT
STAGE=${P2ID_TOOLS_DIR:-$CIRCUIT/../.tools}/stage/$NAME
PROOF_NAME=sample-solana
JWT_FILE=$CIRCUIT/test/fixtures/sample_token.jwt
PUBKEY=$CIRCUIT/test/fixtures/privy_es256_public.pem
TYPE=email
VALUE=test-9988@privy.io
WALLET=EXnVUEeELHiYynvjoQ9YhgxfMSDJC6tJm7VkFQY2b8Wj
while [ $# -gt 0 ]; do
  case "$1" in
    --name) PROOF_NAME=$2; shift 2 ;;
    --jwt) JWT_FILE=$2; shift 2 ;;
    --pubkey) PUBKEY=$2; shift 2 ;;
    --type) TYPE=$2; shift 2 ;;
    --value) VALUE=$2; shift 2 ;;
    --wallet) WALLET=$2; shift 2 ;;
    *) usage ;;
  esac
done
: "${NARGO_SUNSPOT:?source .tools/env.sh first}"
: "${SUNSPOT_BIN:?source .tools/env.sh first}"
for f in "$OUT/$NAME.json" "$OUT/$NAME.ccs" "$ENV_OUT/$NAME.pk" "$ENV_OUT/$NAME.vk" "$STAGE/Nargo.toml"; do
  [ -e "$f" ] || { echo "missing $f: run sunspot-build.sh $ENVIRONMENT first" >&2; exit 1; }
done

PROOFS=$ENV_OUT/proofs
mkdir -p "$PROOFS"

# 1. Witness inputs from the token, then the execution witness with the same nargo that made the ACIR.
prover=Prover_$PROOF_NAME
gen_out=$(python3 "$CIRCUIT/scripts/gen_prover.py" --jwt "$(tr -d '\r\n' < "$JWT_FILE")" --pubkey "$PUBKEY" \
  --type "$TYPE" --value "$VALUE" ${WALLET:+--wallet "$WALLET"} -o "$STAGE/$prover.toml")
echo "$gen_out" | grep -E "identity_hash |wallet_hash |iat " || true
identity_hash=$(echo "$gen_out" | sed -n 's/^ *identity_hash *= *//p' | head -1)
wallet_hash=$(echo "$gen_out" | sed -n 's/^ *wallet_hash *= *//p' | head -1)
iat=$(echo "$gen_out" | sed -n 's/^ *iat *= *//p' | head -1)
(cd "$STAGE" && "$NARGO_SUNSPOT" execute --skip-brillig-constraints-check -p "$prover" "$PROOF_NAME" >/dev/null)
mv "$STAGE/target/$PROOF_NAME.gz" "$PROOFS/$PROOF_NAME.witness.gz"
rm -f "$STAGE/$prover.toml"

# 2. Prove, then verify. Sunspot names its outputs after the CCS, so prove against a per-proof link.
work=$(mktemp -d)
ln -s "$OUT/$NAME.ccs" "$work/$PROOF_NAME.ccs"
"$SUNSPOT_BIN" prove "$OUT/$NAME.json" "$PROOFS/$PROOF_NAME.witness.gz" "$work/$PROOF_NAME.ccs" "$ENV_OUT/$NAME.pk"
mv "$work/$PROOF_NAME.proof" "$PROOFS/$PROOF_NAME.proof"
mv "$work/$PROOF_NAME.pw" "$PROOFS/$PROOF_NAME.pw"
rm -rf "$work"
"$SUNSPOT_BIN" verify "$ENV_OUT/$NAME.vk" "$PROOFS/$PROOF_NAME.proof" "$PROOFS/$PROOF_NAME.pw"

# 3. The verifier call's inputs, as http-prover's attestation carries them.
zk_program=$(solana-keygen pubkey "$ENV_OUT/$NAME-keypair.json" 2>/dev/null || echo null)
python3 - "$PROOFS/$PROOF_NAME" "$ENVIRONMENT" "$TYPE" "$WALLET" "$identity_hash" "$wallet_hash" "$iat" "$zk_program" "$ENV_OUT/$NAME.vk" <<'EOF'
import base64, hashlib, json, sys
base, env, typ, wallet, identity_hash, wallet_hash, iat, zk, vk = sys.argv[1:]
proof = open(base + ".proof", "rb").read()
pw = open(base + ".pw", "rb").read()
doc = {
    "network": "solana",
    "environment": env,
    "circuitVersion": 2,
    "identityType": typ,
    "wallet": wallet or None,
    "identityHash": identity_hash or None,
    "walletHash": wallet_hash or None,
    "iat": int(iat) if iat else None,
    "zkVerifier": None if zk == "null" else zk,
    "vkHash": "0x" + hashlib.sha256(open(vk, "rb").read()).hexdigest(),
    "proof": base64.b64encode(proof).decode(),
    "publicWitness": base64.b64encode(pw).decode(),
    "publicInputs": base64.b64encode(pw).decode(),
}
json.dump(doc, open(base + ".json", "w"), indent=2)
print(f"proof {len(proof)} bytes, public witness {len(pw)} bytes -> {base}.json")
EOF
