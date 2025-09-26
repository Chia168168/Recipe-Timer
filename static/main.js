// ******** 重要 ********
// 請將這裡替換成您自己生成的 VAPID Public Key
const VAPID_PUBLIC_KEY = '67K0P7BfyuVhTO_c5Af4Z1OgdLeXzQYgygDUm963wDftppXicrcQeLO11BMOWwGKOeLijASzlJKjotr9odLQzw';
// *********************

let swRegistration = null;

// 將 Base64 字串轉換為 Uint8Array
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// 顯示通知
function showNotification(message, type = 'info') {
    const container = document.getElementById('notificationContainer');
    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';
    el.innerHTML = `<i class="fas ${icon}"></i><div>${message}</div>`;
    container.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 4200);
}

// 訂閱推播通知
async function subscribeUser() {
    try {
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        const subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey
        });

        console.log('User is subscribed.');

        await fetch('/subscribe', {
            method: 'POST',
            body: JSON.stringify({ subscription }),
            headers: {
                'Content-Type': 'application/json'
            }
        });

        localStorage.setItem('pushSubscribed', 'true');
        document.getElementById('enableNotificationsBtn').style.display = 'none';
        showNotification('已成功啟用推播通知！', 'success');

    } catch (err) {
        console.error('Failed to subscribe the user: ', err);
        showNotification('啟用推播通知失敗', 'error');
    }
}

// 註冊 Service Worker
async function registerServiceWorker() {
    if (!('serviceWorker' in navigator && 'PushManager' in window)) {
        console.warn('Push messaging is not supported');
        showNotification('您的瀏覽器不支援推播通知', 'error');
        return;
    }

    try {
        swRegistration = await navigator.serviceWorker.register('/sw.js');
        console.log('Service Worker is registered', swRegistration);
        initializeUI();
    } catch (error) {
        console.error('Service Worker Error', error);
    }
}

// 初始化介面
function initializeUI() {
    const enableNotificationsBtn = document.getElementById('enableNotificationsBtn');
    enableNotificationsBtn.addEventListener('click', subscribeUser);

    // 檢查是否已經訂閱
    if (localStorage.getItem('pushSubscribed') === 'true') {
        console.log('User is already subscribed.');
    } else {
        enableNotificationsBtn.style.display = 'inline-flex';
    }
}

// 處理計時器按鈕點擊
async function handleTimerClick(minutes, recipeName) {
    if (localStorage.getItem('pushSubscribed') !== 'true') {
        showNotification('請先點擊右上角的按鈕啟用推播通知', 'warning');
        return;
    }

    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (!subscription) {
            showNotification('找不到通知訂閱，請重新啟用', 'error');
            localStorage.setItem('pushSubscribed', 'false');
            initializeUI();
            return;
        }

        await fetch('/start_timer', {
            method: 'POST',
            body: JSON.stringify({
                minutes: minutes,
                message: `食譜「${recipeName}」的 ${minutes} 分鐘計時已完成！`,
                subscription: subscription
            }),
            headers: { 'Content-Type': 'application/json' }
        });

        showNotification(`已在雲端設定 ${minutes} 分鐘計時器！`, 'success');
    } catch(err) {
        console.error('Failed to start timer:', err);
        showNotification('設定計時器失敗', 'error');
    }
}

// 渲染範例食譜
function renderRecipes() {
    const recipeList = [
        { title: '基礎麵糰發酵', steps: [{ text: '第一次發酵 60 分鐘', time: 60 }, { text: '第二次發酵 30 分鐘', time: 30 }] },
        { title: '烤雞', steps: [{ text: '醃漬 120 分鐘', time: 120 }, { text: '烘烤 45 分鐘', time: 45 }] },
        { title: '測試用', steps: [{ text: '1 分鐘快速測試', time: 1 }] }
    ];

    const container = document.getElementById('recipes-list');
    container.innerHTML = '';

    recipeList.forEach(recipe => {
        let stepsHtml = '';
        recipe.steps.forEach(step => {
            stepsHtml += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding: 8px 0;">
                    <span>${step.text}</span>
                    <button class="btn btn-info btn-sm" onclick="handleTimerClick(${step.time}, '${recipe.title}')">
                        <i class="fas fa-hourglass-start"></i> 啟動 ${step.time} 分鐘計時
                    </button>
                </div>
            `;
        });

        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <strong style="color:var(--primary); font-size:1.5rem">${recipe.title}</strong>
            <div style="margin-top:12px;">${stepsHtml}</div>
        `;
        container.appendChild(card);
    });
}

// 程式進入點
window.addEventListener('load', () => {
    registerServiceWorker();
    renderRecipes(); // 載入範例食譜
});
