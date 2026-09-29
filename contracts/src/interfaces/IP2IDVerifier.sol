// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IP2IDVerifier
/// @notice Resolve an identity proof to a wallet and issue time, with optional constraint evidence.
interface IP2IDVerifier {
    /// @notice A funding constraint and the evidence that it is satisfied.
    /// @param commitment bytes32(0) = no constraint; otherwise the commitment a deposit was funded with.
    /// @param signature  Evidence for `commitment`; for PviumVerifier, the registered signer's
    ///                   EIP-712 signature over Constraint(bytes32 commitment) in the verifier's
    ///                   domain. Empty when commitment is zero.
    struct Constraint {
        bytes32 commitment;
        bytes signature;
    }

    /// @param identityHash Expected identity commitment that the implementation must match against the proof.
    /// @param proof        Opaque identity proof; the implementation defines the encoding.
    /// @param constraint   Skipped when `constraint.commitment == bytes32(0)`.
    /// @return wallet Wallet associated with the proven identity (never address(0)).
    /// @return iat    When the underlying attestation was issued (unix seconds).
    /// @dev MUST revert (never return address(0)) if the proof is invalid, is for a different
    ///      identity than `identityHash`, or the constraint is not satisfied.
    function getIdentityWallet(
        bytes32 identityHash,
        bytes calldata proof,
        Constraint calldata constraint
    ) external view returns (address wallet, uint64 iat);

    /// @notice Whether this verifier currently supports nonzero constraints. P2IDVault requires
    ///         a successful true response when funding a constrained deposit; this does not establish
    ///         that any particular commitment can be satisfied.
    function supportsConstraints() external view returns (bool);

    /// @notice Cache revision. Implementations must increment it when previously accepted identity
    ///         proofs may no longer be trusted, or return a constant if trust cannot be revoked.
    /// @dev P2IDVault rejects cached-owner claims when this differs from the stored revision, and
    ///      rejects cached-owner claims and proof updates when the revision cannot be read.
    function revision() external view returns (uint64);
}
