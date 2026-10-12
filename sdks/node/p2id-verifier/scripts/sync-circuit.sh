#!/bin/sh
# Add (or refresh) the current circuit version's vk and sample proof from ../../../circuit after
# re-proving there. Each version lives in src/circuits/v<N>.{vk,json}; earlier versions are kept,
# so the package keeps verifying every attestation version it has shipped.
set -e
cd "$(dirname "$0")/.."
C=../../../circuit
V=$(node -p "require('$C/version.json').circuitVersion")
mkdir -p src/circuits
cp $C/target/proof_email/vk src/circuits/v$V.vk
cp $C/version.json src/circuits/v$V.json
cp $C/target/proof_email/proof test/fixtures/email.proof
cp $C/target/proof_email/public_inputs test/fixtures/email.public_inputs
cp $C/test/fixtures/privy_es256_public.pem $C/test/fixtures/sample_token.jwt test/fixtures/
echo "synced circuit version $V (vk and fixtures) from circuit"
