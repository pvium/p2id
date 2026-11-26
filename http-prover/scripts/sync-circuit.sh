#!/bin/sh
# Copy the compiled circuit artifacts from ../circuit into ./circuit.
#   Always:  version.json and, when built, the Solana artifact pvium_identity.sunspot.json (the same
#            source compiled with the Noir release Sunspot reads, circuit/scripts/sunspot-build.sh),
#            which noir_js executes for Solana witnesses and sunspotd compiles into the constraint
#            system at startup.
#   --evm:   also the Ethereum artifact pvium_identity.json (nargo + Barretenberg build) and the bb vk.
#            Off by default because the committed Ethereum artifact is the one the live verifier's vk
#            was generated from and recompiling the same source does not reproduce it (Nargo.toml
#            pulls libraries from git without a lock file); it changes only with a new circuit version.
# Every synced artifact is checked against version.json (circuitHash, sunspotCircuitHash, vkSha256)
# and the script fails on a mismatch, so the tree never holds a prover whose circuit and keys
# disagree. A deliberate new circuit version is recorded in ../circuit/version.json first, then synced.
# The full JSONs (with source maps) stay local and gitignored; what gets committed is each one
# stripped to the fields noir_js, bb and Sunspot need and gzipped (~5-6 MB each). The service
# inflates them on startup when the plain files are missing, which is how the Docker image gets
# its circuits. Proving and verifying keys are not synced: the Sunspot keys are per environment
# (sandbox / production) and gigabytes, see README "Solana".
set -e
cd "$(dirname "$0")/.."
evm=0
for arg in "$@"; do
  case "$arg" in
    --evm) evm=1 ;;
    *) echo "usage: $0 [--evm]" >&2; exit 2 ;;
  esac
done
mkdir -p circuit
cp ../circuit/version.json circuit/version.json
if [ "$evm" = 1 ]; then
  # Staged next to the committed files; moved into place only once they pass the checks below.
  cp ../circuit/target/pvium_identity.json circuit/pvium_identity.json.new
  cp ../circuit/target/proof_email/vk circuit/vk.new
else
  echo "Ethereum artifact and vk left as committed (pass --evm to sync them: that is a new circuit version)"
fi
if [ -f ../circuit/target/sunspot/pvium_identity.json ]; then
  cp ../circuit/target/sunspot/pvium_identity.json circuit/pvium_identity.sunspot.json
else
  echo "no Sunspot ACIR at ../circuit/target/sunspot/pvium_identity.json (circuit/scripts/sunspot-build.sh); Solana artifact not synced" >&2
fi
EVM_SYNCED="$evm" python3 - <<'PY'
import gzip, hashlib, json, os, re, sys
version = json.load(open('circuit/version.json'))
failed = []
def circuit_hash(path):
    # nargo's hash is a 64-bit decimal: read it off the text rather than through a float
    m = re.search(r'"hash"\s*:\s*"?(\d+)"?', open(path).read())
    return m.group(1) if m else None
def check(what, actual, expected):
    if actual != expected:
        failed.append(f"{what}: {actual}, but version.json pins {expected} for circuit version {version['circuitVersion']}")
def strip(src, dst, extra):
    d = json.load(open(src))
    slim = {k: d[k] for k in ('noir_version', 'hash', 'abi', 'bytecode')}
    slim.update(extra)
    raw = json.dumps(slim, separators=(',', ':')).encode()
    gz = gzip.compress(raw, 9)
    with open(dst, 'wb') as f:
        f.write(gz)
    print(f"{dst}: {len(raw) / 1048576:.1f} MB stripped -> {len(gz) / 1048576:.1f} MB gzipped ({d['noir_version']})")
if os.environ.get('EVM_SYNCED') == '1':
    check('Ethereum circuit hash', circuit_hash('circuit/pvium_identity.json.new'), version['circuitHash'])
    check('bb vk sha256', '0x' + hashlib.sha256(open('circuit/vk.new', 'rb').read()).hexdigest(), version['vkSha256'])
    if failed:
        os.remove('circuit/pvium_identity.json.new'); os.remove('circuit/vk.new')
    else:
        os.replace('circuit/pvium_identity.json.new', 'circuit/pvium_identity.json')
        os.replace('circuit/vk.new', 'circuit/vk')
        strip('circuit/pvium_identity.json', 'circuit/pvium_identity.json.gz', {})
else:
    committed = gzip.open('circuit/pvium_identity.json.gz').read().decode()
    check('committed Ethereum circuit hash', re.search(r'"hash"\s*:\s*"?(\d+)"?', committed).group(1), version['circuitHash'])
if os.path.exists('circuit/pvium_identity.sunspot.json'):
    check('Sunspot circuit hash', circuit_hash('circuit/pvium_identity.sunspot.json'), version['sunspotCircuitHash'])
    if not failed:
        # Sunspot's loader insists on debug_symbols and file_map being present; empty ones are fine.
        strip('circuit/pvium_identity.sunspot.json', 'circuit/pvium_identity.sunspot.json.gz', {'debug_symbols': '', 'file_map': {}})
if failed:
    print("sync refused, the artifacts do not match version.json:", file=sys.stderr)
    for f in failed:
        print("  " + f, file=sys.stderr)
    print("A rebuilt circuit is a new circuit version: bump circuitVersion in ../circuit/version.json, record the new hashes and keys there, then sync again.", file=sys.stderr)
    sys.exit(1)
PY
echo "synced circuit artifacts"
