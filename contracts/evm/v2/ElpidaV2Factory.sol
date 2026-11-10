// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../src/ElpidaUsdPricing.sol";
import {ElpidaV2Token} from "./ElpidaV2Token.sol";
import {ElpidaV2Hook} from "./ElpidaV2Hook.sol";

interface IV2Quote {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice ELPIDA V2.0 launchpad (NOT AUDITED; local chains and test networks only): creates a V2 token and its
/// locked-from-launch Uniswap v4 pool in one transaction. Terms (spec §§4–11, decisions of 8 November 2026):
///  - $10 launch fee, in the native coin at the Chainlink price or as 10 USDC (decision C7);
///  - starting market cap $20,000 on mainnet ($50 on test-sized test networks), graduation at ×5;
///  - the creator picks the token's fee, from the hook's minimum to 4.00% (1.25% default); it never changes;
///  - an optional first buy of at most 3% of the supply, enforced by the hook on the tokens received;
///  - tickers of 1–10 ASCII letters or digits, not exclusive (no registry, no surcharge);
///  - no partner tiers (decision C4).
contract ElpidaV2Factory is ElpidaUsdPricing {
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 20;
    uint256 public constant METADATA_VERSION = 1;
    uint256 public constant DEFAULT_FEE_BPS = 125;
    uint256 public constant MAINNET_START_MCAP_USD = 20_000;
    uint256 public constant TESTNET_START_MCAP_USD = 50;
    address public immutable treasury;
    /// Starting market cap in whole US dollars: 20,000, or 50 on a test-sized test network deployment.
    uint256 public immutable startMcapUsd;
    bool private immutable metadataRequired;
    ElpidaV2Hook public hook;
    mapping(address => bool) public isElpidaToken;
    mapping(address => string) public tokenMetadataURI;
    /// Virtual quote (raw units) for each team-approved ERC-20 quote; 0 means not approved. Set once per asset.
    mapping(address => uint256) public approvedQuotes;
    uint256 public launches;
    /// Stocks priced at launch (Malik, 10 November): a quote approved with a USD price feed (e.g. Chainlink's Ondo GM
    /// feed) instead of a fixed amount, so every launch starts at the same dollar market cap whatever the stock did since.
    uint256 public constant STOCK_FEEDS_VERSION = 1;
    /// Longest a stock feed's answer may be when it prices a launch: a weekend and a market holiday.
    uint256 public constant MAX_STOCK_FEED_AGE = 4 days;
    struct QuoteFeed { address feed; uint64 maxAge; uint8 feedDecimals; uint8 assetDecimals; }
    mapping(address => QuoteFeed) public quoteFeeds;
    bool private entered;

    event HookSet(address indexed hook);
    event QuoteApproved(address indexed asset, uint256 virtualQuote);
    event FeedQuoteApproved(address indexed asset, address indexed feed, uint256 maxAge);
    event MetadataPublished(address indexed token, string uri);
    event Launched(address indexed creator, address indexed token, address indexed quote, uint256 feeBps, uint256 firstBuy, uint256 bought);

    constructor(address treasury_, uint256 startMcapUsd_, bool requireMetadata_) {
        require(treasury_ != address(0), "zero address");
        require(startMcapUsd_ == MAINNET_START_MCAP_USD || startMcapUsd_ == TESTNET_START_MCAP_USD, "start market cap");
        treasury = treasury_; startMcapUsd = startMcapUsd_; metadataRequired = requireMetadata_;
    }

    function pricingOwner() internal view override returns (address) { return treasury; }
    function requiresMetadata() public view returns (bool) { return metadataRequired; }
    function testSized() external view returns (bool) { return startMcapUsd == TESTNET_START_MCAP_USD; }

    /// Native virtual reserve for a new launch: the starting market cap times 5/4, at the current oracle price.
    function nativeVirtualQuote() public view override returns (uint256) {
        return Math.mulDiv(nativeUsdAmount(startMcapUsd), 5, 4, Math.Rounding.Ceil);
    }

    /// Once: the hook is deployed separately at an address whose low bits carry its permissions.
    function setHook(address hook_) external {
        require(msg.sender == treasury && address(hook) == address(0), "owner only/set");
        require(ElpidaV2Hook(hook_).factory() == address(this) && ElpidaV2Hook(hook_).protocolTreasury() == treasury, "hook");
        hook = ElpidaV2Hook(hook_); emit HookSet(hook_);
    }

    /// Team-approved, immutable ERC-20 quote (USDC, an Ondo stock): its virtual quote in raw units, i.e. the starting
    /// market cap × 5/4 in that asset.
    function approveQuote(address asset, uint256 virtualQuote_) external {
        require(msg.sender == treasury && asset.code.length > 0 && virtualQuote_ > 0 && approvedQuotes[asset] == 0 && quoteFeeds[asset].feed == address(0), "quote approval");
        uint8 d = IV2Quote(asset).decimals(); require(d >= 6 && d <= 18, "quote decimals");
        approvedQuotes[asset] = virtualQuote_; emit QuoteApproved(asset, virtualQuote_);
    }

    /// Team-approved, immutable ERC-20 quote priced at each launch by `feed` (USD per whole token, at most `maxAge` old):
    /// the virtual quote is the starting market cap × 5/4 in that asset at the feed's price. Once per asset, never both kinds.
    function approvePricedQuote(address asset, address feed, uint256 maxAge) external {
        require(msg.sender == treasury && asset.code.length > 0 && feed.code.length > 0 && approvedQuotes[asset] == 0 && quoteFeeds[asset].feed == address(0), "quote approval");
        require(maxAge > 0 && maxAge <= MAX_STOCK_FEED_AGE, "feed age");
        uint8 d = IV2Quote(asset).decimals(); require(d >= 6 && d <= 18, "quote decimals");
        uint8 fd = IUsdFeed(feed).decimals(); require(fd <= 18, "feed decimals");
        quoteFeeds[asset] = QuoteFeed(feed, uint64(maxAge), fd, d);
        quoteVirtual(asset);
        emit FeedQuoteApproved(asset, feed, maxAge);
    }

    /// The virtual quote a launch paired with `asset` would get now (raw units); 0 if the asset is not approved. A
    /// feed-priced asset reverts while its feed's answer is invalid or older than its limit, so no launch uses it.
    function quoteVirtual(address asset) public view returns (uint256) {
        if (asset == address(0)) return nativeVirtualQuote();
        QuoteFeed memory q = quoteFeeds[asset];
        if (q.feed == address(0)) return approvedQuotes[asset];
        (uint80 round, int256 value,, uint256 timestamp, uint80 answered) = IUsdFeed(q.feed).latestRoundData();
        require(value > 0 && round > 0 && answered >= round && timestamp > 0 && timestamp <= block.timestamp, "stock price");
        require(block.timestamp - timestamp <= q.maxAge, "stock price stale");
        return Math.mulDiv(startMcapUsd * 5 * 10 ** q.assetDecimals, 10 ** q.feedDecimals, 4 * uint256(value), Math.Rounding.Ceil);
    }

    /// Launches a token. `asset`: 0 for the native coin or an approved quote. `feeBps`: the token's fee for good, from
    /// hook.minFeeBps() to 400. `firstBuy`: in the quote (native: part of msg.value; ERC-20: pulled from the caller).
    /// `uri`: the token details (ipfs://, required where requiresMetadata()). `inUsdc`: pay the fee as 10 USDC.
    /// msg.value = the native launch fee (unless inUsdc) + the native first buy; any excess is refunded.
    function launch(string calldata name_, string calldata symbol_, address asset, uint256 feeBps, uint256 firstBuy, uint256 minOut, address reward, string calldata uri, bool inUsdc) external payable returns (address token, uint256 bought) {
        require(!entered, "reentrancy"); entered = true;
        require(address(hook) != address(0) && reward != address(0), "hook/reward");
        _checkName(name_); _checkSymbol(symbol_);
        if (bytes(uri).length > 0) _checkUri(uri); else require(!metadataRequired, "metadata required");
        uint256 vq = quoteVirtual(asset);
        require(vq > 0, "quote not approved");
        _chargeLaunchFee(asset == address(0) ? firstBuy : 0, inUsdc);
        token = _deployToken(name_, symbol_, asset);
        if (asset != address(0) && firstBuy > 0) {
            uint256 before = IV2Quote(asset).balanceOf(address(hook));
            require(IV2Quote(asset).transferFrom(msg.sender, address(hook), firstBuy), "first buy");
            require(IV2Quote(asset).balanceOf(address(hook)) - before == firstBuy, "unsupported quote");
        }
        bought = hook.launch{value: asset == address(0) ? firstBuy : 0}(token, asset, reward, msg.sender, vq, feeBps, firstBuy, minOut);
        isElpidaToken[token] = true;
        if (bytes(uri).length > 0) { tokenMetadataURI[token] = uri; emit MetadataPublished(token, uri); }
        emit Launched(msg.sender, token, asset, feeBps, firstBuy, bought);
        entered = false;
    }

    /// CREATE2 with the first salt that puts the token's address above the quote's, so the quote is always the pool's
    /// currency0 (for the native coin, address 0, any salt does). Expected tries: one or two.
    function _deployToken(string calldata name_, string calldata symbol_, address quote) private returns (address token) {
        bytes memory init = abi.encodePacked(type(ElpidaV2Token).creationCode, abi.encode(name_, symbol_, TOKEN_SUPPLY, address(hook)));
        bytes32 codeHash = keccak256(init);
        uint256 n = launches++;
        for (uint256 i = 0; i < 256; i++) {
            bytes32 salt = keccak256(abi.encode(msg.sender, n, i));
            address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
            if (uint160(predicted) <= uint160(quote) || predicted.code.length > 0) continue;
            assembly ("memory-safe") { token := create2(0, add(init, 0x20), mload(init), salt) }
            require(token == predicted, "token deploy");
            return token;
        }
        revert("token address");
    }

    function _checkName(string calldata name_) private pure {
        uint256 n = bytes(name_).length; require(n >= 1 && n <= 64, "name length");
    }

    /// Spec §6.2: ^[A-Za-z0-9]{1,10}$. Stored as typed; duplicates are allowed.
    function _checkSymbol(string calldata symbol_) private pure {
        bytes calldata s = bytes(symbol_);
        require(s.length >= 1 && s.length <= 10, "ticker");
        for (uint256 i = 0; i < s.length; i++) {
            bytes1 c = s[i];
            require((c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z"), "ticker");
        }
    }

    function _checkUri(string memory uri) private pure {
        bytes memory value = bytes(uri); require(value.length >= 16 && value.length <= 128, "metadata URI length");
        require(value[0] == 'i' && value[1] == 'p' && value[2] == 'f' && value[3] == 's' && value[4] == ':' && value[5] == '/' && value[6] == '/', "IPFS URI required");
    }
}
