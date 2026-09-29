// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVerifier} from "./interfaces/IP2IDVerifier.sol";
import {P2IDHash} from "./lib/P2IDHash.sol";
import {PviumIdentity} from "./PviumIdentity.sol";

/// @title PviumVerifier
/// @notice Resolves an EVM wallet from a PviumIdentity attestation and checks an optional
///         constraint signature against the registered constraint signers.
/// @dev proof = abi.encode(bytes zkProof, bytes32[] publicInputs). The wallet returned is the
///      EVM address the circuit read out of the Privy-signed token (public input 1), cross-checked
///      here against the proof's walletHash with the same formula. A constraint is satisfied by
///      a registered signer's EIP-712 signature over `Constraint(bytes32 commitment)` in this
///      contract's domain (name "PviumVerifier", version "1", chain id, this address).
///      The PviumIdentity address is immutable; its accepted key set can change separately.
///      Constraint signatures authorize a commitment, while the attestation supplies the wallet.
///      This contract does not interpret the commitment's contents or enforce signature single-use.
contract PviumVerifier is IP2IDVerifier {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant CONSTRAINT_TYPEHASH = keccak256("Constraint(bytes32 commitment)");

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

        if (constraint.commitment != bytes32(0)) {
            if (constraintSignerCount == 0) revert ConstraintsUnsupported();
            if (!isConstraintSigner[_recover(constraint.commitment, constraint.signature)]) revert InvalidConstraintSigner();
        }
        return (a.wallet, a.iat);
    }

    /// @inheritdoc IP2IDVerifier
    /// @dev Forward the identity key-set revision; constraint-signer changes do not increment it.
    function revision() external view returns (uint64) {
        return pviumIdentity.keySetRevision();
    }

    /// @inheritdoc IP2IDVerifier
    function supportsConstraints() external view returns (bool) {
        return constraintSignerCount != 0;
    }

    /// @notice The EIP-712 digest a constraint signer signs for a commitment.
    function constraintDigest(bytes32 commitment) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(CONSTRAINT_TYPEHASH, commitment))));
    }

    /// @notice Hash policyHash, identityHash and caller-supplied salt using abi.encode.
    ///         Does not generate a salt or enforce uniqueness.
    function screeningCommitment(bytes32 policyHash, bytes32 identityHash, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(policyHash, identityHash, salt));
    }

    function _recover(bytes32 commitment, bytes calldata signature) private view returns (address) {
        if (signature.length != 65) revert MalformedSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert MalformedSignature();
        address signer = ecrecover(constraintDigest(commitment), v, r, s);
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
