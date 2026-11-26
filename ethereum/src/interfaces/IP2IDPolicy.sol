// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IP2IDPolicy
/// @notice Verifier approval, fee quotation and fee collection callbacks used by P2IDVault.
/// @dev P2IDVault caps fee quotes, stores rates on funded deposits, quotes untracked funds at
///      sweep time and hands each fee to the policy at claim time. It skips policy approval for
///      claims through the current default verifier.
interface IP2IDPolicy {
    /// @notice Approval used for funding and for claims through a non-default verifier.
    function isVerifierAllowed(address verifier) external view returns (bool);

    /// @notice Fee on paying out `token` claimed through `verifier`, in basis points. Quoted when a
    ///         deposit is made (and fixed for it), or at sweep time for untracked funds.
    function feeBps(address verifier, address token) external view returns (uint16);

    /// @notice Called by a vault at claim time with the fee it is charging, so the policy can
    ///         record who earned it (`verifier`) and who triggered the claim (`claimer`, the claim
    ///         transaction's msg.sender, possibly a contract). The fee has already arrived: for an
    ///         ERC-20 the vault transferred `amount` to this contract immediately before the call,
    ///         in the same atomic step; for the native coin (token == address(0)) `amount` is
    ///         msg.value. Revert to refuse the fee: the transfer is undone with the call and the
    ///         whole fee is paid to the recipient instead. The vault grants no allowance and keeps
    ///         no fees. A revert never blocks the claim. Implementations should verify receipt
    ///         before booking anything, since any contract can call this.
    function collectFee(address verifier, address token, address claimer, uint256 amount) external payable;
}
