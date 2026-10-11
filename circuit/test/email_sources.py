"""Email sources: an `email` identity is proven from any linked account that carries the address
(a Privy email account, or a Google, LinkedIn or Apple login) and always hashes as `email`.
Dummy payloads built from the sample token's claims, one account source at a time, signed with
the throwaway test key. Positive cases must solve to the same identity hash; forged sources must
fail.

Run via test/email_sources.sh (needs nargo and node on PATH)."""
import hashlib, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures")
NODE = os.environ.get("NODE", "node")

EMAIL = "Dummy.User@Example.com"  # mixed case: every source must lowercase it the same way
WALLET = "0x1111111111111111111111111111111111111111"
PREFIX = b"p2id.identity.v1"

# Account objects shaped like Privy's linked_accounts entries for each source.
ACCOUNTS = {
    "email": {"type": "email", "address": EMAIL, "verified_at": 1789000000},
    "google_oauth": {"type": "google_oauth", "subject": "104000000000000000001", "email": EMAIL,
                     "name": "Dummy User", "verified_at": 1789000000},
    "linkedin_oauth": {"type": "linkedin_oauth", "subject": "abcDEF123", "email": EMAIL,
                       "name": "Dummy User", "vanity_name": "dummy-user", "verified_at": 1789000000},
    "apple_oauth": {"type": "apple_oauth", "subject": "000001.abcdef.0001", "email": EMAIL,
                    "verified_at": 1789000000},
    "github_oauth": {"type": "github_oauth", "subject": "42", "username": "dummyuser",
                     "email": EMAIL, "verified_at": 1789000000},
}
WALLET_ACCOUNT = {"type": "wallet", "address": WALLET, "chain_type": "ethereum", "verified_at": 1789000000}
SOURCE_ID = {"email": 0, "google_oauth": 2, "linkedin_oauth": 6, "apple_oauth": 7, "github_oauth": 5}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def identity_hash(type_id: int, value: str) -> int:
    return int.from_bytes(hashlib.sha256(PREFIX + bytes([type_id]) + value.lower().encode()).digest(), "big")


def token_with(accounts) -> str:
    with open(os.path.join(FIX, "sample_payload.json")) as f:
        payload = json.load(f)
    payload["linked_accounts"] = json.dumps(accounts, separators=(",", ":"))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
        json.dump(payload, tf)
    r = run([NODE, os.path.join(HERE, "sign_token.mjs"), tf.name, os.path.join(FIX, "test_es256_private.pem")])
    os.remove(tf.name)
    if r.returncode != 0:
        print(r.stderr); sys.exit(1)
    return r.stdout.strip()


def witness(token: str, type_name: str, value: str) -> str:
    out = os.path.join(ROOT, "ProverEmailSrc.toml")
    r = run([sys.executable, os.path.join(ROOT, "scripts/gen_prover.py"), "--jwt", token,
             "--pubkey", os.path.join(FIX, "test_es256_public.pem"), "--type", type_name,
             "--value", value, "--wallet", WALLET, "-o", out])
    if r.returncode != 0:
        print(f"  FAIL witness for {type_name}: {r.stdout}{r.stderr}"); sys.exit(1)
    with open(out) as f:
        toml = f.read()
    os.remove(out)
    return toml


def set_field(toml: str, key: str, value) -> str:
    return re.sub(rf'^{key} = .*$', f'{key} = "{value}"', toml, flags=re.M)


def field(toml: str, key: str) -> str:
    return re.search(rf'^{key} = "([^"]*)"', toml, re.M).group(1)


def execute(toml: str, name: str) -> str:
    path = os.path.join(ROOT, f"Prover{name}.toml")
    with open(path, "w") as f:
        f.write(toml)
    r = run(["nargo", "execute", "-p", f"Prover{name}", f"src_{name}"], cwd=ROOT)
    os.remove(path)
    return r.stdout + r.stderr


