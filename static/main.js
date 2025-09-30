// --- 設定 ---
const VAPID_PUBLIC_KEY = 'BE0_aRw-529C4ZGHk90uZsKzAOexmMhAd24OYd182cE3rYMnFWOq__ODXZfVVzMeVPbpSregGuaLH3yDZqtbx-8';
const POLLING_INTERVAL = 8000; // 每8秒向伺服器查詢一次最新狀態

// --- 全域變數 ---
let swRegistration = null;
// 應用程式的統一狀態管理物件
let appState = {
    recipes: [ // 靜態食譜資料，每個步驟都有獨一無二的 client_id
        { 
            id: 'dough', 
            title: '基礎麵糰發酵', 
            steps: [
                { id: 'dough_1', name: '第一次發酵' }, 
                { id: 'dough_2', name: '第二次發酵' }
            ] 
        },
        { 
            id: 'chicken', 
            title: '烤雞', 
            steps: [
                { id: 'chicken_1', name: '醃漬' }, 
                { id: 'chicken_2', name: '烘烤' }
            ] 
        },
        { 
            id: 'test', 
            title: '測試用', 
            steps: [
                { id: 'test_1', name: '1分鐘快速測試' }
            ] 
        }
    ],
    timers: {}, // 從伺服器來的動態計時器資料，格式為 { 'client_id': { id, status, expiry_time } }
    intervals: {} // 用於存放前端倒數計時的 setInterval ID
};

// --- Helper Functions ---
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

// --- 主渲染函式 ---
function renderApp() {
    const container = document.getElementById('app-container');
    container.innerHTML = '';
    
    Object.values(appState.intervals).forEach(clearInterval);
    appState.intervals = {};

    appState.recipes.forEach(recipe => {
        const card = document.createElement('div');
        card.className = 'card';
        
        let stepsHtml = '<div class="step-row" style="font-weight:bold; color:var(--dark);"><div>名稱</div><div>時間設定</div><div></div><div></div><div style="text-align:center;">計時狀況</div></div>';
        
        recipe.steps.forEach(step => {
            const timer = appState.timers[step.id];
            const isRunning = timer && timer.status === 'running';
            const isCompleted = timer && timer.status === 'completed';

            const timeOptions = [1, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120];
            const optionsHtml = timeOptions.map(t => `<option value="${t}" ${t === 10 ? 'selected' : ''}>${t} 分鐘</option>`).join('');

            let statusHtml = '<span style="color:var(--gray);">-</span>';
            if (isRunning) {
                const timerId = `timer-countdown-${timer.id}`;
                statusHtml = `<strong id="${timerId}" style="color:var(--success);">計算中...</strong>`;
                
                const expiryTime = new Date(timer.expiry_time).getTime();
                const updateCountdown = () => {
                    const remaining = Math.max(0, Math.round((expiryTime - new Date().getTime()) / 1000));
                    const minutes = Math.floor(remaining / 60);
                    const seconds = remaining % 60;
                    const el = document.getElementById(timerId);
                    if (el) {
                        el.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                    }
                    if (remaining <= 0 && appState.intervals[timer.id]) {
                        clearInterval(appState.intervals[timer.id]);
                        fetchActiveTimers(); // 時間到，重新從伺服器獲取最新狀態 (會變為 completed)
                    }
                };
                
                // 立即更新一次，避免延遲感
                setTimeout(updateCountdown, 0); 
                appState.intervals[timer.id] = setInterval(updateCountdown, 1000);

            } else if (isCompleted) {
                statusHtml = '<strong style="color:var(--gray);">已完成</strong>';
            }
            
            stepsHtml += `
                <div class="step-row">
                    <div>${step.name}</div>
                    <div><select id="time-select-${step.id}" ${isRunning || isCompleted ? 'disabled' : ''}>${optionsHtml}</select></div>
                    <div><button class="btn btn-sm btn-success" onclick="handleStartTimer('${step.id}')" ${isRunning || isCompleted ? 'disabled' : ''}>開始</button></div>
                    <div><button class="btn btn-sm btn-danger" onclick="handleCancelTimer(${timer ? timer.id : null})" ${!isRunning ? 'style="visibility:hidden;"' : ''}>取消</button></div>
                    <div style="text-align:center;">${statusHtml}</div>
                </div>
            `;
        });
        
        const titleEl = document.createElement('strong');
        titleEl.style.cssText = 'color:var(--primary); font-size:1.5rem; display:block;';
        titleEl.textContent = recipe.title;

        const stepsContainer = document.createElement('div');
        stepsContainer.style.marginTop = '12px';
        stepsContainer.innerHTML = stepsHtml;

        card.appendChild(titleEl);
        card.appendChild(stepsContainer);
        container.appendChild(card);
    });

    document.getElementById('cancelAllBtn').style.display = Object.keys(appState.timers).length > 0 ? 'inline-flex' : 'none';
}

