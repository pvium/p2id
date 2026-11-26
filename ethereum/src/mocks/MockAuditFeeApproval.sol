// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MockFeePolicy} from "./MockP2IDVerifiers.sol";

/// @dev Token with conventional transfers and configurable approval failures (audit regression).
contract MockAuditFeeApprovalToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public mode;
    function setMode(uint8 value) external { mode = value; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        if (mode == 1 && amount == 0) return false;
        if (mode == 2) { assembly { mstore(0, 2) return(0, 32) } }
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Models a policy using an allowance outside the vault's collection call.
contract MockAuditDeferredFeePolicy is MockFeePolicy {
    function pullLater(address token, address vault, address to, uint256 amount) external {
        MockAuditFeeApprovalToken(token).transferFrom(vault, to, amount);
    }
}
