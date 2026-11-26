#!/usr/bin/env bash
# Groth16 trusted setup for the production Solana verifier: a phase-2 MPC ceremony over the P2ID
# constraint system, with Reilabs' trusted-setup tool (gnark 0.14 mpcsetup, the same gnark Sunspot
# uses). Groth16 needs a circuit-specific setup; its proving key is sound as long as ONE contributor
# destroyed their randomness. `sunspot setup` is one party on one machine and is never used for
# production.
#
# Phase 1 (powers of tau, circuit-independent) is not run here: it is imported from the Perpetual
# Powers of Tau (snarkjs .ptau files prepared from the PPoT ceremony's round 80, hosted by PSE;
# hundreds of public contributors). Phase 2 (circuit-specific) is what this ceremony runs.
#
# Coordinator:
#   sunspot-ceremony.sh phase1 [--power N]    download + convert the ptau file (power from the CCS)
#   sunspot-ceremony.sh init                  start phase 2 for the CCS; records the drand beacon
#   sunspot-ceremony.sh verify PREV NEXT      check one contribution against the file it was made from
#   sunspot-ceremony.sh finish C1 C2 [...]    verify the whole chain, extract production/pvium_identity.{pk,vk}
# Each contributor, on their own machine (only the tool and the file they are sent):
#   sunspot-ceremony.sh contribute FILE       writes FILE.<timestamp>; send it back, publish its hash
#
# The coordinator sends contributor k the file contributor k-1 returned, verifies each one as it
# comes back, and keeps every file: `finish` needs the whole chain. Publish target/.../ceremony/
# transcript.json (hashes of the CCS, phase 1, beacon, every contribution and the keys) so anyone
# can rerun `verify` and `finish` and get the same keys. Then: sunspot-build.sh production.
#
# Needs `source .tools/env.sh` and, for the coordinator, a prior `sunspot-build.sh sandbox` (for the
# CCS) and network access (`init` fetches a drand beacon).
set -euo pipefail

