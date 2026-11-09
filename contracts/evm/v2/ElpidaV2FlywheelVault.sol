// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFlywheelFactory {
    function isElpidaToken(address) external view returns (bool);
    function hook() external view returns (address);
}

interface IFlywheelHook {
    function launchOf(address token) external view returns (address quote, address creatorVault, uint64 launchedAt, uint16 feeBps, bool graduated, int24 upperTick, int24 lowerTick, uint128 liquidityBonus, uint128 accrued);
}

interface IFlywheelRouter {
    function hook() external view returns (address);
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) external payable returns (uint256 tokensOut);
}

interface IFlywheelToken {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function burn(uint256) external;
}

/// @notice ELPIDA V2.0 flywheel vault (NOT AUDITED; local chains and test networks only). The V2 hook pays 10% of
/// every fee straight here, in each pool's quote asset; the treasury never holds it. Its funds can do one thing: buy
/// a V2 token through the Elpida router and burn it (`burn()`, so the supply falls). The keeper chooses the tokens
/// each cycle (top 10 by net buy volume from wallets not linked to the creator, decision C9) and the minimum out from
/// a time-weighted price; this contract limits what a wrong or compromised keeper could do: V2 tokens at least a day
/// old only, at most 10% of the asset's balance per order, one order per token per six hours, and no way to send
/// funds anywhere else.
contract ElpidaV2FlywheelVault {
    uint256 public constant VERSION = 1;
    uint256 public constant MAX_ORDER_BPS = 1000;
    uint256 public constant TOKEN_COOLDOWN = 6 hours;
    uint256 public constant MIN_TOKEN_AGE = 1 days;
    address public immutable operator;
    /// Whoever deployed the vault may also set the router once (the operator is usually a server keeper).
    address public immutable deployer;
    IFlywheelFactory public immutable factory;
    /// Set once, after the hook and router exist (the hook needs this vault's address first).
    IFlywheelRouter public router;
    address public hook;
    mapping(address token => uint64) public lastBuy;
    mapping(address token => uint256) public burnedOf;
    mapping(address asset => uint256) public spentOf;
    bool private entered;

    event BoughtAndBurned(address indexed token, address indexed asset, uint256 indexed cycle, uint256 spent, uint256 burned, uint256 supplyAfter);
    event Received(address indexed from, uint256 amount);

    error OnlyOperator();
    error NotEligible();
    error TooSoon();
    error OrderTooLarge();
    error BadTerms();
    error Reentrancy();

    event RouterSet(address indexed router, address indexed hook);

    constructor(address operator_, IFlywheelFactory factory_) {
        if (operator_ == address(0) || address(factory_) == address(0)) revert BadTerms();
        operator = operator_; factory = factory_; deployer = msg.sender;
    }

    /// Once: the Elpida router of this launchpad's hook.
    function setRouter(IFlywheelRouter router_) external {
        if (msg.sender != operator && msg.sender != deployer) revert OnlyOperator();
        address h = factory.hook();
        if (address(router) != address(0) || h == address(0) || router_.hook() != h) revert BadTerms();
        router = router_; hook = h;
        emit RouterSet(address(router_), h);
    }

    receive() external payable { emit Received(msg.sender, msg.value); }

    /// Buys `token` with `amountIn` of its quote asset and burns everything bought. Operator only.
    function buyAndBurn(address token, uint256 amountIn, uint256 minTokensOut, uint256 cycle) external returns (uint256 burned) {
        if (msg.sender != operator) revert OnlyOperator();
        if (entered) revert Reentrancy();
        entered = true;
        if (address(router) == address(0) || !factory.isElpidaToken(token)) revert NotEligible();
        (address quote,, uint64 launchedAt,,,,,,) = IFlywheelHook(hook).launchOf(token);
        if (launchedAt == 0 || block.timestamp < launchedAt + MIN_TOKEN_AGE) revert NotEligible();
        if (block.timestamp < uint256(lastBuy[token]) + TOKEN_COOLDOWN) revert TooSoon();
        uint256 balance = quote == address(0) ? address(this).balance : IFlywheelToken(quote).balanceOf(address(this));
        if (amountIn == 0 || amountIn > balance * MAX_ORDER_BPS / 10000) revert OrderTooLarge();
        lastBuy[token] = uint64(block.timestamp);
        uint256 before = balance;
        if (quote == address(0)) burned = router.buy{value: amountIn}(token, amountIn, minTokensOut, address(this), block.timestamp);
        else {
            if (!IFlywheelToken(quote).approve(address(router), amountIn)) revert BadTerms();
            burned = router.buy(token, amountIn, minTokensOut, address(this), block.timestamp);
            IFlywheelToken(quote).approve(address(router), 0);
        }
        uint256 spent = before - (quote == address(0) ? address(this).balance : IFlywheelToken(quote).balanceOf(address(this)));
        IFlywheelToken(token).burn(burned);
        burnedOf[token] += burned; spentOf[quote] += spent;
        emit BoughtAndBurned(token, quote, cycle, spent, burned, IFlywheelToken(token).totalSupply());
        entered = false;
    }
}
