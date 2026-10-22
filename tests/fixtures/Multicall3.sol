// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// Test stand-in with Multicall3's aggregate3 interface and semantics (placed at the canonical address in tests).
contract Multicall3 {
    struct Call3 { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(ok || calls[i].allowFailure, "Multicall3: call failed");
            returnData[i] = Result(ok, ret);
        }
    }
}
