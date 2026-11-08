// Optional settings for the hosted (static) site.
// proxyUrl: URL of your free Cloudflare Worker (see worker/ and README) for live prices and any ticker.
// Leave it empty to use only the prebuilt daily data in data/.
window.STOCK_CONFIG = {
  proxyUrl: "https://stock-analyzer-proxy.ledanghoanghai6.workers.dev",
  refreshSeconds: 60,
};
