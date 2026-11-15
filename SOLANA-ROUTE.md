The following steps compile the Noir circuit and prepare the Sunspot artifacts used for Solana
proof generation. Run the circuit commands from the repository root.

Change to the circuit directory:

```bash
cd ./circuit
```

Compile the Noir circuit and generate its build artifacts:

```bash
nargo compile
```

Compile the generated ACIR into a constraint system (CCS) for Sunspot:

```bash
sunspot compile target/pvium_identity.json
```

For Sunspot installation and troubleshooting, see the
[Sunspot installation guide](https://github.com/reilabs/sunspot/blob/main/INSTALLATION.md).

Generate local proving and verification keys from the CCS:

```bash
sunspot setup target/pvium_identity.ccs
```

> **Warning:** Sunspot's built-in setup is for local testing only. It is not a production trusted
> setup. Use an appropriately conducted trusted setup for production deployments.

Build the Solana verifier program using the generated verification key:

```bash
sunspot deploy target/pvium_identity.vk
```

If Sunspot reports that `GNARK_VERIFIER_BIN` is not set, configure it to point to the Rust
`verifier-bin` crate directory as described in the
[installation guide](https://github.com/reilabs/sunspot/blob/main/INSTALLATION.md#configure-gnark_verifier_bin).

## Start the HTTP prover

In a terminal, install the HTTP prover dependencies, create a local `.env` file if one does not
already exist, and start the development server:

```bash
cd /http-prover
yarn install
test -f .env || cp .env.example .env
yarn dev
```

Keep the server running while you send requests from another terminal.

## Test the Ethereum and Solana endpoints

These examples use the repository's sample test token and linked account values. The token and
its signing key are test fixtures and must not be used in production.

### Ethereum

This request selects Barretenberg as the proof backend:

```bash
cd /Users/victorsamuel/Desktop/p2id/http-prover && set -a && source .env && set +a && JWT="$(tr -d '\r\n' < ../circuit/test/fixtures/sample_token.jwt)" && curl --fail-with-body --silent --show-error -X POST http://127.0.0.1:8787/attestations -H "Authorization: Bearer ${AUTH_TOKEN}" -H 'Content-Type: application/json' --data-raw "{\"identityType\":\"email\",\"identityValue\":\"test-9988@privy.io\",\"wallet\":\"0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98\",\"jwt\":\"${JWT}\",\"network\":\"ethereum\"}"
```

### Solana

This request selects Sunspot and returns a Groth16 proof with its public witness:

```bash
cd /Users/victorsamuel/Desktop/p2id/http-prover && set -a && source .env && set +a && JWT="$(tr -d '\r\n' < ../circuit/test/fixtures/sample_token.jwt)" && curl --fail-with-body --silent --show-error -X POST http://127.0.0.1:8787/attestations -H "Authorization: Bearer ${AUTH_TOKEN}" -H 'Content-Type: application/json' --data-raw "{\"identityType\":\"email\",\"identityValue\":\"test-9988@privy.io\",\"wallet\":\"0xA01b6E60D51eDB3fEB9f86a62b846f4F90070f98\",\"jwt\":\"${JWT}\",\"network\":\"solana\"}"
```

## Configure request values manually

Alternatively, run the following commands in a second terminal to export request values
individually.

Change to the HTTP prover directory:

```bash
cd ./http-prover
```

Load and export the API secret from `.env` for use in the curl request:

```bash
set -a && source .env && set +a
```

Set `JWT` to a Privy identity token. The token must be signed by a key trusted by the prover and
must link the requested identity and wallet.

```bash
export JWT='<YOUR_PRIVY_JWT>'
```

Set the identity type, identity value and linked payout wallet:

```bash
export IDENTITY_TYPE='email'
export IDENTITY_VALUE='test-9988@privy.io'
export WALLET=<wallet-address>
```

Choose the proof network. Supported values are `ethereum` and `solana`; Ethereum uses Barretenberg
and Solana uses Sunspot.

```bash
export NETWORK='ethereum'
```

For a Solana proof, select Sunspot:

```bash
export NETWORK='solana'
```

```bash
curl --fail-with-body --silent --show-error \
  -X POST http://127.0.0.1:8787/attestations \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-raw "{\"identityType\":\"${IDENTITY_TYPE}\",\"identityValue\":\"${IDENTITY_VALUE}\",\"wallet\":\"${WALLET}\",\"jwt\":\"${JWT}\",\"network\":\"${NETWORK}\"}"
```

Save the returned Solana response to `solana-test/data.json`. The test client reads the
`network`, `proof`, and `publicWitness` (or `publicInputs`) fields from that file.

## Deploy and test the Anchor wrapper on localnet

These are the final Solana integration steps: the circuit/Sunspot artifacts and the Solana
attestation should already be prepared. First, build the Anchor wrapper. From the repository root,
run the key-generation commands only the first time; they create the wrapper's program ID:

```bash
cd solana-anchor
mkdir -p target/deploy
solana-keygen new -o target/deploy/p2id_solana_verifier-keypair.json --no-bip39-passphrase
anchor keys sync
anchor build
```

Keep the generated keypair private and out of version control. `anchor keys sync` updates the
wrapper ID in `Anchor.toml` and `programs/p2id_solana_verifier/src/lib.rs`. On later runs, reuse
that keypair and run `anchor build` without generating another one.

Start a local validator with the Sunspot verifier loaded. From the repository root, run this in
Terminal 1:

```bash
solana-test-validator --reset \
  --bpf-program circuit/target/pvium_identity-keypair.json circuit/target/pvium_identity.so
```

In another terminal, derive and print the verifier's public program ID from the keypair file:

```bash
solana address -k circuit/target/pvium_identity-keypair.json
```

Use the printed address as `SUNSPOT_VERIFIER_PROGRAM_ID`. This command prints only the public
address; do not share or commit the keypair file.

In Terminal 2, deploy the Anchor wrapper to that validator and check that it is deployed:

```bash
cd solana-anchor
solana airdrop 5 --url http://127.0.0.1:8899
anchor deploy
solana program show "$(solana address -k target/deploy/p2id_solana_verifier-keypair.json)" \
  --url http://127.0.0.1:8899
```

With the validator still running, prepare the test client in another terminal. Ensure
`solana-test/data.json` contains the Solana attestation response. Create its local environment file
from the example if needed, then set the public program IDs and run the Anchor path:

```bash
cd solana-test
npm install
npm run verify:anchor
npm run verify:direct
```

The client submits the proof through the Anchor wrapper and checks that the wrapper returns `[1]`.
`--reset` starts a fresh local ledger. To keep an existing ledger, omit `--reset`; the Sunspot
verifier must already be present in that ledger. For further details, see the
[Anchor wrapper README](solana-anchor/README.md). To run the original direct verifier client
instead, set `VERIFIER_PROGRAM_ID` in `solana-test/.env` and run `yarn verify:direct` from
`solana-test/`.
