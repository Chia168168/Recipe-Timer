// sw.js - 确保正确接收和处理推送
console.log('Service Worker 已加载');

self.addEventListener('install', (event) => {
    console.log('Service Worker 安装完成');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker 激活完成');
    self.clients.claim();
});

self.addEventListener('push', event => {
    console.log('收到推送消息');
    
    try {
        let data = {};
        if (event.data) {
            const text = event.data.text();
            try {
                data = JSON.parse(text);
            } catch (e) {
                data = { title: '食谱计时器', body: text };
            }
        } else {
            data = { title: '食谱计时器', body: '计时完成！' };
        }

        const title = data.title || '食谱计时器';
        const options = {
            body: data.body || data.message || '计时完成！',
            icon: 'https://i.imgur.com/KNFdYyR.png',
            badge: 'https://i.imgur.com/KNFdYyR.png',
            vibrate: [200, 100, 200],
            tag: 'recipe-timer',
            renotify: true
        };

        event.waitUntil(
            self.registration.showNotification(title, options)
        );
        
        console.log('通知已显示:', title, options.body);
    } catch (error) {
        console.error('处理推送错误:', error);
        event.waitUntil(
            self.registration.showNotification('食谱计时器', {
                body: '计时完成！',
                icon: 'https://i.imgur.com/KNFdYyR.png'
            })
        );
    }
});

self.addEventListener('notificationclick', event => {
    console.log('通知被点击');
    event.notification.close();
    
    event.waitUntil(
        self.clients.matchAll({type: 'window'}).then(windowClients => {
            for (let client of windowClients) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow('/');
            }
        })
    );
});
