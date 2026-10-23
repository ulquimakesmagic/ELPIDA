// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// Test stand-in for a Safe: the same getOwners/getThreshold reads, and an owner-only `exec` in place of
/// multi-signature execution. Receives native coin like a Safe.
contract MockSafe {
    address[] private owners_; uint256 private threshold_;
    constructor(address[] memory o, uint256 t) { owners_ = o; threshold_ = t; }
    function getOwners() external view returns (address[] memory) { return owners_; }
    function getThreshold() external view returns (uint256) { return threshold_; }
    function exec(address to, uint256 value, bytes calldata data) external returns (bytes memory) {
        bool owner; for (uint256 i = 0; i < owners_.length; i++) if (owners_[i] == msg.sender) owner = true;
        require(owner, "not an owner");
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        return ret;
    }
    receive() external payable {}
}
