// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IP2IDVaultProxy
/// @notice A P2ID proxy with creation code fixed for its deployed factory. Its upgradeTo entry
///         point requires an identity proof and a registered target. Delegated implementations
///         are trusted with all proxy storage, including the implementation slot.
interface IP2IDVaultProxy {
    /// @notice ERC-1967 upgrade event.
    event Upgraded(address indexed implementation);

    /// @notice The factory that deployed this proxy and whose registry bounds its implementations.
    function factory() external view returns (address);
    /// @notice The implementation used for delegated calls; proxy-defined selectors take precedence.
    function implementation() external view returns (address);
    /// @notice The wallet and issue time of the proof behind the last upgrade (zero before the first).
    ///         Later upgrades need a proof at least this recent; an equal time only for the same wallet.
    ///         Delegated code can overwrite this record; upgradeTo ignores a record beyond its future-time bound.
    function lastUpgrade() external view returns (address wallet, uint64 iat);
    /// @notice Move this vault to `newImplementation`, which the factory must have registered.
    ///         `proof` is verified through the factory's default verifier for `identityHash` (the
    ///         identity this address was derived from); the wallet it resolves to must be the caller,
    ///         and its issue time must not exceed block.timestamp + 15 minutes or fall below lastUpgrade.
    ///         It must also meet the current implementation's latestProofIat for that verifier and
    ///         untrackedProofIat; failed, malformed or excessively future-dated floor reads count as zero.
    ///         This call writes the implementation slot and lastUpgrade record, then calls
    ///         acceptOwnerProof through the new implementation without verifying the proof again.
    ///         Hook failure reverts the entire upgrade. P2IDVault's hook requires the proven wallet
    ///         to be the resulting cached owner, rejecting conflicting equal-time wallet proofs.
    ///         The proxy requires the hook selector as a canonical 32-byte ABI acknowledgement;
    ///         absent, malformed or incorrect acknowledgements revert the entire upgrade.
    ///         After the hook, the implementation must still match the target, owner(verifier)
    ///         must report the proven wallet, and latestProofIat(verifier) must be at least iat.
    ///         Nested upgradeTo calls revert while an upgrade is running.
    /// @dev Getters run through delegated code and cannot establish that an implementation is safe.
    ///      This entry point performs no separate initialization or storage-migration call.
    function upgradeTo(bytes32 identityHash, address newImplementation, bytes calldata proof) external;
}
