#!/bin/sh
# Copy the latest proof produced by `bb prove ... -o target/proof_email` in ../circuit
# into test/fixtures, and regenerate the Solidity verifier from its verification key.
set -e
export PATH="$HOME/.bb:$PATH"
cd "$(dirname "$0")/.."
SRC=../circuit/target/proof_email
cp "$SRC/proof" test/fixtures/email.proof
cp "$SRC/public_inputs" test/fixtures/email.public_inputs
cp "$SRC/vk_hash" test/fixtures/vk_hash
cp ../circuit/test/fixtures/sample_token.jwt test/fixtures/sample_token.jwt
cp ../circuit/test/fixtures/privy_es256_public.pem test/fixtures/privy_es256_public.pem
# Email proven from a Google-only dummy token (test key), for CircuitV2EmailSources.test.ts:
# `bb prove ... -o target/proof_google` after gen_prover.py --type email on that token.
if [ -d ../circuit/target/proof_google ]; then
  cp ../circuit/target/proof_google/proof test/fixtures/google_email.proof
  cp ../circuit/target/proof_google/public_inputs test/fixtures/google_email.public_inputs
  cp ../circuit/test/fixtures/test_es256_public.pem test/fixtures/test_es256_public.pem
fi
bb write_solidity_verifier -k "$SRC/vk" -o src/PviumZKVerifier.sol
# bb names the contract HonkVerifier; we ship it as PviumZKVerifier.
# (no `sed -i`: its syntax differs between GNU and BSD sed)
sed 's|^contract HonkVerifier is BaseZKHonkVerifier|contract PviumZKVerifier is BaseZKHonkVerifier|' src/PviumZKVerifier.sol > src/PviumZKVerifier.sol.tmp
mv src/PviumZKVerifier.sol.tmp src/PviumZKVerifier.sol
echo "fixtures and verifier refreshed"
