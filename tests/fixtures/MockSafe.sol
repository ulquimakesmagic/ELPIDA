// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test stand-in for a Safe multisig: the owner list and threshold the mainnet deploy script checks. The rehearsal
/// sends the Safe's batch by impersonating this address on a local chain. Local tests only.
contract MockSafe {
    address[] private owners;
    uint256 public getThreshold;

    constructor(address[] memory owners_, uint256 threshold_) { owners = owners_; getThreshold = threshold_; }

    function getOwners() external view returns (address[] memory) { return owners; }

    receive() external payable {}
}
