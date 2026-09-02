/* ============================================================================
   Service worker — hand-written, no build plugin.
   (vite-plugin-pwa was dropped because it pulls a vulnerable workbox tree.)

   Strategy, chosen deliberately for an accounting app:
     - hashed build assets  -> cache-first  (immutable per build, safe forever)
     - navigations          -> NETWORK-FIRST, cached copy only as offline fallback
     - everything else, including ALL Supabase traffic -> network-only

   Ledger data is NEVER served from cache. A stale trial balance that looks
   current is worse than an honest error — someone could file on it.

   WHY index.html IS NOT PRECACHED
   An earlier version precached "/" and "/index.html" at install under a
   hardcoded cache version. Because the version never changed between deploys,
   the cached shell was never purged, and an installed PWA could keep booting an
   old build — pointing at asset hashes from a previous release — indefinitely.
   The shell is now only ever stored as a copy of a SUCCESSFUL network response,
   so being online always means running the current build.
   ========================================================================= */

const ASSETS = "assets-v2";
const SHELL = "shell-v2";
const KEEP = [ASSETS, SHELL];

self.addEventListener("install", () => {
  // Nothing is precached; take over as soon as possible.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never cache anything cross-origin — that includes every Supabase call.
  if (url.origin !== self.location.origin) return;

  // Hashed build assets are immutable, so cache-first is both safe and fast.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSETS).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations: always try the network so a deploy is picked up immediately.
  // Keep the last good response as the offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/index.html", copy));
          }
          return res;
        })
        .catch(() =>
          caches.match("/index.html").then((hit) => hit ?? Response.error()),
        ),
    );
  }
});
