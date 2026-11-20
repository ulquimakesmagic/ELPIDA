// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test stand-in for Pyth Core: a stored price per feed id, set by the test.
contract MockPyth {
    struct Price { int64 price; uint64 conf; int32 expo; uint256 publishTime; }
    mapping(bytes32 => Price) internal prices;
    error PriceFeedNotFound();
    function set(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external { prices[id] = Price(price, conf, expo, publishTime); }
    function getPriceUnsafe(bytes32 id) external view returns (Price memory p) { p = prices[id]; if (p.publishTime == 0) revert PriceFeedNotFound(); }
    function getUpdateFee(bytes[] calldata data) external pure returns (uint256) { return data.length; }
    /// Each update is abi.encode(id, price, conf, expo, publishTime); a newer publish time replaces the stored one.
    function updatePriceFeeds(bytes[] calldata data) external payable {
        require(msg.value >= data.length, "fee");
        for (uint256 i; i < data.length; i++) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint256 t) = abi.decode(data[i], (bytes32, int64, uint64, int32, uint256));
            if (t > prices[id].publishTime) prices[id] = Price(price, conf, expo, t);
        }
    }
}
