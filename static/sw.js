// sw.js
console.log('Service Worker 已加载');

self.addEventListener('push', event => {
    let data = {};
    try {
        data = event.data ? JSON.parse(event.data.text()) : {};
    } catch (err) {
        data = { body: event.data.text() };
    }

    const title = data.title || '食谱计时器';
    const options = {
        body: data.body || data.message || '计时完成！',
        icon: 'https://i.imgur.com/KNFdYyR.png',
        badge: 'https://i.imgur.com/KNFdYyR.png'
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({type: 'window'}).then(windowClients => {
            for (let client of windowClients) {
                if (client.url === '/' && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});
