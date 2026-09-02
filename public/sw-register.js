// Service worker registration.
//
// Deliberately NOT part of the bundle: a JavaScript error in the app must never
// leave a stale worker installed and serving an old build forever. That was the
// original reason this lived in an inline <script> in index.html.
//
// It is a separate file rather than inline so the Content-Security-Policy can
// say `script-src 'self'` with no hash and no 'unsafe-inline'. A CSP hash over
// an inline script has to be recomputed whenever the script changes by even one
// byte — including whenever the build tool decides to minify it differently —
// and a stale hash fails closed, taking the whole app down. One extra request,
// cached forever after the first load, buys a policy that cannot silently rot.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
}
