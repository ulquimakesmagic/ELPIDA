// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaCurve.sol";
interface IPoolTokenSupply { function totalSupply() external view returns (uint256); }

/// @notice Test prototype: real-reserve constant-product pool with permanently locked principal.
/// @dev NOT AUDITED and not a Uniswap pool. No LP tokens, owner, upgrade, rescue or reserve withdrawal.
/// Trading can reduce either reserve. Only separately accrued fees can be claimed.
contract ElpidaLockedPool {
    IERC20Minimal public immutable quote;
    IERC20Minimal public immutable token;
    address public immutable factory;
    address public immutable protocolTreasury;
    address public immutable creatorRewardVault;
    uint256 public immutable totalSeedTokens;
    uint256 public tokenReserve;
    uint256 public realReserve;
    uint256 public initialQuote;
    uint256 public sold;
    uint256 public protocolFees;
    uint256 public creatorFees;
    uint256 public constant FEE_BPS = 125;
    uint256 public constant BPS = 10000;
    bool public constant liquidityLocked = true;
    bool public initialized;
    bool private firstBuyDone;
    bool private entered;
    event LiquidityLocked(uint256 quoteAmount, uint256 tokenAmount);
    event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    modifier nonReentrant() { require(!entered, "reentrancy"); entered = true; _; entered = false; }

    constructor(address quote_, address token_, address factory_, address treasury_, address reward_, uint256 supply_) {
        require(token_ != address(0) && factory_ != address(0), "zero address");
        require(treasury_ != address(0) && reward_ != address(0) && supply_ > 0, "recipient/supply");
        quote = IERC20Minimal(quote_); token = IERC20Minimal(token_); factory = factory_;
        protocolTreasury = treasury_; creatorRewardVault = reward_; totalSeedTokens = supply_;
    }
    function initialize(uint256 seedQuote) external payable nonReentrant {
        require(msg.sender == factory && !initialized, "factory/initialized");
        require(seedQuote > 0 && _quoteBalance() == seedQuote, "quote seed");
        require(msg.value == (address(quote) == address(0) ? seedQuote : 0), "native value");
        require(token.balanceOf(address(this)) == totalSeedTokens, "token seed");
        initialized = true; initialQuote = seedQuote; realReserve = seedQuote; tokenReserve = totalSeedTokens;
        sold = IPoolTokenSupply(address(token)).totalSupply() - totalSeedTokens;
        emit LiquidityLocked(seedQuote, totalSeedTokens);
    }
    function quoteBuy(uint256 grossIn) public view returns (uint256 out, uint256 fee) {
        require(initialized && grossIn > 0, "initialized/positive buy");
        fee = grossIn * FEE_BPS / BPS;
        uint256 net = grossIn - fee;
        out = tokenReserve * net / (realReserve + net);
        require(out > 0 && out < tokenReserve, "buy dust/reserve");
    }
    function buy(uint256 grossIn, uint256 minOut) external payable nonReentrant returns (uint256) {
        return _buy(msg.sender, msg.sender, grossIn, minOut);
    }
    function initialBuy(address recipient, uint256 grossIn, uint256 minOut) external payable nonReentrant returns (uint256) {
        require(msg.sender == factory && !firstBuyDone, "factory/first buy");
        firstBuyDone = true;
        return _buy(factory, recipient, grossIn, minOut);
    }
    function _buy(address payer, address recipient, uint256 grossIn, uint256 minOut) private returns (uint256 out) {
        uint256 fee;
        (out, fee) = quoteBuy(grossIn);
        require(out >= minOut, "slippage");
        if (address(quote) == address(0)) require(msg.value == grossIn, "native value");
        else {
            require(msg.value == 0, "native value");
            uint256 beforeBalance = quote.balanceOf(address(this));
            require(quote.transferFrom(payer, address(this), grossIn), "quote transfer");
            require(quote.balanceOf(address(this)) - beforeBalance == grossIn, "unsupported quote");
        }
        realReserve += grossIn - fee; tokenReserve -= out; sold += out;
        protocolFees += fee / 2; creatorFees += fee - fee / 2;
        require(token.transfer(recipient, out), "token transfer");
        emit Bought(payer, recipient, grossIn, out);
    }
    function quoteSell(uint256 input) public view returns (uint256 netOut, uint256 fee) {
        require(initialized && input > 0 && input <= sold, "invalid sell");
        uint256 grossOut = realReserve * input / (tokenReserve + input);
        fee = grossOut * FEE_BPS / BPS; netOut = grossOut - fee;
        require(netOut > 0 && grossOut < realReserve, "sell dust/reserve");
    }
    function sell(uint256 input, uint256 minOut) external nonReentrant returns (uint256 out) {
        uint256 fee;
        (out, fee) = quoteSell(input);
        require(out >= minOut, "slippage");
        require(token.transferFrom(msg.sender, address(this), input), "token transfer");
        tokenReserve += input; sold -= input; realReserve -= out + fee;
        protocolFees += fee / 2; creatorFees += fee - fee / 2;
        _pay(msg.sender, out);
        emit Sold(msg.sender, input, out);
    }
    function withdrawFees() external nonReentrant {
        uint256 p = protocolFees; uint256 c = creatorFees;
        protocolFees = 0; creatorFees = 0;
        if (p > 0) { _pay(protocolTreasury, p); emit FeesWithdrawn(protocolTreasury, p); }
        if (c > 0) { _pay(creatorRewardVault, c); emit FeesWithdrawn(creatorRewardVault, c); }
    }
    function _quoteBalance() private view returns (uint256) { return address(quote) == address(0) ? address(this).balance : quote.balanceOf(address(this)); }
    function _pay(address recipient, uint256 value) private {
        if (address(quote) == address(0)) { (bool ok,) = recipient.call{value: value}(""); require(ok, "native payout"); }
        else require(quote.transfer(recipient, value), "quote payout");
    }
}
