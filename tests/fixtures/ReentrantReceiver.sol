// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// @notice Test-only payout recipient that calls back into the curve from inside its own native payout.
/// @dev `arm` sets one call to attempt on receipt; the attempt is recorded instead of bubbling, so the test can
/// show that the outer payout completed while the inner call was refused. Never deploy with real funds.
contract ReentrantReceiver {
    address public curve;
    bytes public payload;
    bool public attempted;
    bool public innerSucceeded;
    bytes public lastRevert;
    uint256 public received;

    function arm(address curve_, bytes calldata payload_) external {
        curve = curve_;
        payload = payload_;
    }

    /// Lets the test drive this contract (approve the curve, sell tokens) without extra helpers.
    function execute(address target, bytes calldata data, uint256 value) external returns (bool ok, bytes memory returned) {
        (ok, returned) = target.call{value: value}(data);
    }

    receive() external payable {
        received += msg.value;
        address target = curve;
        if (target == address(0)) return;
        curve = address(0); // one attempt, no recursion
        attempted = true;
        (bool ok, bytes memory returned) = target.call(payload);
        innerSucceeded = ok;
        lastRevert = returned;
    }
}
