// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IP2IdVaultFactory
/// @notice Vault proxy deployment, address derivation, funding and shared configuration views.
interface IP2IdVaultFactory {
    event VaultDeployed(bytes32 indexed identityHash, address indexed vault);
    event ImplementationProposed(address indexed implementation, uint64 eta);
    event ImplementationProposalCancelled(address indexed implementation);
    event ImplementationRegistered(address indexed implementation);
    event ImplementationDeployed(address indexed implementation, bytes32 creationCodeHash);
    event ImplementationDefaultProposed(address indexed implementation, bool makeDefault, uint64 eta);
    event DefaultImplementationActivated(address indexed implementation);
    event ImplementationRevoked(address indexed implementation);

    /// @notice P2ID factory interface version implemented by this contract.
    function p2idVersion() external pure returns (string memory);

    // ---- shared configuration ----
    /// @notice Policy address used for verifier approval, fee quotes and fee collection.
    function policy() external view returns (address);
    /// @notice Policy awaiting activation after its notice period; address(0) when none.
    function proposedPolicy() external view returns (address);
    /// @notice Ceiling on policy fee quotes in basis points; vaults clamp every quote to it. Fixed, no setter.
    function MAX_FEE_BPS() external view returns (uint16);
    /// @notice Verifier used when a payer does not choose one, and the one bare transfers are claimed through.
    function defaultVerifier() external view returns (address);
    /// @notice Whether proofs under `vkHash` need an alpha attestation: true for every key until released.
    function isAlpha(bytes32 vkHash) external view returns (bool);
    function setDefaultAttester(address attester) external;
    function defaultAttester() external view returns (address);
    function alphaRevision(bytes32 vkHash) external view returns (uint256);
    function alphaEpoch() external view returns (uint256);
    function verifyAlphaAuthorization(address vault, address caller, bytes32 callHash, uint256 nonce, uint256 deadline, bytes calldata signature) external view;

    // ---- vault implementations ----
    /// @notice The implementation every newly deployed vault proxy starts on.
    function baseImplementation() external view returns (address);
    /// @notice Whether the implementation is registered as an upgrade target; other upgrade checks also apply.
    function isRegisteredImplementation(address implementation) external view returns (bool);

    function initialImplementation() external view returns (address);
    function implementationFor(bytes32 creationCodeHash) external view returns (address);
    /// @notice Deploy full creation code and propose registration; makeDefault applies after the delay.
    function deployVaultImplementation(bytes memory creationCode, bool makeDefault) external returns (address);
    function proposeDefaultImplementation(address implementation) external;

    // ---- address derivation constants ----
    /// @notice Namespace value supplied to the factory constructor and passed to vault initialization.
    function nsHash() external view returns (bytes32);
    /// @notice Proxy creation-code hash used with this factory's address and an identityHash for CREATE2 derivation.
    function initCodeHash() external pure returns (bytes32);
    /// @notice Refund-window bounds passed to new vaults during initialization.
    function minRefundWindow() external view returns (uint64);
    function maxRefundWindow() external view returns (uint64);

    // ---- vaults ----
    /// @notice The vault address for `identityHash`, deployed or not:
    ///         Low 160 bits of `keccak256(0xff || factory || identityHash || initCodeHash())`.
    function vaultFor(bytes32 identityHash) external view returns (address);
    function isDeployed(bytes32 identityHash) external view returns (bool);
    /// @notice Deploy the vault for `identityHash`; returns the existing one if already deployed.
    function deploy(bytes32 identityHash) external returns (address vault);
    /// @notice Deploy if needed, then fund under the default verifier on the caller's behalf
    ///         (caller is recorded as funder). ERC-20: approve this factory for the requested amount.
    ///         Native coin: token = address(0), send `amount` as msg.value.
    /// @param ref Opaque application reference forwarded to the vault's Funded event; bytes32(0) for none.
    function fund(
        bytes32 identityHash,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) external payable returns (address vault, uint256 depositId);
    /// @notice Same, under a chosen approved verifier.
    /// @param ref Opaque application reference forwarded to the vault's Funded event; bytes32(0) for none.
    function fundWith(
        bytes32 identityHash,
        address verifier,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) external payable returns (address vault, uint256 depositId);
}
