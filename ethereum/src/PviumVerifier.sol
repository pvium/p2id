// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVerifier} from "./interfaces/IP2IDVerifier.sol";
import {P2IDHash} from "./lib/P2IDHash.sol";
import {PviumIdentity} from "./PviumIdentity.sol";

/// @title PviumVerifier
/// @notice Resolves an EVM wallet from a PviumIdentity attestation and checks an optional
///         constraint signature, from a registered signer or from the signer the payer chose.
/// @dev proof = abi.encode(bytes zkProof, bytes32[] publicInputs). The wallet returned is the
///      EVM address the circuit read out of the Privy-signed token (public input 1), cross-checked
///      here against the proof's walletHash with the same formula.
///      A constraint commitment names who may approve it:
///        commitment = keccak256(abi.encode("p2id.constraint.v1", signer, policyHash, identityHash, salt))
///      with the payee's identityHash. signer == address(0): any registered constraint signer (the
///      owner-managed set); any other signer: exactly that address, which needs no registration (a
///      contract signer is checked with ERC-1271). At claim time constraint.signature is
///      abi.encode(address signer, bytes32 policyHash, bytes32 salt, bytes signature). For
///      signer == address(0), `signature` is either a 65-byte ECDSA signature by a registered
///      signer or abi.encode(address approver, bytes approval) naming the registered signer, which
///      may be a contract (ERC-1271). The verifier
///      recomputes the commitment with the vault's own identityHash, so the revealed signer is the
///      one the payer committed to, and checks `signature`, an EIP-712 signature over
///      `Constraint(bytes32 commitment)` in this contract's domain (name "PviumVerifier", version "1",
///      chain id, this address).
///      The PviumIdentity address is immutable; its accepted key set can change separately.
///      Constraint signatures authorize a commitment, while the attestation supplies the wallet.
///      This contract does not interpret policyHash or enforce signature single-use.
contract PviumVerifier is IP2IDVerifier {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CONSTRAINT_TYPEHASH = keccak256("Constraint(bytes32 commitment)");
    /// @notice Domain tag of a constraint commitment (see constraintCommitment).
    string public constant CONSTRAINT_DOMAIN = "p2id.constraint.v1";
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    PviumIdentity public immutable pviumIdentity;
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;
    /// @notice Addresses whose signatures satisfy a constraint commitment.
    mapping(address => bool) public isConstraintSigner;
    /// @notice Number of registered signers; constraints are supported while it is non-zero.
    uint256 public constraintSignerCount;
    address public owner;
    address public pendingOwner;

    event ConstraintSignerSet(address indexed signer, bool allowed);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error IdentityMismatch();
    error NoEvmWallet();
    error WalletHashMismatch();
    error ConstraintsUnsupported();
    error InvalidConstraintSigner();
    error ConstraintMismatch();
    error MalformedSignature();
    error NotOwner();
    error NotPendingOwner();
    error InvalidSigner();

    /// @param _owner Constraint-signer administrator; address(0) disables owner-only calls.
    /// @param _signers Initial constraint signers (may be empty: constraints unsupported until one is added).
    constructor(PviumIdentity _pviumIdentity, address _owner, address[] memory _signers) {
        pviumIdentity = _pviumIdentity;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
        for (uint256 i = 0; i < _signers.length; i++) _setSigner(_signers[i], true);
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _domainSeparator(block.chainid);
    }

    /// @notice Set a constraint signer's membership. Signatures are checked against current membership.
    function setConstraintSigner(address signer, bool allowed) external onlyOwner {
        _setSigner(signer, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice EIP-712 domain separator; recomputed when block.chainid differs from its deployment value.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _domainSeparator(block.chainid);
    }

    function _domainSeparator(uint256 chainId) private view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("PviumVerifier"), keccak256("1"), chainId, address(this)));
    }

    /// @inheritdoc IP2IDVerifier
    function getIdentityWallet(
        bytes32 identityHash,
        bytes calldata proof,
        Constraint calldata constraint
    ) external view returns (address wallet, uint64 iat) {
        (bytes memory zkProof, bytes32[] memory publicInputs) = abi.decode(proof, (bytes, bytes32[]));

        // Verify against PviumIdentity's current accepted signer set.
        PviumIdentity.Attestation memory a = pviumIdentity.verifyAttestation(zkProof, publicInputs);
        if (a.identityHash != identityHash) revert IdentityMismatch();
        if (a.wallet == address(0)) revert NoEvmWallet();
        if (P2IDHash.walletHash(a.wallet) != a.walletHash) revert WalletHashMismatch();

        if (constraint.commitment != bytes32(0)) _checkConstraint(identityHash, constraint);
        return (a.wallet, a.iat);
    }

    /// @dev Reveal the commitment's preimage, recompute it for this payee, then check the
    ///      signature against the signer the commitment names (or the registered set for address(0)).
    function _checkConstraint(bytes32 identityHash, Constraint calldata constraint) private view {
        // abi.encode(address, bytes32, bytes32, bytes) is at least five words (an empty bytes included).
        if (constraint.signature.length < 160) revert MalformedSignature();
        (address signer, bytes32 policyHash, bytes32 salt, bytes memory signature) =
            abi.decode(constraint.signature, (address, bytes32, bytes32, bytes));
        if (constraintCommitment(signer, policyHash, identityHash, salt) != constraint.commitment) revert ConstraintMismatch();
        bytes32 digest = constraintDigest(constraint.commitment);
        if (signer == address(0)) {
            if (constraintSignerCount == 0) revert ConstraintsUnsupported();
            if (signature.length == 65) {
                // An EOA signer: recover it.
                if (!isConstraintSigner[_recover(digest, signature)]) revert InvalidConstraintSigner();
            } else {
                // Any registered signer, contracts included: abi.encode(address approver, bytes approval).
                if (signature.length < 128) revert MalformedSignature();
                (address approver, bytes memory approval) = abi.decode(signature, (address, bytes));
                if (!isConstraintSigner[approver] || !_isValidSignature(approver, digest, approval)) revert InvalidConstraintSigner();
            }
        } else if (!_isValidSignature(signer, digest, signature)) {
            revert InvalidConstraintSigner();
        }
    }

    function vkHash() external view returns (bytes32) { return pviumIdentity.vkHash(); }

    /// @inheritdoc IP2IDVerifier
    /// @dev Forward the identity key-set revision; constraint-signer changes do not increment it.
    function revision() external view returns (uint64) {
        return pviumIdentity.keySetRevision();
    }

    /// @inheritdoc IP2IDVerifier
    /// @dev Always true: a payer can always commit to a signer of their choice. A commitment for the
    ///      registered signers (signer address(0)) is unclaimable, and refundable, while none is registered.
    function supportsConstraints() external pure returns (bool) {
        return true;
    }

    /// @notice The EIP-712 digest a constraint signer signs for a commitment.
    function constraintDigest(bytes32 commitment) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(CONSTRAINT_TYPEHASH, commitment))));
    }

    /// @notice The constraint commitment a payer funds with. `signer` is who may approve it:
    ///         address(0) for any registered constraint signer, otherwise exactly that address.
    ///         identityHash is the payee's; the payer gives signer, policyHash and salt to the claimant.
    function constraintCommitment(address signer, bytes32 policyHash, bytes32 identityHash, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(CONSTRAINT_DOMAIN, signer, policyHash, identityHash, salt));
    }

    /// @dev `signature` is a valid ECDSA signature of `digest` by `signer` (low-s, 65 bytes), or
    ///      `signer` is a contract that accepts it under ERC-1271. ECDSA is tried first, so an
    ///      account with delegated code (EIP-7702) can still sign with its key.
    function _isValidSignature(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (signer == address(0)) return false;
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            if (v < 27) v += 27;
            if (uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0 && ecrecover(digest, v, r, s) == signer) {
                return true;
            }
        }
        if (signer.code.length == 0) return false;
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, signature));
        return ok && ret.length == 32 && abi.decode(ret, (bytes32)) == bytes32(ERC1271_MAGIC);
    }

    /// @dev ECDSA signer of `digest`; reverts on a malformed or high-s signature.
    function _recover(bytes32 digest, bytes memory signature) private pure returns (address) {
        if (signature.length != 65) revert MalformedSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert MalformedSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert MalformedSignature();
        return signer;
    }

    function _setSigner(address signer, bool allowed) private {
        if (signer == address(0)) revert InvalidSigner();
        if (isConstraintSigner[signer] == allowed) return;
        isConstraintSigner[signer] = allowed;
        allowed ? constraintSignerCount++ : constraintSignerCount--;
        emit ConstraintSignerSet(signer, allowed);
    }

    modifier onlyOwner() {
        if (msg.sender != owner || owner == address(0)) revert NotOwner();
        _;
    }
}
