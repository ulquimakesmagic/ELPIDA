// Sends a person who opened a shared /token/<network>/<address> link into the single-page app. Crawlers and link-preview
// bots do not run scripts, so they keep the server-rendered page with its meta tags.
const target = document.querySelector('article[data-app]')?.dataset.app;
if (target && target.startsWith('/#/token/')) location.replace(target);
