// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test stand-in for Ondo's SyntheticSharesOracle: shares per token (18 decimals) and a corporate-action pause.
contract MockSharesOracle {
    mapping(address => uint128) public sValues;
    mapping(address => bool) public pausedFor;
    function set(address asset, uint128 sValue, bool paused) external { sValues[asset] = sValue; pausedFor[asset] = paused; }
    function getSValue(address asset) external view returns (uint128 sValue, bool paused) { return (sValues[asset], pausedFor[asset]); }
}
