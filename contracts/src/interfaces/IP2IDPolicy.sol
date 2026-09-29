// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IP2IDPolicy
/// @notice Verifier approval, fee quotation and fee distribution callbacks used by P2IDVault.
/// @dev P2IDVault caps fee quotes, stores rates on funded deposits and quotes untracked funds at
///      sweep time. It skips policy approval for claims through the current default verifier.
interface IP2IDPolicy {
    /// @notice Approval used for funding and for claims through a non-default verifier.
    function isVerifierAllowed(address verifier) external view returns (bool);

    /// @notice Fee on paying out `token` claimed through `verifier`, in basis points. Quoted when a
    ///         deposit is made (and fixed for it), or at sweep time for untracked funds.
    function feeBps(address verifier, address token) external view returns (uint16);

    /// @notice Called by a vault holding fees earned through `verifier`. For an ERC-20 the vault
    ///         first approves this policy for exactly `amount`: pull the tokens (transferFrom the
    ///         caller) and distribute them; whatever is not pulled stays accrued in the vault, and
    ///         the allowance is reset afterwards.
    ///         For the native coin (token == address(0)) the vault sends `amount` as msg.value
    ///         instead, and all of it counts as distributed.
    function distributeFee(address verifier, address token, uint256 amount) external payable;
}
