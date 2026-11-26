// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IPviumIdentity
/// @notice Attestation verification and signer/version views exposed by PviumIdentity.
///         verifyIdentity checks the supplied identity type, identity hash and wallet hash.
interface IPviumIdentity {
    /// @notice Circuit version this deployment verifies. Attestations state theirs; use the matching deployment.
    function vkHash() external view returns (bytes32);
    function circuitVersion() external view returns (uint16);
    /// @notice Whether this P-256 key belongs to the deployment's current accepted signer set.
    function isSignerKey(uint256 x, uint256 y) external view returns (bool);

    /// @notice Verify that the proof binds exactly this identity and this wallet.
    /// @dev The expected identity and wallet are supplied as hashes. The function does not impose
    ///      an age limit on the attestation.
    /// @param identityType Identity type id: 0 email, 3 twitter, 5 github, … (see P2IDHash)
    /// @param identityHash P2IDHash.identityHash(identityType, value)
    /// @param walletHash   P2IDHash.walletHash(wallet): an address, or a string for a non-EVM wallet
    function verifyIdentity(
        bytes calldata proof,
        bytes32[] calldata publicInputs,
        uint8 identityType,
        bytes32 identityHash,
        bytes32 walletHash
    ) external view returns (uint64 issuedAt);
}
