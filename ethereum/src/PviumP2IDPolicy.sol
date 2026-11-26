// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDPolicy} from "./interfaces/IP2IDPolicy.sol";
import {IP2IdVaultFactory} from "./interfaces/IP2IdVaultFactory.sol";

/// @title PviumP2IDPolicy
/// @notice Owner-managed verifier allowlist with a zero fee quote and a fee treasury.
/// @dev Verifier approval checks code presence. Collection checks the caller against the
///      configured factory's address derivation using the caller's reported saltCommitment().
///      Fees are booked per verifier and token and withdrawn by the owner. Collection reverts
///      until a factory is configured.
contract PviumP2IDPolicy is IP2IDPolicy {
    address public owner;
    address public pendingOwner;
    /// @notice Factory whose vaults may hand fees to this policy. Set once by the owner.
    address public factory;
    mapping(address verifier => bool) public approvedVerifiers;
    /// @notice Fees received and not yet withdrawn, per verifier they were earned through and token.
    mapping(address verifier => mapping(address token => uint256)) public feesOwed;
    /// @notice Total booked fees per token, reduced on withdrawal. ERC-20 collection requires
    ///         the reported balance to cover this total plus the requested amount.
    mapping(address token => uint256) public accounted;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);
    event FeeReceived(address indexed vault, address indexed verifier, address indexed token, address claimer, uint256 amount);
    event FeeWithdrawn(address indexed verifier, address indexed token, address indexed to, uint256 amount);
    event FactorySet(address indexed factory);

    error NotOwner();
    error NotPendingOwner();
    error InvalidOwner();
    error InvalidVerifier();
    error InvalidRecipient();
    error InsufficientFees();
    error FeeNotReceived();
    error NotVault();
    error InvalidFactory();
    error FactoryAlreadySet();
    error NativeValueMismatch();
    error TokenCallFailed();
    error NativeTransferFailed();

    constructor(address _owner, address[] memory _verifiers) {
        if (_owner == address(0)) revert InvalidOwner();
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
        for (uint256 i = 0; i < _verifiers.length; i++) _setApproval(_verifiers[i], true);
    }

    /// @notice Approve (or revoke) a verifier.
    function approveVerifier(address verifier, bool approved) external onlyOwner {
        _setApproval(verifier, approved);
    }

    /// @inheritdoc IP2IDPolicy
    function isVerifierAllowed(address verifier) external view returns (bool) {
        return approvedVerifiers[verifier];
    }

    /// @inheritdoc IP2IDPolicy
    function feeBps(address, address) external pure returns (uint16) {
        return 0;
    }

    /// @notice Bind a factory once. Require code, the expected reported factory version and
    ///         this policy as the factory's reported current or proposed policy.
    function setFactory(address _factory) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (_factory.code.length == 0) revert InvalidFactory();
        (bool ok, bytes memory data) = _factory.staticcall(abi.encodeCall(IP2IdVaultFactory.p2idVersion, ()));
        if (!ok || data.length < 64 || keccak256(abi.decode(data, (bytes))) != keccak256("p2id.factory.v1")) revert InvalidFactory();
        IP2IdVaultFactory f = IP2IdVaultFactory(_factory);
        if (f.policy() != address(this) && f.proposedPolicy() != address(this)) revert InvalidFactory();
        factory = _factory;
        emit FactorySet(_factory);
    }

    /// @notice Whether `vault` has code and matches the configured factory's derived address
    ///         for its reported saltCommitment().
    function isVault(address vault) public view returns (bool) {
        address f = factory;
        if (f == address(0) || vault.code.length == 0) return false;
        (bool ok, bytes memory data) = vault.staticcall(abi.encodeWithSignature("saltCommitment()"));
        if (!ok || data.length != 32) return false;
        return IP2IdVaultFactory(f).vaultFor(abi.decode(data, (bytes32))) == vault;
    }

    /// @inheritdoc IP2IDPolicy
    /// @dev Require isVault(msg.sender). Native value must equal amount; ERC-20 amount must
    ///      fit within the reported balance minus accounted fees. The ERC-20 check includes
    ///      any prior unbooked balance and does not measure a transfer from this caller.
    function collectFee(address verifier, address token, address claimer, uint256 amount) external payable {
        if (!isVault(msg.sender)) revert NotVault();
        if (token == address(0)) {
            if (msg.value != amount) revert NativeValueMismatch();
        } else {
            if (msg.value != 0) revert NativeValueMismatch();
            uint256 unbooked = _balanceOf(token) - accounted[token];
            if (unbooked < amount) revert FeeNotReceived();
        }
        accounted[token] += amount;
        feesOwed[verifier][token] += amount;
        emit FeeReceived(msg.sender, verifier, token, claimer, amount);
    }

    /// @notice Owner-only withdrawal of fees booked under `verifier` and `token` to `to`.
    function withdrawFees(address verifier, address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidRecipient();
        uint256 owed = feesOwed[verifier][token];
        if (amount > owed) revert InsufficientFees();
        feesOwed[verifier][token] = owed - amount;
        accounted[token] -= amount;
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            _callToken(token, abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        }
        emit FeeWithdrawn(verifier, token, to, amount);
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || data.length != 32) revert TokenCallFailed();
        return abi.decode(data, (uint256));
    }

    function _callToken(address token, bytes memory input) private {
        (bool ok, bytes memory data) = token.call(input);
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TokenCallFailed();
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

    function _setApproval(address verifier, bool approved) private {
        if (approved && verifier.code.length == 0) revert InvalidVerifier();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
}
