self.addEventListener('fetch', function(event) {
    // Permet au Service Worker d'être valide pour l'installation PWA
    event.respondWith(fetch(event.request));
});
