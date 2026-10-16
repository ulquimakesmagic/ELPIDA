// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaLockedPool.sol";

/// @notice Native/USDC virtual curve and graduation into a custom test pool. NOT AUDITED.
/// @dev Zero address quote means native currency. Production must use a reviewed DEX adapter.
contract ElpidaLaunchCurve {
    IERC20Minimal public immutable quote;
    IERC20Minimal public immutable token;
    address public immutable factory;
    address public immutable protocolTreasury;
    address public immutable creatorRewardVault;
    uint256 public immutable virtualQuote;
    uint256 public constant virtualToken = 1_000_000_000 ether;
    uint256 public constant SALE_CAP = 800_000_000 ether;
    uint256 public constant FEE_BPS = 125;
    uint256 public sold;
    uint256 public realReserve;
    uint256 public protocolFees;
    uint256 public creatorFees;
    bool public complete;
    address public pool;
    bool private entered;
    bool private firstBuyDone;
    event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event FeePayoutFailed(address indexed recipient, uint256 amount);
    event CurveCompleted(uint256 realQuote);
    event Graduated(address indexed pool, uint256 quoteLiquidity, uint256 tokenLiquidity, uint256 burned);
    modifier nonReentrant() { require(!entered, "reentrancy"); entered = true; _; entered = false; }
    constructor(address quote_, address token_, address factory_, address treasury_, address reward_, uint256 virtualQuote_) {
        require(token_ != address(0) && factory_ != address(0) && treasury_ != address(0) && reward_ != address(0), "zero address");
        require(virtualQuote_ > 0, "virtual quote");
        quote = IERC20Minimal(quote_); token = IERC20Minimal(token_); factory = factory_;
        protocolTreasury = treasury_; creatorRewardVault = reward_; virtualQuote = virtualQuote_;
    }
    function completionQuote() public view returns (uint256 gross) {
        require(!complete, "curve complete");
        uint256 remaining = SALE_CAP - sold;
        uint256 denominator = virtualToken - SALE_CAP;
        uint256 net = ((virtualQuote + realReserve) * remaining + denominator - 1) / denominator;
        gross = (net - 1) * 10000 / (10000 - FEE_BPS) + 1;
    }
    function quoteBuy(uint256 gross) public view returns (uint256 out, uint256 fee) {
        require(!complete && gross > 0, "complete/positive buy");
        require(gross <= completionQuote(), "exceeds curve remaining");
        fee = gross * FEE_BPS / 10000;
        uint256 net = gross - fee;
        out = (virtualToken - sold) * net / (virtualQuote + realReserve + net);
        if (out > SALE_CAP - sold) out = SALE_CAP - sold;
        require(out > 0, "buy dust");
    }
    function buy(uint256 gross, uint256 minOut) external payable nonReentrant returns (uint256) { return _buy(msg.sender, msg.sender, gross, minOut); }
    function initialBuy(address recipient, uint256 gross, uint256 minOut) external payable nonReentrant returns (uint256) {
        require(msg.sender == factory && !firstBuyDone, "factory/first buy"); firstBuyDone = true;
        return _buy(factory, recipient, gross, minOut);
    }
    function _buy(address payer, address recipient, uint256 gross, uint256 minOut) private returns (uint256 out) {
        uint256 fee; (out,fee) = quoteBuy(gross); require(out >= minOut, "slippage");
        if (address(quote) == address(0)) require(msg.value == gross, "native value");
        else {
            require(msg.value == 0, "native value"); uint256 balance = quote.balanceOf(address(this));
            require(quote.transferFrom(payer,address(this),gross), "quote transfer");
            require(quote.balanceOf(address(this)) - balance == gross, "unsupported quote");
        }
        realReserve += gross - fee; sold += out; protocolFees += fee / 2; creatorFees += fee - fee / 2;
        require(token.transfer(recipient,out), "token transfer"); emit Bought(payer,recipient,gross,out);
        if (sold == SALE_CAP) { complete = true; emit CurveCompleted(realReserve); }
    }
    function quoteSell(uint256 input) public view returns (uint256 out,uint256 fee) {
        require(!complete && input > 0 && input <= sold, "complete/invalid sell");
        uint256 gross = (virtualQuote + realReserve) * input / (virtualToken - sold + input);
        require(gross <= realReserve, "insufficient real reserve");
        fee = gross * FEE_BPS / 10000; out = gross - fee; require(out > 0, "sell dust");
    }
    function sell(uint256 input,uint256 minOut) external nonReentrant returns (uint256 out) {
        uint256 fee; (out,fee) = quoteSell(input); require(out >= minOut, "slippage");
        require(token.transferFrom(msg.sender,address(this),input), "token transfer");
        sold -= input; realReserve -= out + fee; protocolFees += fee / 2; creatorFees += fee - fee / 2;
        _pay(msg.sender,out); emit Sold(msg.sender,input,out);
    }
    /// Failure-isolated payouts: a recipient that cannot receive keeps its balance owed and never blocks the other.
    function withdrawFees() external nonReentrant {
        uint256 p = protocolFees; uint256 c = creatorFees; protocolFees = 0; creatorFees = 0;
        protocolFees = _tryPayout(protocolTreasury, p); creatorFees = _tryPayout(creatorRewardVault, c);
    }
    function _tryPayout(address to, uint256 amount) private returns (uint256 owed) {
        if (amount == 0) return 0;
        bool ok; bytes memory data;
        if (address(quote) == address(0)) (ok,) = to.call{value: amount}("");
        else { (ok, data) = address(quote).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)); ok = ok && (data.length == 0 || abi.decode(data, (bool))); }
        if (ok) { emit FeesWithdrawn(to, amount); return 0; }
        emit FeePayoutFailed(to, amount); return amount;
    }
    function graduate() external nonReentrant returns (address) {
        require(complete && pool == address(0), "not complete/already migrated");
        uint256 q = realReserve;
        // Match the curve's terminal marginal price using REAL funds, not its virtual quote offset.
        uint256 lpTokens = q * (virtualToken - sold) / (virtualQuote + q);
        uint256 remaining = virtualToken - SALE_CAP;
        require(lpTokens > 0 && lpTokens <= remaining, "migration allocation");
        ElpidaLockedPool target = new ElpidaLockedPool(address(quote),address(token),address(this),protocolTreasury,creatorRewardVault,lpTokens);
        pool = address(target); realReserve = 0;
        require(token.transfer(pool,lpTokens), "pool tokens");
        uint256 burned = remaining - lpTokens;
        if (burned > 0) require(token.transfer(address(0xdead),burned), "burn transfer");
        if (address(quote) == address(0)) target.initialize{value:q}(q);
        else { require(quote.transfer(pool,q), "pool quote"); target.initialize(q); }
        emit Graduated(pool,q,lpTokens,burned); return pool;
    }
    function _pay(address recipient,uint256 value) private {
        if (address(quote) == address(0)) { (bool ok,) = recipient.call{value:value}(""); require(ok, "native payout"); }
        else require(quote.transfer(recipient,value), "quote payout");
    }
}
