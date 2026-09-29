// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVerifier} from "../interfaces/IP2IDVerifier.sol";
import {P2IDVault} from "../P2IDVault.sol";
import {IP2IDPolicy} from "../interfaces/IP2IDPolicy.sol";

/// @dev Test stub: proof = abi.encode(address wallet, bytes32 identityHash, uint64 iat).
///      A constraint is "satisfied" when its signature equals the bytes "ok".
contract MockIdentityVerifier is IP2IDVerifier {
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

/// @dev Test policy with adjustable allowlist, fee rate and distribution, and failure modes.
///      ERC-20 distribution normally pulls pullBps / 10_000 of amount; native distribution uses
///      msg.value. Both split the received amount between operatorOf[verifier] and recipient.
contract MockFeePolicy is IP2IDPolicy {
    mapping(address => bool) public allowed;
    uint16 public bps;
    address public recipient;
    mapping(address verifier => address) public operatorOf;
    uint16 public operatorShareBps;
    uint16 public pullBps = 10_000;
    /// 0 = normal, 1 = feeBps reverts, 2 = feeBps loops until failure, 3 = distributeFee reverts,
    /// 4 = ERC-20 distributeFee attempts to pull amount + 1.
    uint8 public mode;

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

    function setPullBps(uint16 _pullBps) external {
        pullBps = _pullBps;
    }

    function distributeFee(address verifier, address token, uint256 amount) external payable {
        if (mode == 3) revert("distribution down");
        if (token == address(0)) {
            // native: the vault sent it along; split msg.value
            uint256 op = operatorOf[verifier] == address(0) ? 0 : (msg.value * operatorShareBps) / 10_000;
            if (op != 0) _send(operatorOf[verifier], op);
            _send(recipient, msg.value - op);
            return;
        }
        uint256 pull = mode == 4 ? amount + 1 : (amount * pullBps) / 10_000;
        IERC20Min(token).transferFrom(msg.sender, address(this), pull);
        uint256 toOperator = operatorOf[verifier] == address(0) ? 0 : (pull * operatorShareBps) / 10_000;
        if (toOperator != 0) IERC20Min(token).transfer(operatorOf[verifier], toOperator);
        IERC20Min(token).transfer(recipient, pull - toOperator);
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
