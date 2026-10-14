# Mobile layout verification — 14 October 2026

## Changes

- Phone chain menus anchor to the selector's left edge and stay within the screen. They scroll inside the available dynamic viewport height.
- Background account/price refresh preserves the open chain menu and its focused option when the network list is unchanged.
- Grid tracks for token cards, reward cards, trading-pair choices and treasury groups can shrink to the actual available width.
- Connected navigation accommodates all five menu entries. Safe-area padding keeps navigation, messages and footer controls clear of device insets.
- Phone form controls use 16px text to avoid focus zoom in mobile browsers. Wallet dialogs use dynamic viewport bounds, wrapping buttons and smaller padding.
- Reward fee rows stack their claim action and wrap long token names. Analytics controls and metrics wrap within their column widths.

## Verification

Desktop Chrome with responsive viewport overrides was used for 320px, 360px, 390px, 430px and 768px widths. Explore, token terminal, Analytics, launch details/pair/rewards/purchase/review steps, wallet dialog and chain menu were checked. Portfolio and Rewards were checked with a connected wallet; the local preview also exercised wallet-read-unavailable states. No transactions or public theses were submitted.

The original 320px phone chain menu began off-screen at x=-90.9px. After the fix it spans x=16px to x=304px. Phone navigation has five equal-width entries when connected. Document width stays within the viewport; data tables and token statistics retain intentional scrolling inside their own containers.

This is responsive desktop-browser verification, not a physical iPhone/Android wallet or soft-keyboard test. Those device checks remain part of public beta acceptance. This change does not change contracts or approve a mainnet release.
