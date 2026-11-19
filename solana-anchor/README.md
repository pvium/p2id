# P2ID Solana verifier wrapper

This Anchor program forwards a Sunspot proof to a caller-selected verifier program using a
cross-program invocation (CPI). It passes the proof bytes followed by the serialized public
witness bytes, matching the interface used by
[`solana-test/verify-anchor.js`](../solana-test/verify-anchor.js).
The instruction succeeds only if the CPI succeeds. On success, the wrapper sets Solana return data
to the single byte `1`.

The verifier program ID is an instruction argument and its executable account is also supplied
to the instruction. The program checks that the account key equals the requested ID and that the
account is executable. The caller must still choose and trust the correct verifier: an arbitrary
executable program could return success without verifying the proof.

## Build

The workspace is configured for Anchor CLI 1.1.2 and Solana CLI 3.1.10. To set up a deployable
program ID, create a program keypair locally and synchronize the declared ID:

```sh
cd solana-anchor
mkdir -p target/deploy
solana-keygen new -o target/deploy/p2id_solana_verifier-keypair.json --no-bip39-passphrase
anchor keys sync
anchor build
```

Keep the generated keypair private and out of version control. `anchor keys sync` updates the
program ID in `Anchor.toml` and `programs/p2id_solana_verifier/src/lib.rs` to match it.

## Instruction

`verify(verifier_program_id, proof, public_witness)` takes:

- `verifier_program_id`: the deployed Sunspot verifier program address.
- `proof`: the decoded bytes from the prover response's base64 `proof` field.
- `public_witness`: the decoded bytes from `publicWitness` (or Solana `publicInputs`).

The verifier CPI receives `proof || public_witness` as its instruction data and no account metas,
matching Sunspot's stateless verifier interface. The combined payload is capped at 900 bytes.
The local sample response is 388 proof bytes plus 76 public-witness bytes.

The outer transaction must include a compute-budget instruction sized for the verifier. The
existing direct-verifier example uses 600,000 units; CPI adds wrapper overhead, so simulate the
transaction and increase the budget as needed, up to the cluster's transaction limit. A successful
Anchor instruction means the CPI returned successfully; return data is `[1]`.

## Local test setup

Build the Sunspot verifier and the Anchor wrapper first. The following commands assume the
Sunspot artifacts are in `circuit/target` and that the wrapper keypair was created at
`solana-anchor/target/deploy/p2id_solana_verifier-keypair.json`.

In Terminal 1, from the repository root, start a fresh local validator with the Sunspot verifier
preloaded at the address derived from its keypair:

```sh
solana-test-validator --reset \
  --bpf-program circuit/target/pvium_identity-keypair.json circuit/target/pvium_identity.so
```

In another terminal, derive and print the verifier's public program ID from its keypair file:

```sh
solana address -k circuit/target/pvium_identity-keypair.json
```

Use the printed address as `SUNSPOT_VERIFIER_PROGRAM_ID`. The command prints only the public
address; keep the keypair file private.

In Terminal 2, deploy the Anchor wrapper and confirm its program is visible on the local
validator:

```sh
cd solana-anchor
solana airdrop 5 --url http://127.0.0.1:8899
anchor deploy
solana program show "$(solana address -k target/deploy/p2id_solana_verifier-keypair.json)" \
  --url http://127.0.0.1:8899
```

Save a Solana attestation response to `solana-test/data.json`. In Terminal 3, from the repository
root, copy the example environment file if needed, export the IDs derived from the two program
keypairs, and run the Anchor client:

```sh
cd solana-test
test -f .env || cp .env.example .env
export P2ID_ANCHOR_PROGRAM_ID="$(solana address -k ../solana-anchor/target/deploy/p2id_solana_verifier-keypair.json)"
export SUNSPOT_VERIFIER_PROGRAM_ID="$(solana address -k ../circuit/target/pvium_identity-keypair.json)"
yarn install
yarn verify:anchor
```

The client sends `proof || public_witness` through the Anchor wrapper and checks that the wrapper
returns `[1]`. `--reset` clears the validator's local ledger at startup; omit it to preserve an
existing ledger, but make sure the Sunspot verifier is already deployed there. The wrapper does
not deploy or configure the verifier program itself. The direct verifier path is available
separately as `yarn verify:direct`; it uses `VERIFIER_PROGRAM_ID` and bypasses the Anchor wrapper.