def solved_identity_hash(output: str) -> int:
    if "successfully solved" not in output:
        return -1
    hi = int(re.search(r"identity_hash_hi: (0x[0-9a-f]+)", output).group(1), 16)
    lo = int(re.search(r"identity_hash_lo: (0x[0-9a-f]+)", output).group(1), 16)
    return (hi << 128) | lo


def fail(msg, output=""):
    print(f"  FAIL {msg}")
    if output:
        print(output[-800:])
    sys.exit(1)


def main():
    expected = identity_hash(0, EMAIL)

    # 1. Each email-bearing source alone proves `email` (type 0) with the same identity hash.
    print(f"email sources: every source proves email {EMAIL} as identity hash {expected:#066x}")
    for source in ("email", "google_oauth", "linkedin_oauth", "apple_oauth"):
        toml = witness(token_with([WALLET_ACCOUNT, ACCOUNTS[source]]), "email", EMAIL)
        if field(toml, "identity_type") != "0" or field(toml, "source_type") != str(SOURCE_ID[source]):
            fail(f"{source}: witness has identity_type {field(toml, 'identity_type')} source {field(toml, 'source_type')}")
        out = execute(toml, source)
        if solved_identity_hash(out) != expected:
            fail(f"{source}: did not solve to the email identity hash", out)
        print(f"  ok   {source:<15} -> email identity hash")

    # 2. With all four present the generator takes the Privy email account first; same hash.
    all_four = [WALLET_ACCOUNT] + [ACCOUNTS[s] for s in ("apple_oauth", "linkedin_oauth", "google_oauth", "email")]
    toml = witness(token_with(all_four), "email", EMAIL)
    if field(toml, "source_type") != "0":
        fail(f"all four: expected the email account to be chosen, got source {field(toml, 'source_type')}")
    if solved_identity_hash(execute(toml, "all")) != expected:
        fail("all four: did not solve to the email identity hash")
    print("  ok   all four present -> email account chosen, same hash")

    # 3. The provider types still prove themselves, under their own (different) type ids.
    for source in ("google_oauth", "linkedin_oauth", "apple_oauth"):
        toml = witness(token_with([WALLET_ACCOUNT, ACCOUNTS[source]]), source, EMAIL)
        own = identity_hash(SOURCE_ID[source], EMAIL)
        if solved_identity_hash(execute(toml, f"own_{source}")) != own or own == expected:
            fail(f"{source} as its own type: wrong identity hash")
        print(f"  ok   {source:<15} as its own type -> its own hash (not the email hash)")

    # 4. Forged sources must fail.
    github_token = token_with([WALLET_ACCOUNT, ACCOUNTS["github_oauth"]])
    honest = witness(github_token, "github_oauth", "dummyuser")
    # a. A GitHub account cannot prove an email, even one whose object carries an email field.
    attack = set_field(honest, "identity_type", 0)
    out = execute(attack, "forge_a")
    if "successfully solved" in out or "account source cannot prove this identity type" not in out:
        fail("forge a: github account accepted as an email source", out)
    print("  ok   github account claimed as an email source (rejected)")

    google_toml = witness(token_with([WALLET_ACCOUNT, ACCOUNTS["google_oauth"]]), "email", EMAIL)
    # b. An email-bearing source proves email, never another provider's type.
    out = execute(set_field(google_toml, "identity_type", 6), "forge_b")
    if "successfully solved" in out or "account source cannot prove this identity type" not in out:
        fail("forge b: google account accepted as a linkedin identity", out)
    print("  ok   google account claimed as a linkedin identity (rejected)")
    # c. The declared source must match the object's type string.
    out = execute(set_field(google_toml, "source_type", 0), "forge_c")
    if "successfully solved" in out or "account type mismatch" not in out:
        fail("forge c: google account object declared as an email account", out)
    print("  ok   google account object declared as a Privy email account (rejected)")
    print("all email-source cases passed")


if __name__ == "__main__":
    main()
