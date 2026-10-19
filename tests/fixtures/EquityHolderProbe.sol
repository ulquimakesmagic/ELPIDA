// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Test-only probe used by scripts/equity-fork-check.mjs on a LOCAL fork. It plays the part of a contract
// that holds, pulls and sends a tokenized stock (a curve, a pool, a reward vault). Never deployed to a public chain.
interface IProbeToken {
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}
contract EquityHolderProbe {
    function balance(address token) external view returns (uint256) { return IProbeToken(token).balanceOf(address(this)); }
    function sweep(address token, address to, uint256 amount) external { require(IProbeToken(token).transfer(to, amount), "transfer"); }
    function pull(address token, address from, uint256 amount) external { require(IProbeToken(token).transferFrom(from, address(this), amount), "pull"); }
}
