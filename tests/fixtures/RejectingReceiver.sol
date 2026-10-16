// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Test-only reward recipient that refuses native transfers.
contract RejectingReceiver {
    receive() external payable { revert("rejecting receiver"); }
}
