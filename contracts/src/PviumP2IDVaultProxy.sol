// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVaultProxy} from "./interfaces/IP2IDVaultProxy.sol";
import {IP2IdVaultFactory} from "./interfaces/IP2IdVaultFactory.sol";
import {IP2IDVault} from "./interfaces/IP2IDVault.sol";
import {IP2IDVerifier} from "./interfaces/IP2IDVerifier.sol";

/// @title PviumP2IDVaultProxy
/// @notice CREATE2 vault proxy initialized from its deploying factory's baseImplementation.
///         upgradeTo requires a registered target and an identity proof resolving to the caller.
/// @dev Stores the implementation in the ERC-1967 slot and upgrade history in UPGRADE_SLOT.
///      Delegated code can write both slots. Proxy-defined selectors take precedence over the
///      implementation, and empty-calldata native transfers are handled here without delegation.
contract PviumP2IDVaultProxy is IP2IDVaultProxy {
    /// @dev bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    /// @dev bytes32(uint256(keccak256("pvium.vault.proxy.upgrading")) - 1): 1 while upgradeTo runs (a plain slot: the Paris target has no transient storage).
    bytes32 private constant UPGRADING_SLOT = 0x1355c758876c0a085036d5960a223942d04ee15c92162da025899b2513e77bae;
    /// @dev bytes32(uint256(keccak256("pvium.vault.proxy.lastUpgrade")) - 1): wallet (160 bits) | iat << 160.
    bytes32 private constant UPGRADE_SLOT = 0x01d942a94cdff9c1162dd0a9d8cabadc4e9bf5ab8b614fc78cedc4d44e694edf;
    /// @dev Maximum accepted issue time ahead of block.timestamp, matching P2IDVault.
    uint64 private constant FUTURE_SLACK = 15 minutes;
    /// @dev Gas for reading the vault's own freshness floors through the implementation.
    uint256 private constant READ_GAS = 100_000;

    /// @inheritdoc IP2IDVaultProxy
    address public immutable factory;

    error NotRegisteredImplementation(address implementation);
    error NotVaultOf(bytes32 identityHash);
    error NotOwner(address proven, address caller);
    error ProofTooOld();
    error ProofFromFuture();
    error SameImplementation();
    error NotAContract(address implementation);
    error HookNotAcknowledged(address implementation);
    error UpgradeReentered();
    error ImplementationChangedDuringHook(address found);
    error HookDidNotApply(address owner, uint64 latest);

    constructor() {
        factory = msg.sender;
        _setImplementation(IP2IdVaultFactory(msg.sender).baseImplementation());
    }

    /// @inheritdoc IP2IDVaultProxy
    function implementation() public view returns (address impl) {
        assembly {
            impl := sload(IMPLEMENTATION_SLOT)
        }
    }

    /// @inheritdoc IP2IDVaultProxy
    function lastUpgrade() public view returns (address wallet, uint64 iat) {
        uint256 packed;
        assembly {
            packed := sload(UPGRADE_SLOT)
        }
        wallet = address(uint160(packed));
        iat = uint64(packed >> 160);
    }

    /// @inheritdoc IP2IDVaultProxy
    function upgradeTo(bytes32 identityHash, address newImplementation, bytes calldata proof) external {
        _enterUpgrade();
        IP2IdVaultFactory f = IP2IdVaultFactory(factory);
        if (f.vaultFor(identityHash) != address(this)) revert NotVaultOf(identityHash);
        if (!f.isRegisteredImplementation(newImplementation)) revert NotRegisteredImplementation(newImplementation);
        if (newImplementation == implementation()) revert SameImplementation();
        address verifier = f.defaultVerifier();
        (address wallet, uint64 iat) =
            IP2IDVerifier(verifier).getIdentityWallet(identityHash, proof, IP2IDVerifier.Constraint(bytes32(0), ""));
        if (wallet != msg.sender) revert NotOwner(wallet, msg.sender);
        if (iat > block.timestamp + FUTURE_SLACK) revert ProofFromFuture();
        // Combine stored upgrade history with the readable issue-time floors of the current implementation.
        (address lastWallet, uint64 lastIat) = lastUpgrade();
        // Ignore stored history beyond this entry point's accepted future-time bound.
        if (lastIat > block.timestamp + FUTURE_SLACK) (lastWallet, lastIat) = (address(0), 0);
        if (iat < lastIat || (iat == lastIat && wallet != lastWallet)) revert ProofTooOld();
        if (iat < _vaultFloor(verifier)) revert ProofTooOld();
        uint256 packed = uint256(uint160(wallet)) | (uint256(iat) << 160);
        assembly {
            sstore(UPGRADE_SLOT, packed)
        }
        _setImplementation(newImplementation);
        // Apply the verified result through the new implementation. Revert the upgrade on hook
        // failure, invalid acknowledgement or failed post-condition checks below.
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(IP2IDVault.acceptOwnerProof, (verifier, wallet, iat)));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret)) // the vault's own reason (ProofTooOld, NotOwnerProof, …)
            }
        }
        // Require a canonical ABI-encoded selector. A fallback returning the same data can satisfy this.
        if (ret.length != 32 || abi.decode(ret, (bytes4)) != IP2IDVault.acceptOwnerProof.selector) {
            revert HookNotAcknowledged(newImplementation);
        }
        // Post-conditions, read through the new implementation: it is still what was installed,
        // and it now records this wallet as the payout owner with a floor at least this fresh.
        // These detect some incompatible hooks. Registered code can fake getters or alter other storage;
        // the registry does not audit implementation behavior.
        if (implementation() != newImplementation) revert ImplementationChangedDuringHook(implementation());
        address ownerNow = address(uint160(_read(abi.encodeCall(IP2IDVault.owner, (verifier)))));
        uint256 latestNow = _read(abi.encodeCall(IP2IDVault.latestProofIat, (verifier)));
        if (ownerNow != wallet || latestNow < iat) revert HookDidNotApply(ownerNow, uint64(latestNow));
        _exitUpgrade();
    }

    /// @dev upgradeTo is not reentrant: the hook runs with the new implementation installed, and
    ///      must not be able to start another upgrade from inside this one.
    function _enterUpgrade() private {
        uint256 flag;
        assembly {
            flag := sload(UPGRADING_SLOT)
        }
        if (flag != 0) revert UpgradeReentered();
        assembly {
            sstore(UPGRADING_SLOT, 1)
        }
    }

    function _exitUpgrade() private {
        assembly {
            sstore(UPGRADING_SLOT, 0)
        }
    }

    /// @dev Maximum of the current implementation's per-verifier and cross-default floors.
    ///      Failed, malformed and excessively future-dated reads contribute zero.
    function _vaultFloor(address verifier) private view returns (uint64 floor) {
        uint256 a = _read(abi.encodeCall(IP2IDVault.latestProofIat, (verifier)));
        uint256 b = _read(abi.encodeCall(IP2IDVault.untrackedProofIat, ()));
        // Discard values beyond the same future-time bound used for proofs.
        uint256 limit = block.timestamp + FUTURE_SLACK;
        if (a > limit) a = 0;
        if (b > limit) b = 0;
        floor = uint64(a > b ? a : b);
    }

    function _read(bytes memory data) private view returns (uint256 value) {
        (bool ok, bytes memory ret) = address(this).staticcall{gas: READ_GAS}(data);
        if (!ok || ret.length != 32) return 0;
        value = abi.decode(ret, (uint256));
    }

    /// @dev Accepted here, not delegated: keeps plain sends within the 2300-gas stipend.
    receive() external payable {}

    fallback() external payable {
        address impl = implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function _setImplementation(address impl) private {
        if (impl.code.length == 0) revert NotAContract(impl);
        assembly {
            sstore(IMPLEMENTATION_SLOT, impl)
        }
        emit Upgraded(impl);
    }
}
