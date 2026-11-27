// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockElysiumInbox {
    event Retryable(address publisher, address receiver, uint256 callValue, uint256 submissionCost,
        address excessFeeRefund, address callValueRefund, uint256 gasLimit, uint256 maxFeePerGas, bytes data, uint256 paid);

    function createRetryableTicket(address receiver, uint256 callValue, uint256 submissionCost,
        address excessFeeRefund, address callValueRefund, uint256 gasLimit, uint256 maxFeePerGas, bytes calldata data)
        external payable returns (uint256)
    {
        emit Retryable(msg.sender, receiver, callValue, submissionCost, excessFeeRefund, callValueRefund, gasLimit,
            maxFeePerGas, data, msg.value);
        return 1;
    }
}
