// Elpida Terms of Use: the text the entry dialog asks every visitor to accept, also shown at #/terms.
//
// A draft written for Elpida, to be reviewed by counsel before mainnet (docs/TERMS_AND_RISK_DRAFT.md). Places the
// operator has not decided yet (the operating entity, governing law, the dispute forum) say so plainly instead of
// naming something invented. Raise TERMS_VERSION and TERMS_UPDATED when the meaning changes: every visitor is asked to
// accept again. The restricted places come from ELPIDA_RESTRICTED_JURISDICTIONS via /api/config.
import { h } from './ui.mjs';

export const TERMS_VERSION = 2;
export const TERMS_UPDATED = '13 November 2026';
export const CONTACT = { x: '@elpidadotfun', xUrl: 'https://x.com/elpidadotfun', telegram: 't.me/elpidadotfun', telegramUrl: 'https://t.me/elpidadotfun' };

const list = names => names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;

/**
 * The Terms as data: `notice` paragraphs (shown in capitals at the top) and numbered `sections`, each a list of
 * blocks: a string is a paragraph, { items } a bulleted list, { sub } a subheading.
 */
export function termsDocument({ mainnet = false, restricted = [] } = {}) {
  const places = (restricted ?? []).filter(Boolean);
  const contact = `on X (${CONTACT.x}) or Telegram (${CONTACT.telegram})`;
  // Section numbers are looked up by title, so a reference cannot point at the wrong section after an edit.
  const n = title => { const i = sections.findIndex(([t]) => t === title); if (i < 0) throw new Error(`No section ${title}`); return i + 1; };
  const sections = [
    ['About these Terms', [
      `These Terms of Use (the “Terms”) are an agreement between you and the operators of Elpida (“Elpida”, “we”, “us”). They govern your use of the website at elpida.fun, its pages, documentation, interfaces and public API (together, the “Services”). The legal entity that operates Elpida will be named here once it is formed; until then, you can reach the operators ${contact}.`,
      'By ticking the box and pressing “Accept”, or by using the Services in any other way, you agree to these Terms. If you do not agree, do not use the Services.',
    ]],
    ['Changes to these Terms', [
      'We may change these Terms. The date at the top shows when they last changed. When a change matters, the website asks you to read and accept the Terms again before you continue. If you do not accept a change, stop using the Services.',
    ]],
    ['Not advice, not an offer', [
      'Everything on the Services, including token pages, charts, rankings, analytics, “trending” lists, creator content and our documentation, is general information only. It is not a recommendation to buy, sell or hold any token, and it is not investment, financial, legal, tax or accounting advice.',
      'Elpida is not registered, licensed or approved by any securities, commodities or financial regulator in any country. Nothing on the Services is an offer, or a solicitation of an offer, to buy or sell any security, derivative, collective investment or other financial product, and no product described on the Services is promised to be available to you or in your country. Statements about our plans may change and may never happen.',
      'You alone decide what to do with the information on the Services. Consider getting independent professional advice before you act on it.',
    ]],
    ['Who may use Elpida', [
      'You must be at least 18 years old, and old enough to enter a binding contract where you live. If you use the Services for a company or other organisation, you confirm you may bind it to these Terms. The Services are not meant for children.',
      'You may not use the Services if you are a “Restricted Person”, meaning anyone who:',
      { items: [
        ...(places.length ? [`is a citizen or resident of, located in, or using the Services from ${list(places)};`] : []),
        'is located in, resident in, or organised under the laws of a country or region subject to comprehensive sanctions or embargoes by the United Nations, the United States, the United Kingdom or the European Union, including Cuba, Iran, North Korea, and the Crimea, Donetsk and Luhansk regions of Ukraine;',
        'is named on, or owned or controlled by someone named on, a sanctions list kept by the United Nations Security Council, the United States Treasury’s Office of Foreign Assets Control, the United Kingdom, the European Union or Nigeria;',
        'is located in, or resident in, any place where using the Services would be against the law; or',
        'is otherwise barred from using the Services by any law on sanctions, export controls, anti-money laundering or counter-terrorist financing.',
      ] },
      'You confirm you are not a Restricted Person and that you will not use a VPN or any other method to hide where you are in order to use the Services.',
    ]],
    ['What Elpida is', [
      'Elpida is a website and software interface for public blockchains. It lets you browse tokens and market data, connect a wallet you control, launch a token on a bonding curve, trade tokens on their curves, follow a token as it graduates to a decentralised exchange pool whose liquidity is locked permanently, and claim creator fees that the contracts have assigned to your wallet.',
      'Elpida has no user accounts and never holds your keys, your recovery phrase or your funds. Every transaction is prepared in your browser and signed by you in your own wallet. Once a transaction is confirmed on a blockchain, nobody, including Elpida, can reverse or change it. Smart contracts run as they are written; once deployed, Elpida cannot change how a contract behaves or recover assets sent to it.',
      'We may change, add or remove any part of the Services at any time, without notice.',
    ]],
    ['Test networks and the mainnet beta', [
      'Most networks on Elpida are public test networks. Test coins come from free faucets, and tokens on test networks, including test stablecoins and test tokenized stocks such as “tNVDAon”, have no monetary value, cannot be exchanged for money and are not real shares or securities. Test assets are not issued, endorsed or backed by any company whose name or ticker they resemble.',
      mainnet ? 'Networks marked “mainnet” use real funds. Their contracts are new and have not had an independent security audit, and some features (for example trader airdrops, holder rewards and the flywheel) may stay switched off at first. Use only amounts you can afford to lose completely.' : 'No network on Elpida currently uses real funds. If a mainnet opens, these Terms will be updated and you will be asked to accept them again.',
    ]],
    ['Tokens and what you submit', [
      'Anyone can launch a token on Elpida. We do not review, approve, endorse or guarantee any token, creator, name, image, link or claim, and a token appearing on the Services is not a recommendation. Token names and images may imitate other projects, brands or people; that does not mean those parties are involved.',
      'When you launch a token, you provide its name, symbol, image, description and links (your “Submission”). You confirm that your Submission is accurate, is yours to use, does not infringe anyone’s copyright, trademark, privacy or other rights, does not impersonate anyone, and is not unlawful, hateful, sexually explicit, harassing or misleading.',
      'A Submission is written into the launch transaction and stored on a blockchain and in public storage such as IPFS. It is permanent and public: nobody, including Elpida, can edit or delete it there. We may hide any token or Submission from the Services at any time, for any reason.',
      'You allow Elpida to display, copy and process your Submission, without payment, to run, show and improve the Services.',
    ]],
    ['Fees', [
      'Launching a token costs a launch fee, and trades on a bonding curve pay a trading fee, at the rates shown on the Services when you act. Creators may also set a token tax at launch where a network supports it. Part of these fees goes to Elpida and part to the wallets the creator chose. The split for each token is fixed in its contracts at launch.',
      'Creator fees, holder rewards and buybacks are automatic results of how the contracts are written. They are not promises, not a return on any investment and not an obligation Elpida owes you, and they may produce nothing. An amount is yours only once it reaches your wallet on chain.',
      'Network fees (gas) go to the blockchain, not to Elpida. Fees are not refundable once a transaction is submitted, even if it fails. You are responsible for any taxes on your activity.',
    ]],
    ['Tokenized stock pairs', [
      'On some networks a token can be paired with a tokenized stock or exchange-traded fund instead of the network’s coin or a stablecoin, for example a token issued by Ondo Global Markets (a “Tokenized Stock”). This section applies whenever you launch, buy, sell or hold a token paired with a Tokenized Stock, or acquire or use a Tokenized Stock through the Services.',
      { sub: 'Not for US persons' },
      'Tokenized Stock pairs are not offered to, and may not be used by, US Persons. A “US Person” is anyone who is a citizen or resident of the United States, is located in the United States, or acts for or on behalf of such a person, and any company, partnership, trust or other entity organised, incorporated or established in the United States. They are also not available to Restricted Persons (section 4), to anyone the issuer’s own eligibility rules exclude, or to anyone in a place where the issuer does not offer the Tokenized Stock or where holding it would be unlawful. For Ondo Global Markets those rules currently exclude, among others, persons in Canada and in several sanctioned countries, and allow persons in the United Kingdom, the European Economic Area, Switzerland, Brazil, Hong Kong, Malaysia and Singapore only if they qualify as professional or qualified investors; the issuer’s published rules prevail and may change. By using a Tokenized Stock pair you confirm that none of this applies to you and that you are allowed to hold that Tokenized Stock under the issuer’s terms and the law that applies to you.',
      { sub: 'No affiliation' },
      'Elpida is independent. It is not affiliated with, endorsed, sponsored or approved by Ondo Global Markets, Ondo Finance or any other issuer of a Tokenized Stock, or by any company, fund or index whose shares or name a Tokenized Stock refers to. Their names and tickers appear on the Services only to identify the assets. Elpida does not issue, sell, redeem or custody Tokenized Stocks and is not a broker, dealer or investment adviser. You get Tokenized Stocks from third parties, on their terms and at your own responsibility.',
      { sub: 'What a Tokenized Stock is not' },
      'A Tokenized Stock is a token issued by a third party under its own terms. Holding one, or a token paired with one, does not make you a shareholder of the underlying company or fund and does not by itself give you voting rights, dividends or any claim against that company or fund. Read the issuer’s terms and disclosures before you acquire a Tokenized Stock; they, not Elpida, set what the token represents and who may hold it.',
      { sub: 'Risks particular to Tokenized Stocks' },
      { items: [
        'The issuer can pause, freeze, block or reverse transfers, change or end the token, redeem it, or take tokens back, including tokens held in a token’s curve, its locked pool or any other contract. If that happens, a pool may become impossible to trade or to graduate, and you may lose what you put in.',
        'Corporate actions such as splits, dividends and mergers can change how many tokens represent one share. Price feeds may pause during such events and while markets are closed.',
        'Tokenized Stock prices come from third-party price feeds (for example Chainlink or Pyth) and follow markets that trade only part of the week. A price can be out of date, paused or wrong; launches paired with a Tokenized Stock may be refused while its price is unavailable.',
        'The issuer’s solvency, custody of the underlying assets, regulatory status and ability to redeem are outside Elpida’s control and are not reflected in any price shown on the Services.',
      ] },
    ]],
    ['Risks you accept', [
      'Using Elpida carries serious risks, including these:',
      { items: [
        'Token prices are extremely volatile. Most tokens lose most or all of their value, and liquidity can disappear.',
        'Smart contracts can contain bugs or be exploited, and ours have not had an independent audit.',
        'Other people can trade ahead of you or around your transaction (front-running, sandwiching and other forms of MEV), and prices can move between the moment you see a quote and the moment your transaction confirms.',
        'A curve may complete without graduating straight away, and graduation can be delayed or blocked by other traders or by network conditions.',
        'Price feeds, RPC providers, indexers, wallets, bridges and exchanges can fail, lag or show wrong data. The blockchain is the record; what the Services display may be out of date or incorrect.',
        'If someone gets your recovery phrase, keys or device, they can take your assets. Elpida cannot recover them.',
        'Laws and regulations on digital assets change and may restrict or end your ability to use the Services or hold certain tokens.',
      ] },
      'You use the Services entirely at your own risk and are responsible for checking every transaction your wallet asks you to sign.',
    ]],
    ['Services run by others', [
      'The Services depend on products run by other people, including blockchains and their validators, wallets, RPC providers, decentralised exchanges (such as Uniswap, Raydium and PumpSwap), price oracles, IPFS pinning, hosting, content delivery and security providers. They have their own terms and privacy policies, and we do not control them or answer for them. Links to other websites are for convenience only.',
    ]],
    ['What you must not do', [
      'You agree not to use the Services, or try to:',
      { items: [
        'break any law, or defraud, deceive or harm anyone;',
        'manipulate markets, including wash trading, spoofing, coordinated pump-and-dump schemes, or launching a token to mislead buyers;',
        'impersonate any person, project or company, or publish content you do not have the right to use;',
        'scrape, crawl or overload the Services other than through the public endpoints we document, or interfere with, attack or disrupt the Services, their servers or networks;',
        'exploit a bug or vulnerability instead of reporting it to us;',
        'get around any restriction we place on access, including a block on where you are.',
      ] },
      `If you find a security problem, please tell us privately ${contact} and give us reasonable time to fix it before making it public.`,
    ]],
    ['Ending or limiting access', [
      'We may restrict, suspend or end your access to all or part of the Services, hide tokens or Submissions, or block network addresses, at any time and for any reason, including a suspected breach of these Terms or a legal risk. This only affects the website and interfaces we run; it cannot change your assets or the contracts on chain. Everything in these Terms that by its nature should outlast your access, including the sections on advice, Submissions, fees, risks, warranties, liability and disputes, continues to apply after your access ends.',
    ]],
    ['No warranties', [
      'THE SERVICES ARE PROVIDED “AS IS” AND “AS AVAILABLE”. TO THE FULLEST EXTENT THE LAW ALLOWS, ELPIDA AND ITS OPERATORS, CONTRIBUTORS AND SERVICE PROVIDERS GIVE NO WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED OR STATUTORY, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICES OR ANY SMART CONTRACT WILL BE AVAILABLE, SECURE, ACCURATE, FREE OF ERRORS OR HARMFUL CODE, OR THAT ANY DEFECT WILL BE FIXED.',
      'Nothing in these Terms removes any right that the law where you live does not allow to be removed.',
    ]],
    ['Limits on our liability', [
      'TO THE FULLEST EXTENT THE LAW ALLOWS, ELPIDA AND ITS OPERATORS, CONTRIBUTORS AND SERVICE PROVIDERS ARE NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, DIGITAL ASSETS OR GOODWILL, ARISING FROM OR RELATED TO THE SERVICES, ANY SMART CONTRACT, ANY TOKEN OR ANY THIRD PARTY, HOWEVER CAUSED, EVEN IF FORESEEABLE.',
      'TO THE FULLEST EXTENT THE LAW ALLOWS, OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS IS LIMITED TO THE GREATER OF ONE HUNDRED US DOLLARS (US$100) OR THE FEES YOU PAID TO ELPIDA IN THE SIX MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM.',
      'These limits do not apply to liability that cannot be limited by law, such as liability for fraud.',
    ]],
    ['Your responsibility to us', [
      'You agree to compensate Elpida and its operators for any claim, loss or cost (including reasonable legal fees) that arises from your breach of these Terms, your Submissions, your misuse of the Services or your breach of any law or anyone else’s rights.',
    ]],
    ['Disputes', [
      `Before starting any formal claim, you agree to contact us ${contact} with a description of the problem and any wallet address or transaction involved, and to give us 60 days to try to resolve it.`,
      'To the fullest extent the law allows, any claim must be brought by you individually and not as a plaintiff or member of a class, group or representative action, and you give up any right to a jury trial.',
      'The forum and rules for resolving disputes that cannot be settled informally will be stated here once Elpida’s operating entity is formed. Any claim must be started within one year after you knew, or should have known, of the facts behind it, unless the law requires a longer period.',
    ]],
    ['Governing law', [
      'The law governing these Terms will be stated here once Elpida’s operating entity is formed. Until then, these Terms apply as written, subject to any rights the law of your country gives you that cannot be waived.',
    ]],
    ['Our name and content', [
      'The Elpida name, logo, design and website content belong to Elpida. You may view and share pages of the Services for your own non-commercial use. You may not use our name or logo in a way that suggests we endorse you or your token. Tokens, images and other Submissions belong to the people who made them.',
    ]],
    ['Privacy', [
      'How we handle information is explained in Docs, under Privacy and cookies. In short: no accounts, no advertising, essential browser storage only unless you allow analytics, and no IP or wallet addresses stored with analytics. Your transactions are public on the blockchain.',
    ]],
    ['General', [
      'If any part of these Terms cannot be enforced, the rest still applies. If we do not enforce a right, we have not given it up. You may not transfer your rights under these Terms; we may transfer ours, for example to the entity that will operate Elpida. These Terms are the whole agreement between you and Elpida about the Services. They are written in English, and the English text prevails over any translation. We are not responsible for delays or failures caused by events outside our reasonable control.',
    ]],
    ['Contact', [
      `Questions about these Terms or the Services: ${contact}.`,
    ]],
  ];
  const notice = [
    `Elpida is experimental software. Its smart contracts have not had an independent security audit. ${mainnet ? 'Networks marked mainnet use real funds; every other network is a test network whose tokens have no monetary value.' : 'Elpida runs on public test networks and a local simulation, where tokens have no monetary value.'}${mainnet ? ' You can lose everything you put in.' : ''} Please read sections ${n('Test networks and the mainnet beta')} and ${n('Risks you accept')} carefully.`,
    `Elpida is not registered, licensed or approved by any financial regulator. Nothing on the website is an offer to sell or a solicitation to buy any security, derivative or other financial product, and nothing on it is investment, financial, legal or tax advice. Please read section ${n('Not advice, not an offer')} carefully.`,
    `Tokenized stock pairs are not available to US Persons, and Elpida is not affiliated with Ondo or any other issuer. Please read section ${n('Tokenized stock pairs')} before using them.`,
    `These Terms limit Elpida’s liability and require disputes to be raised individually, not as a class or group. Please read sections ${n('No warranties')} to ${n('Disputes')} carefully.`,
  ];
  return { title: 'Elpida Terms of Use', updated: TERMS_UPDATED, version: TERMS_VERSION, notice, sections };
}

/** The Terms as DOM, for the entry dialog and the #/terms page. */
export function renderTermsBody(doc) {
  return [
    ...doc.notice.map(text => h('p.tm-notice', text)),
    ...doc.sections.map(([title, blocks], i) => h('section.tm-section', { id: `terms-${i + 1}` },
      h('h3', `${i + 1}. ${title}`),
      blocks.map(block => typeof block === 'string' ? h('p', block) : block.items ? h('ul', block.items.map(item => h('li', item))) : h('h4', block.sub)))),
  ];
}

/** The #/terms page. */
export function renderTermsPage(ctx) {
  const doc = termsDocument({ mainnet: !!ctx.config?.solana?.mainnet, restricted: ctx.config?.consent?.restricted });
  return h('article.tm-page.tk-card',
    h('header.tm-page-head', h('h1', doc.title), h('p.muted', `Last updated: ${doc.updated}`)),
    h('div.tm-body', renderTermsBody(doc)),
    h('p.tm-page-foot.muted', 'Also see ', h('a', { href: '#/docs/risk' }, 'Risk disclaimer'), ' and ', h('a', { href: '#/docs/privacy' }, 'Privacy and cookies'), '.'));
}
