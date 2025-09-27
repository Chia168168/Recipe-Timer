console.log('Service Worker Loaded');

self.addEventListener('push', event => {
    const data = event.data.text();
    console.log('Push Received...', data);

    const title = '食譜計時器';
    const options = {
        body: data,
        icon: 'https://i.imgur.com/KNFdYyR.png', // 您可以換成自己的圖示
        badge: 'https://i.imgur.com/KNFdYyR.png'
    };

    event.waitUntil(self.registration.showNotification(title, options));
});
