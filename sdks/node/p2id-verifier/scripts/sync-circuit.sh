#!/bin/sh
# Add (or refresh) the current circuit version's verification keys and sample proofs from
# ../../../circuit after re-proving there. Earlier versions are kept, so the package keeps
# verifying every attestation version it has shipped.
#
#   sync-circuit.sh                  Ethereum: src/circuits/v<N>.{vk,json}, test/fixtures/email.*
#   sync-circuit.sh --solana <env>   Solana:   src/circuits/solana/<env>.v<N>.{vk,json},
#                                              test/fixtures/solana/<env>.v<N>.{proof,pw,json}
#
# The Solana key is the Sunspot vk of that environment's trusted setup
# (circuit/scripts/sunspot-build.sh <env>), with its sample proof from sunspot-prove.sh <env>.
set -e
cd "$(dirname "$0")/.."
C=../../../circuit
V=$(node -p "require('$C/version.json').circuitVersion")

if [ "$1" = "--solana" ]; then
  ENV=$2
  case "$ENV" in production|sandbox) ;; *) echo "usage: sync-circuit.sh --solana <production|sandbox>" >&2; exit 2 ;; esac
  S=$C/target/sunspot/$ENV
  [ -f "$S/pvium_identity.vk" ] || { echo "no $S/pvium_identity.vk: run circuit/scripts/sunspot-build.sh $ENV" >&2; exit 1; }
  [ -f "$S/proofs/sample-solana.proof" ] || { echo "no sample proof: run circuit/scripts/sunspot-prove.sh $ENV" >&2; exit 1; }
  mkdir -p src/circuits/solana test/fixtures/solana
  cp "$S/pvium_identity.vk" "src/circuits/solana/$ENV.v$V.vk"
  cp "$S/proofs/sample-solana.proof" "test/fixtures/solana/$ENV.v$V.proof"
  cp "$S/proofs/sample-solana.pw" "test/fixtures/solana/$ENV.v$V.pw"
  cp "$S/proofs/sample-solana.json" "test/fixtures/solana/$ENV.v$V.json"
  node - "$ENV" "$V" "$S" <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [env, v, s] = process.argv.slice(2);
const vk = readFileSync(`${s}/pvium_identity.vk`);
const sample = JSON.parse(readFileSync(`${s}/proofs/sample-solana.json`, 'utf8'));
let zkVerifier = sample.zkVerifier ?? null;
try { zkVerifier = execFileSync('solana-keygen', ['pubkey', `${s}/pvium_identity-keypair.json`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const vkSha256 = '0x' + createHash('sha256').update(vk).digest('hex');
if (sample.vkHash !== vkSha256) throw new Error(`sample proof is for vk ${sample.vkHash}, the vk hashes to ${vkSha256}: re-run sunspot-prove.sh ${env}`);
if (sample.circuitVersion !== Number(v)) throw new Error(`sample proof is circuit version ${sample.circuitVersion}, version.json says ${v}`);
const meta = { circuitVersion: Number(v), environment: env, vkSha256, zkVerifier, notes: `Sunspot verifying key of the ${env} trusted setup for circuit version ${v}; zkVerifier is the Solana program built from it.` };
writeFileSync(`src/circuits/solana/${env}.v${v}.json`, JSON.stringify(meta, null, 2) + '\n');
console.log(`synced Solana circuit version ${v} (${env}): vk ${vkSha256}, program ${zkVerifier}`);
EOF
  exit 0
fi

mkdir -p src/circuits
cp $C/target/proof_email/vk src/circuits/v$V.vk
cp $C/version.json src/circuits/v$V.json
cp $C/target/proof_email/proof test/fixtures/email.proof
cp $C/target/proof_email/public_inputs test/fixtures/email.public_inputs
cp $C/test/fixtures/privy_es256_public.pem $C/test/fixtures/sample_token.jwt test/fixtures/
echo "synced circuit version $V (vk and fixtures) from circuit"
