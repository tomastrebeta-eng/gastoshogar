var CACHE_NAME = "casabalance-v1";
var CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(CORE_ASSETS);
    })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(names.filter(function(n){return n!==CACHE_NAME}).map(function(n){return caches.delete(n)}));
    }).then(function(){return self.clients.claim()})
  );
});

self.addEventListener("fetch", function(event){
  var req = event.request;
  if(req.method !== "GET") return;

  // Navegación: red primero, si no hay conexión se sirve el shell cacheado
  if(req.mode === "navigate"){
    event.respondWith(
      fetch(req).catch(function(){
        return caches.match("./index.html");
      })
    );
    return;
  }

  var url = new URL(req.url);
  if(url.origin === self.location.origin){
    // Recursos propios (manifest, íconos): caché primero, red de respaldo
    event.respondWith(
      caches.match(req).then(function(cached){
        var fetchPromise = fetch(req).then(function(res){
          if(res && res.status === 200){
            var resClone = res.clone();
            caches.open(CACHE_NAME).then(function(cache){cache.put(req, resClone)});
          }
          return res;
        }).catch(function(){return cached});
        return cached || fetchPromise;
      })
    );
  }
  // CDN externos (React, Recharts, Firebase, fuentes) y Firestore: directo a la red
});
