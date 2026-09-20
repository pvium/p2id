// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IPviumIdentity
/// @notice Verify a Pvium attestation on chain: "identity X and wallet W belong to the same
///         Privy user". Every function reverts unless the proof is valid, was made from a token
///         signed by one of the accepted keys, and binds exactly the values given. The return value is
///         when Privy issued that token (unix seconds); freshness policy is the caller's.
interface IPviumIdentity {
    /// @notice Circuit version this deployment verifies. Attestations state theirs; use the matching deployment.
    function circuitVersion() external view returns (uint16);
    /// @notice Whether tokens signed by this P-256 key are accepted (the set is fixed at deployment).
    function isSignerKey(uint256 x, uint256 y) external view returns (bool);

    /// @notice Verify that the proof binds exactly this identity and this wallet.
    /// @dev Both are passed as hashes (P2IDHash on chain, or the SDK's identityHash), so the raw
    ///      identity never appears in calldata.
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