// --- API 互動 ---
async function fetchActiveTimers() {
    if (localStorage.getItem('pushSubscribed') !== 'true') return;
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (!subscription) return;
        
        const response = await fetch(`/api/timers?endpoint=${encodeURIComponent(subscription.endpoint)}`);
        if (response.ok) {
            const timersFromServer = await response.json();
            // 將伺服器回傳的陣列轉換成以 client_id 為 key 的物件，方便查找
            appState.timers = timersFromServer.reduce((acc, timer) => {
                acc[timer.client_id] = timer;
                return acc;
            }, {});
            renderApp(); // 用最新狀態重新渲染整個畫面
        }
    } catch (err) {
        console.error('Failed to fetch active timers:', err);
    }
}

async function handleStartTimer(clientId) {
    const selectedMinutes = document.getElementById(`time-select-${clientId}`).value;
    const stepInfo = appState.recipes.flatMap(r => r.steps).find(s => s.id === clientId);
    const recipeInfo = appState.recipes.find(r => r.steps.some(s => s.id === clientId));

    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (!subscription) { throw new Error('找不到通知訂閱資訊，請嘗試重新整理頁面'); }

        const response = await fetch('/start_timer', {
            method: 'POST',
            body: JSON.stringify({
                minutes: selectedMinutes,
                client_id: clientId,
                message: `食譜「${recipeInfo.title}」的步驟「${stepInfo.name}」計時完成！`,
                subscription: subscription
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        
        // --- 新增的錯誤處理邏輯 ---
        if (response.ok) {
            showNotification(`已為「${stepInfo.name}」設定 ${selectedMinutes} 分鐘計時！`, 'success');
            fetchActiveTimers(); // 立即刷新狀態
        } else {
            // 如果伺服器回傳錯誤，嘗試讀取 JSON 內容中的錯誤訊息
            const errorData = await response.json().catch(() => null); // 如果回傳的不是JSON，避免解析錯誤
            const errorMessage = errorData ? errorData.message : `伺服器回應錯誤 (狀態碼: ${response.status})`;
            throw new Error(errorMessage);
        }
        // --------------------------

    } catch (err) {
        console.error('Failed to start timer:', err);
        // 現在會顯示更詳細的錯誤
        showNotification(`設定計時器失敗: ${err.message}`, 'error');
    }
}

async function handleCancelTimer(timerId) {
    if (!timerId) return;
    try {
        await fetch('/api/timers/cancel', {
            method: 'POST',
            body: JSON.stringify({ timer_id: timerId }),
            headers: { 'Content-Type': 'application/json' }
        });
        showNotification('計時器已取消', 'info');
        fetchActiveTimers();
    } catch(err) {
        console.error('Failed to cancel timer:', err);
    }
}

async function handleCancelAll() {
    if (!confirm('確定要取消所有進行中的計時器嗎？')) return;
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (!subscription) { throw new Error('Subscription not found'); }
        await fetch('/api/timers/cancel_all', {
            method: 'POST',
            body: JSON.stringify({ subscription: subscription }),
            headers: { 'Content-Type': 'application/json' }
        });
        showNotification('所有計時器已取消', 'info');
        fetchActiveTimers();
    } catch(err) {
        console.error('Failed to cancel all timers:', err);
    }
}

// --- Service Worker & 初始化 ---
async function registerServiceWorker() {
    if (!('serviceWorker' in navigator && 'PushManager' in window)) {
        showNotification('您的瀏覽器不支援推播通知', 'error');
        return;
    }
    try {
        swRegistration = await navigator.serviceWorker.register('/sw.js');
        initializeUI();
    } catch (error) {
        console.error('Service Worker Error', error);
    }
}

function initializeUI() {
    document.getElementById('enableNotificationsBtn').addEventListener('click', subscribeUser);
    document.getElementById('cancelAllBtn').addEventListener('click', handleCancelAll);

    if (localStorage.getItem('pushSubscribed') === 'true') {
        fetchActiveTimers();
    } else {
        document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
    }
}

async function subscribeUser() {
    // ... (此函式內容不變，可從舊版複製)
    try {
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        const subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey
        });
        await fetch('/subscribe', {
            method: 'POST',
            body: JSON.stringify({ subscription }),
            headers: { 'Content-Type': 'application/json' }
        });
        localStorage.setItem('pushSubscribed', 'true');
        document.getElementById('enableNotificationsBtn').style.display = 'none';
        showNotification('已成功啟用推播通知！', 'success');
        fetchActiveTimers();
    } catch (err) {
        console.error('Failed to subscribe the user: ', err);
        showNotification('啟用推播通知失敗', 'error');
    }
}

// --- 程式進入點 ---
window.addEventListener('load', () => {
    registerServiceWorker();
    renderApp(); // 初始渲染一次介面骨架
    
    // 設定輪詢
    setInterval(fetchActiveTimers, POLLING_INTERVAL);

    // 當使用者切換回這個分頁時，也立即更新一次
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            fetchActiveTimers();
        }
    });
});