usage() { sed -n '2,27p' "$0"; exit 2; }
CIRCUIT=$(cd "$(dirname "$0")/.." && pwd)
NAME=pvium_identity
OUT=$CIRCUIT/target/sunspot
PROD=$OUT/production
CEREMONY=$PROD/ceremony
PTAU_DIR=${P2ID_TOOLS_DIR:-$CIRCUIT/../.tools}/ptau
TS=${TRUSTED_SETUP_BIN:-trusted-setup}
command -v "$TS" >/dev/null || { echo "trusted-setup not on PATH: source .tools/env.sh" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
transcript() { # transcript KEY JSON-VALUE: set one key of ceremony/transcript.json
  mkdir -p "$CEREMONY"
  python3 - "$CEREMONY/transcript.json" "$1" "$2" <<'EOF'
import json, os, sys
path, key, value = sys.argv[1:]
doc = json.load(open(path)) if os.path.exists(path) else {}
doc[key] = json.loads(value)
json.dump(doc, open(path, "w"), indent=2)
EOF
}

cmd=${1:-}
[ -n "$cmd" ] || usage
shift
case "$cmd" in
  phase1)
    power=""
    while [ $# -gt 0 ]; do case "$1" in --power) power=$2; shift 2 ;; *) usage ;; esac; done
    [ -f "$OUT/$NAME.ccs" ] || { echo "missing $OUT/$NAME.ccs: run sunspot-build.sh sandbox first" >&2; exit 1; }
    if [ -z "$power" ]; then
      : "${CCSINFO_BIN:?source .tools/env.sh first}"
      info=$("$CCSINFO_BIN" "$OUT/$NAME.ccs")
      echo "$info"
      power=$(echo "$info" | sed -n 's/.*power=\([0-9]*\).*/\1/p')
    fi
    [ "$power" -ge 8 ] && [ "$power" -le 28 ] || { echo "power $power out of the published range 8..28" >&2; exit 1; }
    nn=$(printf '%02d' "$power")
    file=ppot_0080_$nn.ptau
    ptau=$PTAU_DIR/$file
    mkdir -p "$PTAU_DIR" "$CEREMONY"
    if [ ! -f "$ptau" ]; then
      # PSE's mirror of the prepared Perpetual Powers of Tau files (round 80). The older Hermez
      # mirrors (powersOfTau28_hez_final_NN.ptau) no longer serve; PTAU_URL overrides.
      url=${PTAU_URL:-https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/$file}
      echo "downloading $url"
      curl -fL --retry 5 -C - -o "$ptau.part" "$url" && mv "$ptau.part" "$ptau"
    fi
    echo "ptau: $ptau"
    if command -v b2sum >/dev/null; then
      echo "  blake2b: $(b2sum "$ptau" | cut -d' ' -f1)"
    fi
    echo "  sha256:  $(sha "$ptau")"
    echo "  compare with the hash the Perpetual Powers of Tau repository publishes for this file"
    "$TS" ptau --ptau "$ptau" --phase1 "$CEREMONY/phase1.ph1"
    transcript circuit "{\"ccs\": \"$OUT/$NAME.ccs\", \"ccsSha256\": \"$(sha "$OUT/$NAME.ccs")\", \"acirSha256\": \"$(sha "$OUT/$NAME.json")\"}"
    transcript phase1 "{\"source\": \"Perpetual Powers of Tau round 80, $file\", \"url\": \"$url\", \"power\": $power, \"ptauSha256\": \"$(sha "$ptau")\", \"phase1Sha256\": \"$(sha "$CEREMONY/phase1.ph1")\"}"
    echo "phase 1 ready: $CEREMONY/phase1.ph1"
    ;;
  init)
    [ $# -eq 0 ] || usage
    [ -f "$CEREMONY/phase1.ph1" ] || { echo "run 'phase1' first" >&2; exit 1; }
    log=$("$TS" init --phase1 "$CEREMONY/phase1.ph1" --r1cs "$OUT/$NAME.ccs" \
      --phase2 "$CEREMONY/phase2.ph2" --srscommons "$CEREMONY/srs.commons" 2>&1 | tee /dev/stderr)
    beacon=$(echo "$log" | sed -n 's/.*Beacon (pass it to extract-keys): *\([0-9a-f]*\).*/\1/p' | head -1)
    [ -n "$beacon" ] || { echo "could not read the beacon from the tool's output" >&2; exit 1; }
    echo "$beacon" > "$CEREMONY/beacon.txt"
    transcript init "{\"phase2Sha256\": \"$(sha "$CEREMONY/phase2.ph2")\", \"srsCommonsSha256\": \"$(sha "$CEREMONY/srs.commons")\", \"beacon\": \"$beacon\", \"beaconSource\": \"drand (latest round at init; the tool's chain), see utils/randomness in reilabs/trusted-setup\", \"startedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    transcript contributions "[]"
    echo "phase 2 initialized: send $CEREMONY/phase2.ph2 to the first contributor"
    ;;
  contribute)
    [ $# -eq 1 ] || usage
    "$TS" contribute --phase2 "$1"
    latest=$(ls -t "$1".* 2>/dev/null | head -1)
    echo "contribution: $latest"
    echo "sha256: $(sha "$latest")"
    echo "Send the file back to the coordinator and publish the hash. Destroy nothing else: the tool"
    echo "keeps no secret after it exits; make sure this machine's memory is not swapped to a disk you keep."
    ;;
  verify)
    [ $# -eq 2 ] || usage
    "$TS" verify --phase2prev "$1" --phase2next "$2"
    echo "ok: $2 ($(sha "$2")) follows $1"
    ;;
  finish)
    [ $# -ge 2 ] || { echo "finish needs at least two contribution files, in order" >&2; usage; }
    [ -f "$CEREMONY/beacon.txt" ] || { echo "no beacon: 'init' was not run here" >&2; exit 1; }
    prev=$CEREMONY/phase2.ph2
    list=""
    contributions=""
    for c in "$@"; do
      "$TS" verify --phase2prev "$prev" --phase2next "$c"
      echo "verified $(basename "$c")"
      list="${list:+$list,}$c"
      contributions="${contributions:+$contributions, }{\"file\": \"$(basename "$c")\", \"sha256\": \"$(sha "$c")\"}"
      prev=$c
    done
    contributions="[$contributions]"
    mkdir -p "$PROD"
    "$TS" extract-keys --r1cs "$OUT/$NAME.ccs" --srscommons "$CEREMONY/srs.commons" \
      --beacon "$(cat "$CEREMONY/beacon.txt")" --phase2 "$list" --pk "$CEREMONY/$NAME.ceremony.pk" --vk "$CEREMONY/$NAME.ceremony.vk"
    # The tool writes keys with compressed points; Sunspot's verifier generator reads the raw form
    # its own setup writes. Re-encode (same key material, checked by `sunspot verify` either way).
    : "${KEYRAW_BIN:?source .tools/env.sh first}"
    "$KEYRAW_BIN" "$CEREMONY/$NAME.ceremony.vk" "$PROD/$NAME.vk"
    "$KEYRAW_BIN" "$CEREMONY/$NAME.ceremony.pk" "$PROD/$NAME.pk"
    transcript contributions "$contributions"
    transcript keys "{\"ceremonyVkSha256\": \"$(sha "$CEREMONY/$NAME.ceremony.vk")\", \"pkSha256\": \"$(sha "$PROD/$NAME.pk")\", \"vkSha256\": \"0x$(sha "$PROD/$NAME.vk")\", \"encoding\": \"raw (keyraw), vkSha256 is the factory vkHash\", \"finishedAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    echo
    echo "production keys: $PROD/$NAME.pk, $PROD/$NAME.vk (vkHash 0x$(sha "$PROD/$NAME.vk"))"
    echo "transcript: $CEREMONY/transcript.json (publish it with the contribution files)"
    echo "Next: sunspot-build.sh production"
    ;;
  *) usage ;;
esac
