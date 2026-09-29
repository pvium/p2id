// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {P2IDVault} from "../P2IDVault.sol";

/// @dev Test implementation with unrestricted writes to proxy storage.
contract MockProxySlotWriter is P2IDVault {
    constructor(address factory_) P2IDVault(factory_) {}

    function overwriteImplementation(address target) external {
        assembly {
            sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, target)
        }
    }

    /// @dev Store value in the supplied slot in the current execution context.
    function writeSlot(bytes32 slot, bytes32 value) external {
        assembly {
            sstore(slot, value)
        }
    }
}

/// @dev Returns uint64.max as a proof floor for future-time filtering tests.
contract MockProxyImpossibleFloor {
    /// @dev Conforming enough to be upgraded to (it records the owner and acknowledges the hook),
    ///      then reports a freshness floor no vault could hold, to try to jam later upgrades.
    mapping(address => address) private _owner;

    function acceptOwnerProof(address verifier, address wallet, uint64) external returns (bytes4) {
        _owner[verifier] = wallet;
        return this.acceptOwnerProof.selector;
    }

    function owner(address verifier) external view returns (address) {
        return _owner[verifier];
    }

    function latestProofIat(address) external pure returns (uint64) {
        return type(uint64).max;
    }

    function untrackedProofIat() external pure returns (uint64) {
        return 0;
    }
}

/// @dev Accepts any call and returns nothing: an accidentally incompatible implementation.
contract MockProxyNoopFallback {
    fallback() external payable {}
    receive() external payable {}
}

/// @dev A hook that scribbles on vault storage, then answers with `length` raw bytes of `word`:
///      lets tests check that a bad acknowledgement rolls every write back.
contract MockProxyHookResponse {
    bytes32 private immutable _word;
    uint256 private immutable _length;

    constructor(bytes32 word, uint256 length) {
        _word = word;
        _length = length;
    }

    fallback() external payable {
        bytes32 word = _word;
        uint256 length = _length;
        assembly {
            sstore(0, 0xdead) // slot 0 is the vault's nsHash: must be rolled back with the failed upgrade
            mstore(0, word)
            return(0, length)
        }
    }
}

/// @dev A hook that never finishes: burns all the gas it is given.
contract MockProxyFailingHook {
    fallback() external payable {
        assembly {
            for {} 1 {} { sstore(add(0x1000, gas()), gas()) }
        }
    }
}
