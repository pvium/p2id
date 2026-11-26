// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {P2IDHash} from "../lib/P2IDHash.sol";

/// @dev Test harness exposing the P2IDHash library.
contract MockP2IDHash {
    function identityHash(uint8 identityType, bytes calldata value) external pure returns (bytes32) {
        return P2IDHash.identityHash(identityType, value);
    }

    function walletHash(address wallet) external pure returns (bytes32) {
        return P2IDHash.walletHash(wallet);
    }

    function walletHashString(string calldata wallet) external pure returns (bytes32) {
        return P2IDHash.walletHash(wallet);
    }
}
