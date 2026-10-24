// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 interface shared by the Elpida contracts. Kept on its own so the mainnet launchpad
/// (ElpidaAtomicDexFactory and what it deploys) does not import the older curve and locked-pool prototypes.
interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
