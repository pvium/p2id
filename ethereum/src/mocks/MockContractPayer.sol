// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IMockApprovable {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev The v2 funding entry point, declared here so the mock does not depend on the vault source.
interface IP2IDVaultRefunder {
    function fundWithRefunder(address verifier, address token, uint256 amount, bytes32 constraint, uint64 refundWindow, address refundAddress, bytes32 ref)
        external
        payable
        returns (uint256 depositId);
}

/// @dev Test stand-in for a contract that pays into a P2ID vault (an escrow, a batch payer, a
///      treasury) and cannot call refund() itself. It names a refunder through
///      P2IDVaultV2.fundWithRefunder so an unclaimed payment can still be recovered.
contract MockContractPayer {
    function pay(address vault, address refunder, address verifier, address token, uint256 amount, uint64 refundWindow)
        external
        returns (uint256 depositId)
    {
        IMockApprovable(token).approve(vault, amount);
        return IP2IDVaultRefunder(vault).fundWithRefunder(verifier, token, amount, bytes32(0), refundWindow, refunder, bytes32(0));
    }

    function payNative(address vault, address refunder, address verifier, uint64 refundWindow)
        external
        payable
        returns (uint256 depositId)
    {
        return IP2IDVaultRefunder(vault).fundWithRefunder{value: msg.value}(verifier, address(0), msg.value, bytes32(0), refundWindow, refunder, bytes32(0));
    }
}
