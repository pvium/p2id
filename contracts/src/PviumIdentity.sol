// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IVerifier} from "./PviumZKVerifier.sol";
import {IPviumIdentity} from "./interfaces/IPviumIdentity.sol";

/// @title PviumIdentity
/// @notice Verifies attestations using an immutable proof verifier and circuit version.
///         The constructor supplies the initial P-256 signer keys. The owner can propose additions
///         with a 7-day activation delay or remove accepted keys immediately.
/// @dev Proposal URLs and key ids are metadata; this contract does not validate them against JWKS.
/// @dev Public input layout emitted by circuit/src/main.nr:
///        [0] identity_type   [1] wallet (EVM address checked in-circuit against the token; 0 if none)
///        [2] signer_x_hi     [3] signer_x_lo     [4] signer_y_hi   [5] signer_y_lo
///        [6] iat             [7] identity_hash_hi  [8] identity_hash_lo
///        [9] wallet_hash_hi  [10] wallet_hash_lo  (zero when the proof carries no wallet)
///      Hashes and coordinates are split into two 128-bit halves because a 256-bit value does
///      not fit in one BN254 field element.
contract PviumIdentity is IPviumIdentity {
    uint256 public constant PUBLIC_INPUT_COUNT = 11;

    IVerifier public immutable verifier;
    /// @notice Circuit version identifier supplied at deployment; not checked against the verifier's bytecode.
    uint16 public immutable circuitVersion;
    /// @notice Notice a key proposal gives before it can be activated.
    uint64 public constant SIGNER_KEY_DELAY = 7 days;
    /// @notice Number of accepted signer keys. When zero, the signer check rejects attestations.
    uint256 public signerKeyCount;
    /// @notice Incremented by removeSignerKey; exposed to consumers for cache invalidation.
    uint64 public keySetRevision;
    /// @dev Accepted signer keys, keyed by signerKeyHash(x, y).
    mapping(bytes32 keyHash => bool) private _signerKeys;
    /// @notice Owner authorized to propose/remove keys and transfer ownership; zero disables owner-only calls.
    address public owner;
    address public pendingOwner;

    struct SignerKeyProposal {
        uint256 x;
        uint256 y;
        /// Earliest activation time; zero when there is no proposal for this key.
        uint64 eta;
        /// Caller-supplied JWKS URL and key id; stored without publication checks.
        string url;
        string kid;
    }
    /// @notice Pending key proposals, keyed by signerKeyHash(x, y).
    mapping(bytes32 keyHash => SignerKeyProposal) public signerKeyProposals;

    event SignerKeyProposed(uint256 indexed x, uint256 indexed y, uint64 eta, string url, string kid);
    event SignerKeyProposalCancelled(uint256 indexed x, uint256 indexed y);
    event SignerKeyAdded(uint256 indexed x, uint256 indexed y);
    event SignerKeyRemoved(uint256 indexed x, uint256 indexed y);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    /// @notice Decoded public inputs returned by verifyAttestation after verification.
    struct Attestation {
        uint8 identityType;
        /// EVM wallet public input. The circuit checks the selected wallet against the signed token;
        /// zero represents an absent or non-EVM wallet.
        address wallet;
        /// When Privy issued the token (unix seconds). Freshness policy is the caller's.
        uint64 iat;
        bytes32 identityHash;
        /// P2IDHash.walletHash of a wallet linked in the same token, or 0.
        bytes32 walletHash;
    }

    error InvalidVerifier();
    error InvalidProof();
    error UnknownSigner(bytes32 x, bytes32 y);
    error WrongPublicInputCount(uint256 got);
    error InvalidPublicKey();
    error NoSignerKeys();
    error DuplicateSignerKey(uint256 x, uint256 y);
    error InvalidCircuitVersion();
    error IdentityTypeMismatch(uint8 expected, uint8 got);
    error IdentityMismatch();
    error NoWallet();
    error WalletMismatch();
    error NotOwner();
    error NotPendingOwner();
    error KeyAlreadyAccepted(uint256 x, uint256 y);
    error NothingProposed(uint256 x, uint256 y);
    error TimelockNotElapsed(uint64 eta);
    error UnknownKey(uint256 x, uint256 y);

    /// @param _owner Key-set administrator; address(0) disables owner-only calls.
    /// @param _signerXs X coordinates of the initial accepted P-256 keys.
    /// @param _signerYs Corresponding Y coordinates.
    constructor(
        IVerifier _verifier,
        uint16 _circuitVersion,
        address _owner,
        uint256[] memory _signerXs,
        uint256[] memory _signerYs
    ) {
        if (address(_verifier).code.length == 0) revert InvalidVerifier();
        if (_circuitVersion == 0) revert InvalidCircuitVersion();
        if (_signerXs.length == 0 || _signerXs.length != _signerYs.length) revert NoSignerKeys();
        for (uint256 i = 0; i < _signerXs.length; i++) {
            (uint256 x, uint256 y) = (_signerXs[i], _signerYs[i]);
            if (!_isOnCurve(x, y)) revert InvalidPublicKey();
            bytes32 h = signerKeyHash(x, y);
            if (_signerKeys[h]) revert DuplicateSignerKey(x, y);
            _signerKeys[h] = true;
        }
        verifier = _verifier;
        circuitVersion = _circuitVersion;
        signerKeyCount = _signerXs.length;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ---- signer key management ------------------------------------------------------------

    /// @notice Propose a key with caller-supplied `url` and `kid`, eligible after SIGNER_KEY_DELAY.
    ///         Re-proposing a key restarts its delay.
    function proposeSignerKey(uint256 x, uint256 y, string calldata url, string calldata kid) external onlyOwner {
        if (!_isOnCurve(x, y)) revert InvalidPublicKey();
        bytes32 h = signerKeyHash(x, y);
        if (_signerKeys[h]) revert KeyAlreadyAccepted(x, y);
        uint64 eta = uint64(block.timestamp) + SIGNER_KEY_DELAY;
        signerKeyProposals[h] = SignerKeyProposal({x: x, y: y, eta: eta, url: url, kid: kid});
        emit SignerKeyProposed(x, y, eta, url, kid);
    }

    function cancelSignerKeyProposal(uint256 x, uint256 y) external onlyOwner {
        bytes32 h = signerKeyHash(x, y);
        if (signerKeyProposals[h].eta == 0) revert NothingProposed(x, y);
        delete signerKeyProposals[h];
        emit SignerKeyProposalCancelled(x, y);
    }

    /// @notice Accept an uncancelled proposal once its delay has passed. Callable by any address.
    function activateSignerKey(uint256 x, uint256 y) external {
        bytes32 h = signerKeyHash(x, y);
        uint64 eta = signerKeyProposals[h].eta;
        if (eta == 0) revert NothingProposed(x, y);
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        delete signerKeyProposals[h];
        if (_signerKeys[h]) revert KeyAlreadyAccepted(x, y);
        _signerKeys[h] = true;
        signerKeyCount++;
        emit SignerKeyAdded(x, y);
    }

    /// @notice Remove an accepted key and increment keySetRevision. The last key may be removed.
    ///         Attestations naming this key fail the signer check until it is added again.
    function removeSignerKey(uint256 x, uint256 y) external onlyOwner {
        bytes32 h = signerKeyHash(x, y);
        if (!_signerKeys[h]) revert UnknownKey(x, y);
        _signerKeys[h] = false;
        signerKeyCount--;
        keySetRevision++;
        emit SignerKeyRemoved(x, y);
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

    modifier onlyOwner() {
        if (msg.sender != owner || owner == address(0)) revert NotOwner();
        _;
    }

    /// @inheritdoc IPviumIdentity
    function isSignerKey(uint256 x, uint256 y) public view returns (bool) {
        return _signerKeys[signerKeyHash(x, y)];
    }

    function signerKeyHash(uint256 x, uint256 y) public pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }

    // ---- developer-facing ---------------------------------------------------------------

    /// @inheritdoc IPviumIdentity
    function verifyIdentity(
        bytes calldata proof,
        bytes32[] calldata publicInputs,
        uint8 identityType,
        bytes32 identityHash,
        bytes32 walletHash
    ) external view returns (uint64 issuedAt) {
        return _verifyIdentity(proof, publicInputs, identityType, identityHash, walletHash);
    }

    // ---- lower level ----------------------------------------------------------------------

    /// @notice Check the public-input count and accepted signer, require verifier.verify to return
    ///         true, and return the decoded attestation.
    function verifyAttestation(bytes calldata proof, bytes32[] calldata publicInputs)
        public
        view
        returns (Attestation memory a)
    {
        a = _decode(publicInputs);
        if (!verifier.verify(proof, publicInputs)) revert InvalidProof();
    }

    // ---- internals -----------------------------------------------------------------------

    function _verifyIdentity(
        bytes calldata proof,
        bytes32[] calldata publicInputs,
        uint8 identityType,
        bytes32 identityHash,
        bytes32 walletHash
    ) internal view returns (uint64) {
        Attestation memory a = _decode(publicInputs);
        if (a.identityType != identityType) revert IdentityTypeMismatch(identityType, a.identityType);
        if (a.identityHash != identityHash) revert IdentityMismatch();
        if (a.walletHash == bytes32(0)) revert NoWallet();
        if (a.walletHash != walletHash) revert WalletMismatch();
        if (!verifier.verify(proof, publicInputs)) revert InvalidProof();
        return a.iat;
    }

    /// @dev Check input count and signer membership before calling the proof verifier.
    function _decode(bytes32[] calldata publicInputs) internal view returns (Attestation memory a) {
        if (publicInputs.length != PUBLIC_INPUT_COUNT) revert WrongPublicInputCount(publicInputs.length);
        bytes32 x = _join(publicInputs[2], publicInputs[3]);
        bytes32 y = _join(publicInputs[4], publicInputs[5]);
        if (!isSignerKey(uint256(x), uint256(y))) revert UnknownSigner(x, y);
        a.identityType = uint8(uint256(publicInputs[0]));
        a.wallet = address(uint160(uint256(publicInputs[1])));
        a.iat = uint64(uint256(publicInputs[6]));
        a.identityHash = _join(publicInputs[7], publicInputs[8]);
        a.walletHash = _join(publicInputs[9], publicInputs[10]);
    }

    function _join(bytes32 hi, bytes32 lo) internal pure returns (bytes32) {
        return bytes32((uint256(hi) << 128) | uint256(lo));
    }

    /// @dev Check coordinate bounds and y^2 == x^3 - 3x + b (mod p) on NIST P-256.
    function _isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        uint256 p = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF;
        uint256 b = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B;
        if (x >= p || y >= p) return false;
        uint256 lhs = mulmod(y, y, p);
        uint256 rhs = addmod(addmod(mulmod(mulmod(x, x, p), x, p), p - mulmod(3, x, p), p), b, p);
        return lhs == rhs;
    }
}
