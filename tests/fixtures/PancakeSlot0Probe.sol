// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../contracts/evm/src/ElpidaV3MigrationAdapter.sol";

// Test-only. A pool that answers slot0() with PancakeSwap v3's exact types: the sixth field, feeProtocol, is uint32 and
// holds two packed 16-bit protocol fees, so real values are far above 255 (Uniswap v3 declares it uint8).
contract MockPancakeSlot0Pool {
    uint32 public feeProtocol;
    constructor(uint32 feeProtocol_) { feeProtocol = feeProtocol_; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool) {
        return (uint160(1) << 96, int24(0), uint16(0), uint16(1), uint16(1), feeProtocol, true);
    }
}

/// The interface the adapter used before 21 Oct 2026 (Uniswap-only layout).
interface IUniswapOnlySlot0 { function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool); }

contract Slot0Probe {
    /// Reads through the adapter's own pool interface.
    function readWithAdapterInterface(address pool) external view returns (uint160 price) { (price,,,,,,) = IV3MigrationPool(pool).slot0(); }
    /// Reads through the old Uniswap-only declaration.
    function readWithUniswapOnlyInterface(address pool) external view returns (uint160 price) { (price,,,,,,) = IUniswapOnlySlot0(pool).slot0(); }
}
