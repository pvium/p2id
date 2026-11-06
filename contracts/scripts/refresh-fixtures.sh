#!/bin/sh
# Copy the latest proof produced by `bb prove ... -o target/proof_email` in ../circuit
# into test/fixtures, and regenerate the Solidity verifier from its verification key.
#
# Every circuit version keeps its own generated verifier file, named in contracts/releases.json
# (circuits.<N>.zkVerifier, e.g. src/PviumZKVerifierV2.sol:PviumZKVerifierV2). The version being
# refreshed is circuit/version.json's circuitVersion. A version whose entry records a different vk
# is released: its file is not rewritten; bump circuitVersion and add an entry for the new one.
set -e
export PATH="$HOME/.bb:$PATH"
cd "$(dirname "$0")/.."
SRC=../circuit/target/proof_email
VERSION=$(node -p "require('../circuit/version.json').circuitVersion")
TARGET=$(node -p "(require('./releases.json').circuits['$VERSION'] || {}).zkVerifier || ''")
RELEASED_VK=$(node -p "(require('./releases.json').circuits['$VERSION'] || {}).vkHash || ''")
if [ -z "$TARGET" ]; then
  echo "circuit version $VERSION has no entry in contracts/releases.json." >&2
  echo "Add circuits.$VERSION with zkVerifier src/PviumZKVerifierV$VERSION.sol:PviumZKVerifierV$VERSION, its own PviumVerifier and the vk sha256, then run again." >&2
  exit 1
fi
VK_SHA="0x$(shasum -a 256 "$SRC/vk" | cut -d' ' -f1)"
if [ "$VK_SHA" != "$RELEASED_VK" ]; then
  echo "the compiled circuit's vk is $VK_SHA, but contracts/releases.json records $RELEASED_VK for circuit version $VERSION." >&2
  echo "A changed circuit is a new version: bump circuit/version.json and add its entry (a released verifier file is never rewritten)." >&2
  exit 1
fi
FILE=${TARGET%%:*}
NAME=${TARGET##*:}
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
bb write_solidity_verifier -k "$SRC/vk" -o "$FILE.tmp"
# bb names the contract HonkVerifier; we ship it under the version's name.
# (no `sed -i`: its syntax differs between GNU and BSD sed)
sed "s|^contract HonkVerifier is BaseZKHonkVerifier|contract $NAME is BaseZKHonkVerifier|" "$FILE.tmp" > "$FILE"
rm "$FILE.tmp"
echo "fixtures and $FILE ($NAME, circuit version $VERSION) refreshed"
