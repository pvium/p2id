// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IdVaultFactory} from "./interfaces/IP2IdVaultFactory.sol";
import {IP2IDPolicy} from "./interfaces/IP2IDPolicy.sol";
import {P2IDVault} from "./P2IDVault.sol";
import {PviumP2IDVaultProxy} from "./PviumP2IDVaultProxy.sol";
import {IP2IDVerifier} from "./interfaces/IP2IDVerifier.sol";
import {IP2IDVault} from "./interfaces/IP2IDVault.sol";

/// @title PviumP2IdVaultFactory
/// @notice Deploys one PviumP2IDVaultProxy per identity with CREATE2 (salt = identityHash) and
///         supplies policy and default-verifier settings. The proxy takes no constructor arguments;
///         its address is the low 160 bits of keccak256(0xff || factory || identityHash || initCodeHash()).
/// @dev The policy and the default verifier change only through a timelock (propose, wait,
///      activate): the policy after `policyChangeDelay`, the default verifier after the fixed
///      DEFAULT_VERIFIER_DELAY. Implementation registration also has a timelock; revocation is
///      immediate and does not change existing proxies. Vault upgrades preserve their addresses.
///      Manual registration checks code presence; deterministic deployment also checks factory binding.
///      Neither path verifies storage compatibility or implementation behavior.
contract PviumP2IdVaultFactory is IP2IdVaultFactory {
    /// @notice Alpha proof-acceptance status by pinned verification-key SHA-256.
    /// @dev Inverted storage: a key is in alpha unless it has been released, so a verification key
    ///      nobody has configured (a new circuit) requires attestation from its first proof.
    mapping(bytes32 => bool) public alphaReleased;
    mapping(bytes32 => uint256) public alphaRevision;
    address public defaultAttester;
    uint256 public alphaEpoch;
    bytes32 public constant ALPHA_AUTHORIZATION_TYPEHASH =
        keccak256(
            "AlphaAuthorization(address vault,address caller,bytes32 callHash,uint256 nonce,uint256 deadline,uint256 epoch)"
        );
    event AlphaModeSet(bytes32 indexed vkHash, bool enabled, uint256 epoch);
    event DefaultAttesterSet(address attester, uint256 epoch);
    error InvalidAlphaAuthorization();
    error AlphaAuthorizationExpired();
    error InvalidVkHash();

    /// @notice Whether proofs under `vkHash` need an alpha attestation. True for every key until
    ///         the owner releases it with setAlpha(vkHash, false).
    function isAlpha(bytes32 vkHash) public view returns (bool) {
        return !alphaReleased[vkHash];
    }

    function setAlpha(bytes32 vkHash, bool enabled) external onlyOwner {
        if (vkHash == bytes32(0)) revert InvalidVkHash();
        if (enabled && alphaReleased[vkHash]) ++alphaRevision[vkHash]; // back into alpha: voids owners cached while released
        alphaReleased[vkHash] = !enabled;
        ++alphaEpoch;
        emit AlphaModeSet(vkHash, enabled, alphaEpoch);
    }

    /// @notice Replace the alpha attester immediately; invalidates outstanding alpha approvals.
    function setDefaultAttester(address attester) external onlyOwner {
        if (attester == address(0)) revert InvalidAlphaAuthorization();
        defaultAttester = attester;
        ++alphaEpoch;
        emit DefaultAttesterSet(attester, alphaEpoch);
    }

    function alphaAuthorizationDigest(
        address vault,
        address caller,
        bytes32 callHash,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("PviumAlpha"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domain,
                    keccak256(
                        abi.encode(
                            ALPHA_AUTHORIZATION_TYPEHASH,
                            vault,
                            caller,
                            callHash,
                            nonce,
                            deadline,
                            alphaEpoch
                        )
                    )
                )
            );
    }

    function verifyAlphaAuthorization(
        address vault,
        address caller,
        bytes32 callHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external view {
        if (block.timestamp > deadline) revert AlphaAuthorizationExpired();
        if (signature.length != 65) revert InvalidAlphaAuthorization();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (
            (v != 27 && v != 28) ||
            uint256(s) >
            0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
        ) revert InvalidAlphaAuthorization();
        address signer = ecrecover(
            alphaAuthorizationDigest(vault, caller, callHash, nonce, deadline),
            v,
            r,
            s
        );
        if (signer == address(0) || signer != defaultAttester)
            revert InvalidAlphaAuthorization();
    }
    bytes32 public immutable nsHash;
    /// @notice Starting implementation for new proxies, changed only by a delayed default proposal.
    address public baseImplementation;
    /// @notice Original implementation, kept registered as a fallback.
    address public immutable initialImplementation;
    bytes32 public constant IMPLEMENTATION_SALT =
        keccak256("pvium.vault.implementation.v1");
    bool public proposedImplementationMakeDefault;
    /// @notice Target allowlist checked by PviumP2IDVaultProxy.upgradeTo.
    mapping(address implementation => bool) public isRegisteredImplementation;
    address public proposedImplementation;
    /// @notice Earliest time the proposed implementation can be registered; 0 when nothing is proposed.
    uint64 public proposedImplementationEta;
    uint64 public immutable minRefundWindow;
    uint64 public immutable maxRefundWindow;

    /// @notice Administrative owner for settings and implementation registration; transferred in two steps.
    address public owner;
    address public pendingOwner;

    /// @notice Policy address returned to vaults; changed through proposePolicy/activatePolicy.
    address public policy;
    /// @notice Verifier used when a payer does not choose one. Changes only via the timelock below.
    address public defaultVerifier;

    /// @notice Notice before a proposed default verifier can be activated. Fixed in this bytecode.
    uint64 public constant DEFAULT_VERIFIER_DELAY = 14 days;
    /// @notice Notice before a proposed policy can be activated.
    uint64 public immutable policyChangeDelay;
    address public proposedDefaultVerifier;
    /// @notice Earliest time the proposed default can be activated; 0 when nothing is proposed.
    uint64 public proposedDefaultEta;
    address public proposedPolicy;
    /// @notice Earliest time the proposed policy can be activated; 0 when nothing is proposed.
    uint64 public proposedPolicyEta;

    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event DefaultVerifierProposed(address indexed verifier, uint64 eta);
    event DefaultVerifierProposalCancelled(address indexed verifier);
    event DefaultVerifierActivated(address indexed verifier);
    event PolicyProposed(address indexed policy, uint64 eta);
    event PolicyProposalCancelled(address indexed policy);
    event PolicyActivated(address indexed policy);

    error NotOwner();
    error NotPendingOwner();
    error InvalidOwner();
    error InvalidPolicy();
    error VerifierNotApproved(address verifier);
    error NothingProposed();
    error TimelockNotElapsed(uint64 eta);
    error InvalidRefundWindow();
    error TokenCallFailed();
    error TokenBalanceQueryFailed();
    error NothingReceived();
    error UnexpectedValue();
    error InvalidImplementation();
    error ImplementationProposalPending();

    constructor(
        address _owner,
        bytes32 _nsHash,
        address _policy,
        address _defaultVerifier,
        uint64 _policyChangeDelay,
        uint64 _minRefundWindow,
        uint64 _maxRefundWindow,
        address _alphaAttester
    ) {
        if (_owner == address(0)) revert InvalidOwner();
        if (_minRefundWindow > _maxRefundWindow) revert InvalidRefundWindow();
        if (_policy.code.length == 0) revert InvalidPolicy();
        if (!IP2IDPolicy(_policy).isVerifierAllowed(_defaultVerifier))
            revert VerifierNotApproved(_defaultVerifier);
        owner = _owner;
        defaultAttester = _alphaAttester == address(0)
            ? _owner
            : _alphaAttester;
        emit DefaultAttesterSet(defaultAttester, alphaEpoch);
        emit OwnershipTransferred(address(0), _owner);
        nsHash = _nsHash;
        policyChangeDelay = _policyChangeDelay;
        minRefundWindow = _minRefundWindow;
        maxRefundWindow = _maxRefundWindow;
        policy = _policy;
        emit PolicyActivated(_policy);
        defaultVerifier = _defaultVerifier;
        emit DefaultVerifierActivated(_defaultVerifier);
        address base = address(new P2IDVault(address(this)));
        baseImplementation = base;
        initialImplementation = base;
        isRegisteredImplementation[base] = true;
        bytes32 initialVkHash = IP2IDVerifier(_defaultVerifier).vkHash();
        if (initialVkHash == bytes32(0)) revert InvalidVkHash();
        alphaRevision[initialVkHash] = 1; // in alpha by default, like every key
        emit ImplementationRegistered(base);
    }

    // ------------------------------------------------------------------ vault implementations (timelocked)

    /// @notice Predict the CREATE2 address from full creation code, including constructor arguments.
    function implementationFor(
        bytes32 creationCodeHash
    ) public view returns (address) {
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(this),
                                IMPLEMENTATION_SALT,
                                creationCodeHash
                            )
                        )
                    )
                )
            );
    }

    /// @notice Deploy full creation code with CREATE2 and propose registration in the same transaction.
    /// @dev Reuses existing code. An identical pending proposal keeps its ETA; a different proposal
    ///      must first be cancelled. makeDefault affects new proxies only, after registration.
    function deployVaultImplementation(
        bytes memory creationCode,
        bool makeDefault
    ) external onlyOwner returns (address implementation) {
        if (creationCode.length == 0) revert InvalidImplementation();
        implementation = implementationFor(keccak256(creationCode));
        if (implementation.code.length == 0) {
            bytes32 salt = IMPLEMENTATION_SALT;
            address deployed;
            assembly {
                deployed := create2(
                    0,
                    add(creationCode, 32),
                    mload(creationCode),
                    salt
                )
            }
            if (deployed != implementation || deployed.code.length == 0)
                revert InvalidImplementation();
            emit ImplementationDeployed(
                implementation,
                keccak256(creationCode)
            );
        }
        _checkFactoryBinding(implementation);
        if (proposedImplementationEta != 0) {
            if (
                proposedImplementation != implementation ||
                proposedImplementationMakeDefault != makeDefault
            ) {
                revert ImplementationProposalPending();
            }
            return implementation;
        }
        if (
            isRegisteredImplementation[implementation] &&
            (!makeDefault || baseImplementation == implementation)
        ) {
            return implementation;
        }
        _proposeImplementation(implementation, makeDefault);
    }

    /// @notice Propose an opt-in upgrade target. Replaces a pending proposal and resets its delay.
    function proposeImplementation(address implementation) external onlyOwner {
        if (
            implementation.code.length == 0 ||
            isRegisteredImplementation[implementation]
        ) revert InvalidImplementation();
        _checkFactoryBinding(implementation); // bound to this factory, however it was deployed
        _proposeImplementation(implementation, false);
    }

    /// @notice Propose a registered target as the starting implementation for future proxies.
    function proposeDefaultImplementation(
        address implementation
    ) external onlyOwner {
        if (
            !isRegisteredImplementation[implementation] ||
            implementation == baseImplementation
        ) revert InvalidImplementation();
        _checkFactoryBinding(implementation);
        _proposeImplementation(implementation, true);
    }

    function _proposeImplementation(
        address implementation,
        bool makeDefault
    ) private {
        proposedImplementation = implementation;
        proposedImplementationMakeDefault = makeDefault;
        proposedImplementationEta =
            uint64(block.timestamp) +
            DEFAULT_VERIFIER_DELAY;
        emit ImplementationProposed(implementation, proposedImplementationEta);
        emit ImplementationDefaultProposed(
            implementation,
            makeDefault,
            proposedImplementationEta
        );
    }

    function _checkFactoryBinding(address implementation) private view {
        (bool ok, bytes memory result) = implementation.staticcall(
            abi.encodeWithSignature("factory()")
        );
        if (
            !ok ||
            result.length != 32 ||
            abi.decode(result, (bytes32)) !=
            bytes32(uint256(uint160(address(this))))
        ) {
            revert InvalidImplementation();
        }
    }

    function cancelImplementationProposal() external onlyOwner {
        if (proposedImplementationEta == 0) revert NothingProposed();
        emit ImplementationProposalCancelled(proposedImplementation);
        delete proposedImplementation;
        delete proposedImplementationEta;
        delete proposedImplementationMakeDefault;
    }

    function registerImplementation() external onlyOwner {
        uint64 eta = proposedImplementationEta;
        if (eta == 0) revert NothingProposed();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        address implementation = proposedImplementation;
        bool makeDefault = proposedImplementationMakeDefault;
        if (implementation.code.length == 0) revert InvalidImplementation();
        _checkFactoryBinding(implementation); // re-checked at registration: the code could not change, but the rule is one
        delete proposedImplementation;
        delete proposedImplementationEta;
        delete proposedImplementationMakeDefault;
        isRegisteredImplementation[implementation] = true;
        emit ImplementationRegistered(implementation);
        if (makeDefault) {
            baseImplementation = implementation;
            emit DefaultImplementationActivated(implementation);
        }
    }

    /// @notice Remove a registered target immediately, except the current default and original implementation.
    ///         This changes the registry, not the implementation stored in existing proxies.
    function revokeImplementation(address implementation) external onlyOwner {
        if (
            implementation == baseImplementation ||
            implementation == initialImplementation ||
            !isRegisteredImplementation[implementation]
        ) revert InvalidImplementation();
        isRegisteredImplementation[implementation] = false;
        emit ImplementationRevoked(implementation);
    }

    // ------------------------------------------------------------------ policy (timelocked)

    /// @notice Announce a new policy. Takes effect only after `policyChangeDelay`, via
    ///         activatePolicy(). Replaces any pending policy proposal.
    function proposePolicy(address newPolicy) external onlyOwner {
        if (newPolicy.code.length == 0) revert InvalidPolicy();
        proposedPolicy = newPolicy;
        proposedPolicyEta = uint64(block.timestamp) + policyChangeDelay;
        emit PolicyProposed(newPolicy, proposedPolicyEta);
    }

    function cancelPolicyProposal() external onlyOwner {
        if (proposedPolicyEta == 0) revert NothingProposed();
        emit PolicyProposalCancelled(proposedPolicy);
        delete proposedPolicy;
        delete proposedPolicyEta;
    }

    /// @notice Set policy after the proposal delay, provided it approves the current default verifier.
    function activatePolicy() external onlyOwner {
        uint64 eta = proposedPolicyEta;
        if (eta == 0) revert NothingProposed();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        address newPolicy = proposedPolicy;
        if (!IP2IDPolicy(newPolicy).isVerifierAllowed(defaultVerifier))
            revert VerifierNotApproved(defaultVerifier);
        delete proposedPolicy;
        delete proposedPolicyEta;
        policy = newPolicy;
        emit PolicyActivated(newPolicy);
    }

    // ------------------------------------------------------------------ default verifier (timelocked)

    /// @notice Announce a new default verifier (must be allowed by the policy). Takes effect only
    ///         after DEFAULT_VERIFIER_DELAY (14 days), via activateDefaultVerifier(). Replaces any
    ///         pending proposal.
    function proposeDefaultVerifier(address verifier) external onlyOwner {
        if (!IP2IDPolicy(policy).isVerifierAllowed(verifier))
            revert VerifierNotApproved(verifier);
        proposedDefaultVerifier = verifier;
        proposedDefaultEta = uint64(block.timestamp) + DEFAULT_VERIFIER_DELAY;
        emit DefaultVerifierProposed(verifier, proposedDefaultEta);
    }

    function cancelDefaultVerifierProposal() external onlyOwner {
        if (proposedDefaultEta == 0) revert NothingProposed();
        emit DefaultVerifierProposalCancelled(proposedDefaultVerifier);
        delete proposedDefaultVerifier;
        delete proposedDefaultEta;
    }

    /// @notice Set the proposed default after its delay, provided the current policy approves it.
    ///         Failed approval leaves the proposal pending.
    function activateDefaultVerifier() external onlyOwner {
        uint64 eta = proposedDefaultEta;
        if (eta == 0) revert NothingProposed();
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);
        address verifier = proposedDefaultVerifier;
        if (!IP2IDPolicy(policy).isVerifierAllowed(verifier))
            revert VerifierNotApproved(verifier);
        delete proposedDefaultVerifier;
        delete proposedDefaultEta;
        defaultVerifier = verifier;
        emit DefaultVerifierActivated(verifier);
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

    // ------------------------------------------------------------------ vaults

    /// @inheritdoc IP2IdVaultFactory
    function p2idVersion() external pure returns (string memory) {
        return "p2id.factory.v1";
    }

    /// @inheritdoc IP2IdVaultFactory
    function vaultFor(bytes32 identityHash) public view returns (address) {
        return
            address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff),
                                address(this),
                                identityHash,
                                initCodeHash()
                            )
                        )
                    )
                )
            );
    }

    /// @inheritdoc IP2IdVaultFactory
    function isDeployed(bytes32 identityHash) public view returns (bool) {
        return vaultFor(identityHash).code.length != 0;
    }

    /// @notice keccak256 of the vault proxy's creation code (no constructor arguments), for offline derivation.
    function initCodeHash() public pure returns (bytes32) {
        return keccak256(type(PviumP2IDVaultProxy).creationCode);
    }

    /// @inheritdoc IP2IdVaultFactory
    function deploy(bytes32 identityHash) public returns (address vault) {
        vault = vaultFor(identityHash);
        if (vault.code.length != 0) return vault;
        vault = address(new PviumP2IDVaultProxy{salt: identityHash}());
        IP2IDVault(vault).initialize(
            nsHash,
            identityHash,
            minRefundWindow,
            maxRefundWindow
        );
        emit VaultDeployed(identityHash, vault);
    }

    /// @inheritdoc IP2IdVaultFactory
    function fund(
        bytes32 identityHash,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) external payable returns (address vault, uint256 depositId) {
        return
            _fund(
                identityHash,
                defaultVerifier,
                token,
                amount,
                constraint,
                refundWindow,
                ref
            );
    }

    /// @inheritdoc IP2IdVaultFactory
    function fundWith(
        bytes32 identityHash,
        address verifier,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) external payable returns (address vault, uint256 depositId) {
        return
            _fund(
                identityHash,
                verifier,
                token,
                amount,
                constraint,
                refundWindow,
                ref
            );
    }

    function _fund(
        bytes32 identityHash,
        address verifier,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) private returns (address vault, uint256 depositId) {
        vault = deploy(identityHash);
        if (token == address(0)) {
            // Native coin: forward exactly the value sent; the vault checks it equals `amount`.
            return (
                vault,
                P2IDVault(payable(vault)).fundFor{value: msg.value}(
                    msg.sender,
                    verifier,
                    token,
                    amount,
                    constraint,
                    refundWindow,
                    ref
                )
            );
        }
        if (msg.value != 0) revert UnexpectedValue();
        // Measure the factory's balance increase, approve that amount to the vault, and record
        // msg.sender as funder. The vault measures its own balance increase during the second transfer.
        uint256 before = _balanceOf(token);
        _callToken(
            token,
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256)",
                msg.sender,
                address(this),
                amount
            )
        );
        uint256 received = _balanceOf(token) - before;
        if (received == 0) revert NothingReceived();
        _callToken(
            token,
            abi.encodeWithSignature("approve(address,uint256)", vault, received)
        );
        depositId = P2IDVault(payable(vault)).fundFor(
            msg.sender,
            verifier,
            token,
            received,
            constraint,
            refundWindow,
            ref
        );
    }

    function _callToken(address token, bytes memory input) private {
        (bool ok, bytes memory data) = token.call(input);
        if (
            !ok ||
            (data.length != 0 &&
                (data.length != 32 || !abi.decode(data, (bool))))
        ) revert TokenCallFailed();
    }

    function _balanceOf(address token) private view returns (uint256 balance) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", address(this))
        );
        if (!ok || data.length != 32) revert TokenBalanceQueryFailed();
        balance = abi.decode(data, (uint256));
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
}
