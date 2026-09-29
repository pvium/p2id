// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVault} from "../interfaces/IP2IDVault.sol";
import {IP2IDVaultProxy} from "../interfaces/IP2IDVaultProxy.sol";

/// @dev Deliberately incompatible hook implementations for proxy post-condition tests.
contract MockProxyPostconditions {
    uint256 private immutable mode;
    address private immutable reportedOwner;
    uint64 private immutable reportedIat;
    address private immutable replacement;

    constructor(uint256 mode_, address owner_, uint64 iat_, address replacement_) {
        mode = mode_;
        reportedOwner = owner_;
        reportedIat = iat_;
        replacement = replacement_;
    }

    function acceptOwnerProof(address, address, uint64) external returns (bytes4) {
        // Verify that rejection rolls back delegated writes as well as proxy writes.
        assembly { sstore(0, 0xdead) }
        if (mode == 1) {
            address target = replacement;
            assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, target) }
        }
        if (mode == 2) {
            (bool ok, bytes memory result) = address(this).call(
                abi.encodeCall(IP2IDVaultProxy.upgradeTo, (bytes32(0), replacement, bytes("")))
            );
            require(!ok && result.length == 4 && bytes4(result) == bytes4(keccak256("UpgradeReentered()")),
                "nested upgrade was not stopped at entry");
        }
        return IP2IDVault.acceptOwnerProof.selector;
    }

    function owner(address) external view returns (address) {
        if (mode == 3) revert("unreadable owner");
        return reportedOwner;
    }

    function latestProofIat(address) external view returns (uint64) {
        if (mode == 4) revert("unreadable floor");
        return reportedIat;
    }

    function untrackedProofIat() external pure returns (uint64) { return 0; }
}
