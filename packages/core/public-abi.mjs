// The contract interfaces published for builders (Developers docs and /api/v1/abi; Malik, 26 November 2026). Only what
// an outside integration needs: launch, trade, read a launch, and the events to index. Human-readable ABI strings; the
// API serves them as JSON ABIs too. Each line matches the deployed V2.3 contracts (contracts/evm/v2, contracts/evm/v4).
export const PUBLIC_ABIS = Object.freeze({
  factory: [
    'function launch(string name,string symbol,address asset,uint256 feeBps,uint256 firstBuy,uint256 minOut,address reward,string uri,bool inUsdc) payable returns(address token,uint256 bought)',
    'function launchFee() view returns(uint256)',
    'function hook() view returns(address)',
    'function treasury() view returns(address)',
    'function approvedQuotes(address) view returns(uint256)',
    'function tokenMetadataURI(address token) view returns(string)',
    'event MetadataPublished(address indexed token,string uri)',
    'event Launched(address indexed creator,address indexed token,address indexed quote,uint256 feeBps,uint256 firstBuy,uint256 bought)',
  ],
  router: [
    'function buy(address token,uint256 quoteIn,uint256 minTokensOut,address recipient,uint256 deadline) payable returns(uint256 tokensOut)',
    'function sell(address token,uint256 tokensIn,uint256 minQuoteOut,address recipient,uint256 deadline) returns(uint256 quoteOut)',
    'function quote(address token,bool isBuy,uint256 amountIn) returns(uint256 paid,uint256 out)',
    'function hook() view returns(address)',
    'function poolManager() view returns(address)',
    'event Swapped(address indexed token,address indexed trader,address indexed recipient,bool buy,uint256 quoteAmount,uint256 tokenAmount)',
  ],
  hook: [
    'function launchOf(address token) view returns(address quote,address creatorVault,uint64 launchedAt,uint16 feeBps,bool graduated,int24 upperTick,int24 lowerTick,uint128 liquidityBonus,uint128 accrued)',
    'function factory() view returns(address)',
    'event Launched(address indexed token,address indexed quote,address indexed creatorVault,uint256 feeBps,int24 upperTick,int24 lowerTick,uint128 saleLiquidity,uint128 upperLiquidity,uint256 dustBurned)',
    // `trader` here is whoever called the pool: the router for trades through it (its Swapped event names the real trader).
    'event Fee(address indexed token,address indexed trader,bool buy,uint256 feeBps,uint256 fee,uint256 lockedBonus)',
  ],
  token: [
    'function name() view returns(string)',
    'function symbol() view returns(string)',
    'function decimals() view returns(uint8)',
    'function totalSupply() view returns(uint256)',
    'function balanceOf(address) view returns(uint256)',
    'function approve(address,uint256) returns(bool)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ],
});
