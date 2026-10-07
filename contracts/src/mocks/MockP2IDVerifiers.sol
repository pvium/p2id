// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVerifier} from "../interfaces/IP2IDVerifier.sol";
import {P2IDVault} from "../P2IDVault.sol";
import {IP2IDPolicy} from "../interfaces/IP2IDPolicy.sol";

/// @dev Test stub: proof = abi.encode(address wallet, bytes32 identityHash, uint64 iat).
///      A constraint is "satisfied" when its signature equals the bytes "ok".
contract MockIdentityVerifier is IP2IDVerifier {
    bytes32 public vkHash = keccak256("mock.vk.v1");
    function setVkHash(bytes32 hash) external { vkHash = hash; }
    error MockIdentityMismatch();
    error MockConstraintFailed();

    function getIdentityWallet(bytes32 identityHash, bytes calldata proof, Constraint calldata constraint)
        external
        pure
        returns (address wallet, uint64 iat)
    {
        bytes32 proven;
        (wallet, proven, iat) = abi.decode(proof, (address, bytes32, uint64));
        if (proven != identityHash) revert MockIdentityMismatch();
        if (constraint.commitment != bytes32(0) && keccak256(constraint.signature) != keccak256("ok")) {
            revert MockConstraintFailed();
        }
    }

    uint64 private _revision;
    bool public revisionBroken;

    function setRevision(uint64 r) external {
        _revision = r;
    }

    /// @dev Simulate a verifier whose revision() cannot be read.
    function breakRevision(bool broken) external {
        revisionBroken = broken;
    }

    function revision() external view returns (uint64) {
        require(!revisionBroken, "revision unavailable");
        return _revision;
    }

    function supportsConstraints() external pure virtual returns (bool) {
        return true;
    }
}

/// @dev MockIdentityVerifier variant reporting supportsConstraints() == false.
contract MockNoConstraintVerifier is MockIdentityVerifier {
    function supportsConstraints() external pure override returns (bool) {
        return false;
    }
}

interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @dev Test policy with adjustable allowlist, fee rate and collection, and failure modes.
///      Fees arrive before collectFee (ERC-20 transferred, native as msg.value); the mock splits
///      them between operatorOf[verifier] and recipient.
contract MockFeePolicy is IP2IDPolicy {
    mapping(address => bool) public allowed;
    uint16 public bps;
    address public recipient;
    mapping(address verifier => address) public operatorOf;
    uint16 public operatorShareBps;
    /// 0 = normal, 1 = feeBps reverts, 2 = feeBps loops until failure, 5 = collectFee reverts,
    /// 6 = collectFee loops until failure.
    uint8 public mode;
    /// What collectFee recorded: fee per verifier/token and per claimer/token, as a real policy would.
    mapping(address verifier => mapping(address token => uint256)) public collected;
    mapping(address claimer => mapping(address token => uint256)) public claimerFees;

    function allow(address verifier, bool ok) external {
        allowed[verifier] = ok;
    }

    function setFee(uint16 _bps, address _recipient) external {
        bps = _bps;
        recipient = _recipient;
    }

    function setMode(uint8 _mode) external {
        mode = _mode;
    }

    function isVerifierAllowed(address verifier) external view returns (bool) {
        return allowed[verifier];
    }

    function feeBps(address, address) external view returns (uint16) {
        _misbehave();
        return bps;
    }

    function setOperator(address verifier, address operator, uint16 shareBps) external {
        operatorOf[verifier] = operator;
        operatorShareBps = shareBps;
    }

    function collectFee(address verifier, address token, address claimer, uint256 amount) external payable {
        if (mode == 5) revert("collection down");
        if (mode == 6) {
            uint256 x;
            while (true) x++; // intentional gas exhaustion: the vault's stipend must bound this
        }
        // the tokens (or msg.value) are already here: book and forward them
        collected[verifier][token] += amount;
        claimerFees[claimer][token] += amount;
        uint256 toOperator = operatorOf[verifier] == address(0) ? 0 : (amount * operatorShareBps) / 10_000;
        if (token == address(0)) {
            if (toOperator != 0) _send(operatorOf[verifier], toOperator);
            _send(recipient, amount - toOperator);
        } else {
            if (toOperator != 0) IERC20Min(token).transfer(operatorOf[verifier], toOperator);
            IERC20Min(token).transfer(recipient, amount - toOperator);
        }
    }

    function _send(address to, uint256 value) private {
        (bool ok, ) = payable(to).call{value: value}("");
        require(ok, "send failed");
    }

    function _misbehave() private view {
        if (mode == 1) revert("policy down");
        if (mode == 2) {
            uint256 x;
            while (true) x++; // intentional gas exhaustion in the query test
        }
    }
}

/// @dev A wallet that tries to re-enter the vault when it is paid in native coin.
contract MockReentrantWallet {
    address public target;
    bytes public payload;

    function arm(address _target, bytes calldata _payload) external {
        target = _target;
        payload = _payload;
    }

    receive() external payable {
        if (target != address(0)) {
            (bool ok, bytes memory ret) = target.call(payload);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

/// @dev Uses Solidity transfer to test receipt with a 2300-gas stipend.
contract MockNativeSender {
    function send(address payable to) external payable {
        to.transfer(msg.value);
    }
}

/// @dev A second vault implementation for proxy tests: the base vault plus one new function.
contract MockVaultV2 is P2IDVault {
    constructor(address _factory) P2IDVault(_factory) {}

    function version2() external pure returns (uint8) {
        return 2;
    }
}

/// @dev A compatible implementation: the base layout untouched, one variable appended.
contract MockVaultAppends is P2IDVault {
    uint256 public extra;

    constructor(address _factory) P2IDVault(_factory) {}
}

/// @dev An old target that cannot retain alpha protection; proxy upgrades must reject it.
contract MockNoAlphaVault {
    address public immutable factory;
    constructor(address factory_) { factory = factory_; }
    function supportsAlphaGuard() external pure returns (bool) { return false; }
}
