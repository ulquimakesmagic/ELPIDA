// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Experimental USDC-quoted virtual-reserve curve. NOT AUDITED.
/// @dev Quote-token agnostic math; the factory scales virtual reserves to the quote decimals. No graduation, custom pair or holder distributions yet.
contract ElpidaCurve {
    IERC20Minimal public immutable quote;
    IERC20Minimal public immutable token;
    address public immutable factory;
    address public immutable protocolTreasury;
    address public immutable creatorRewardVault;
    uint256 public immutable virtualQuote;
    uint256 public immutable virtualToken;
    uint256 public sold;
    uint256 public realReserve;
    uint256 public protocolFees;
    uint256 public creatorFees;
    uint256 public constant FEE_BPS = 125;
    uint256 public constant BPS = 10000;
    bool private entered;

    event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut);
    event FeesWithdrawn(address indexed recipient, uint256 amount);

    modifier nonReentrant() { require(!entered, "reentrancy"); entered = true; _; entered = false; }

    constructor(address quote_, address token_, address factory_, address treasury_, address rewardVault_, uint256 vQuote_, uint256 vToken_) {
        require(quote_ != address(0) && token_ != address(0) && factory_ != address(0), "zero address");
        require(treasury_ != address(0) && rewardVault_ != address(0), "zero recipient");
        require(vQuote_ > 0 && vToken_ > 0, "virtual reserves");
        quote = IERC20Minimal(quote_); token = IERC20Minimal(token_); factory = factory_;
        protocolTreasury = treasury_; creatorRewardVault = rewardVault_;
        virtualQuote = vQuote_; virtualToken = vToken_;
    }

    function quoteBuy(uint256 grossIn) public view returns (uint256 out, uint256 fee) {
        fee = grossIn * FEE_BPS / BPS;
        uint256 net = grossIn - fee;
        // Constant-product virtual reserve curve, sold token balance reduces virtual supply.
        uint256 availableVirtual = virtualToken - sold;
        out = availableVirtual * net / (virtualQuote + realReserve + net);
        require(out > 0 && out <= token.balanceOf(address(this)), "buy too small/large");
    }

    function buy(uint256 grossIn, uint256 minTokensOut) external nonReentrant returns (uint256 out) {
        out = _buy(msg.sender, msg.sender, grossIn, minTokensOut);
    }

    /// @notice Called by factory for atomic mandatory developer first buy.
    function initialBuy(address creator, uint256 grossIn, uint256 minTokensOut) external nonReentrant returns (uint256 out) {
        require(msg.sender == factory && sold == 0, "factory/initialized");
        out = _buy(factory, creator, grossIn, minTokensOut);
    }

    function _buy(address payer, address recipient, uint256 grossIn, uint256 minOut) internal returns (uint256 out) {
        require(grossIn > 0, "positive buy required");
        uint256 fee;
        (out, fee) = quoteBuy(grossIn);
        require(out >= minOut, "slippage");
        require(quote.transferFrom(payer, address(this), grossIn), "quote transfer");
        uint256 net = grossIn - fee;
        realReserve += net;
        protocolFees += fee / 2;
        creatorFees += fee - fee / 2;
        sold += out;
        require(token.transfer(recipient, out), "token transfer");
        emit Bought(payer, recipient, grossIn, out);
    }

    function quoteSell(uint256 tokenIn) public view returns (uint256 netOut, uint256 fee) {
        require(tokenIn > 0 && tokenIn <= sold, "invalid sell");
        // Exact reverse of the buy invariant for virtual quote + real reserve.
        uint256 grossOut = (virtualQuote + realReserve) * tokenIn / (virtualToken - sold + tokenIn);
        fee = grossOut * FEE_BPS / BPS;
        netOut = grossOut - fee;
        require(grossOut <= realReserve, "insufficient real reserve");
    }

    function sell(uint256 tokenIn, uint256 minQuoteOut) external nonReentrant returns (uint256 netOut) {
        uint256 fee;
        (netOut, fee) = quoteSell(tokenIn);
        require(netOut > 0 && netOut >= minQuoteOut, "slippage/dust");
        uint256 grossOut = netOut + fee;
        require(token.transferFrom(msg.sender, address(this), tokenIn), "token transfer");
        sold -= tokenIn;
        realReserve -= grossOut;
        protocolFees += fee / 2;
        creatorFees += fee - fee / 2;
        require(quote.transfer(msg.sender, netOut), "quote transfer");
        emit Sold(msg.sender, tokenIn, netOut);
    }

    function withdrawFees() external nonReentrant {
        uint256 p = protocolFees;
        uint256 c = creatorFees;
        protocolFees = 0; creatorFees = 0;
        if (p > 0) { require(quote.transfer(protocolTreasury, p), "protocol payout"); emit FeesWithdrawn(protocolTreasury, p); }
        if (c > 0) { require(quote.transfer(creatorRewardVault, c), "creator payout"); emit FeesWithdrawn(creatorRewardVault, c); }
    }
}
