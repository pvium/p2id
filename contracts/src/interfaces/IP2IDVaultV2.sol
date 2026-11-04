// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVault} from "./IP2IDVault.sol";

/// @title IP2IDVaultV2
/// @notice The business interface of the second vault implementation: everything in IP2IDVault,
///         plus a refunder a payer may name at funding time. A vault still on the first
///         implementation does not expose these entries (the calls revert with no data), so a
///         caller must check the proxy's implementation() before relying on them.
interface IP2IDVaultV2 is IP2IDVault {
    /// @notice Fund under `verifier` and name `refundAddress` as the refunder: the one account that may
    ///         refund the deposit after its window, and the one paid. address(0) names the caller.
    ///         The caller stays the funder of record (Funded.funder, constraint reservation); only the
    ///         refund right moves. Lets a contract payer that cannot call refund() route recoveries to
    ///         an account that can. Native coin and ERC-20 as in fundWith().
    /// @param ref Opaque application reference emitted in Funded; bytes32(0) for none.
    function fundWithRefunder(
        address verifier,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        address refundAddress,
        bytes32 ref
    ) external payable returns (uint256 depositId);

    /// @notice The refunder named for a deposit; address(0) means its funder (every deposit made under
    ///         the first implementation, and every later deposit funded without a refunder).
    function depositRefunder(uint256 depositId) external view returns (address);
}
