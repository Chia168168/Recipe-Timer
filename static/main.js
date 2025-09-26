// VAPID 公钥
const VAPID_PUBLIC_KEY = 'BE0_aRw-529C4ZGHk90uZsKzAOexmMhAd24OYd182cE3rYMnFWOq__ODXZfVVzMeVPbpSregGuaLH3yDZqtbx-8';

let swRegistration = null;

// 工具函数
function showNotification(message, type = 'info') {
    const container = document.getElementById('notificationContainer');
    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';
    el.innerHTML = `<i class="fas ${icon}"></i><div>${message}</div>`;
    container.appendChild(el);
    setTimeout(() => el.remove(), 5000);
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// 检查浏览器支持
function checkBrowserSupport() {
    return 'serviceWorker' in navigator && 'PushManager' in window;
}

// 注册 Service Worker
async function registerServiceWorker() {
    if (!checkBrowserSupport()) {
        showNotification('浏览器不支持必要功能', 'error');
        return null;
    }

    try {
        // 清理现有注册
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let reg of registrations) await reg.unregister();
        
        // 注册新的
        swRegistration = await navigator.serviceWorker.register('/sw.js');
        console.log('Service Worker 注册成功');
        return swRegistration;
    } catch (error) {
        console.error('Service Worker 注册失败:', error);
        showNotification('Service Worker 注册失败', 'error');
        return null;
    }
}

// 订阅用户
async function subscribeUser() {
    const btn = document.getElementById('enableNotificationsBtn');
    
    try {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 订阅中...';
        
        // 检查权限
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            throw new Error('通知权限被拒绝');
        }
        
        // 创建订阅
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        const subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey
        });
        
        // 获取订阅数据
        const subData = subscription.toJSON ? subscription.toJSON() : {
            endpoint: subscription.endpoint,
            keys: subscription.keys
        };
        
        // 发送到服务器
        const response = await fetch('/subscribe', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({subscription: subData})
        });
        
        if (!response.ok) {
            throw new Error(`服务器错误: ${response.status}`);
        }
        
        // 保存到本地存储
        localStorage.setItem('pushSubscribed', 'true');
        localStorage.setItem('subscription', JSON.stringify(subData));
        btn.style.display = 'none';
        
        showNotification('推送通知启用成功！', 'success');
        
    } catch (error) {
        console.error('订阅失败:', error);
        showNotification('订阅失败: ' + error.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-bell"></i> 启用推送通知';
    }
}

// 检查订阅状态
async function checkSubscriptionStatus() {
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        const localSubscribed = localStorage.getItem('pushSubscribed') === 'true';
        
        if (subscription && localSubscribed) {
            document.getElementById('enableNotificationsBtn').style.display = 'none';
            return true;
        } else {
            document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
            return false;
        }
    } catch (error) {
        console.error('检查订阅状态失败:', error);
        document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
        return false;
    }
}

// 处理计时器点击
async function handleTimerClick(minutes, recipeName) {
    // 检查本地订阅状态
    if (localStorage.getItem('pushSubscribed') !== 'true') {
        showNotification('请先启用推送通知', 'warning');
        return;
    }

    try {
        // 获取当前订阅
        const subscription = await swRegistration.pushManager.getSubscription();
        if (!subscription) {
            showNotification('订阅不存在，请重新启用', 'error');
            localStorage.setItem('pushSubscribed', 'false');
            location.reload();
            return;
        }
        
        // 准备数据
        const subData = subscription.toJSON ? subscription.toJSON() : {
            endpoint: subscription.endpoint,
            keys: subscription.keys
        };
        
        const timerData = {
            minutes: minutes,
            message: `食谱「${recipeName}」的 ${minutes} 分钟计时已完成！`,
            subscription: subData
        };
        
        // 发送请求
        const response = await fetch('/start_timer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(timerData)
        });
        
        if (response.ok) {
            showNotification(`${minutes} 分钟计时器设置成功！`, 'success');
        } else {
            const error = await response.text();
            throw new Error(error);
        }
        
    } catch (error) {
        console.error('计时器设置失败:', error);
        showNotification('设置失败: ' + error.message, 'error');
    }
}

// 渲染食谱
function renderRecipes() {
    const recipes = [
        { title: '基础面团发酵', steps: [
            { text: '第一次发酵 60 分钟', time: 60 },
            { text: '第二次发酵 30 分钟', time: 30 }
        ]},
        { title: '烤鸡', steps: [
            { text: '腌渍 120 分钟', time: 120 },
            { text: '烘烤 45 分钟', time: 45 }
        ]},
        { title: '测试用', steps: [
            { text: '1 分钟快速测试', time: 1 }
        ]}
    ];

    const container = document.getElementById('recipes-list');
    container.innerHTML = '';

    recipes.forEach(recipe => {
        let stepsHtml = '';
        recipe.steps.forEach(step => {
            stepsHtml += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding: 8px 0;">
                    <span>${step.text}</span>
                    <button class="btn btn-info btn-sm" onclick="handleTimerClick(${step.time}, '${recipe.title}')">
                        <i class="fas fa-hourglass-start"></i> 启动 ${step.time} 分钟计时
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

// 初始化界面
function initializeUI() {
    const btn = document.getElementById('enableNotificationsBtn');
    btn.addEventListener('click', subscribeUser);
    checkSubscriptionStatus();
}

// 健康检查
async function checkHealth() {
    try {
        const response = await fetch('/health');
        if (response.ok) {
            const health = await response.json();
            console.log('服务器健康状态:', health);
            return health;
        }
        return null;
    } catch (error) {
        console.error('健康检查失败:', error);
        return null;
    }
}

// 应用初始化
async function initializeApp() {
    // 先渲染食谱
    renderRecipes();
    
    // 检查服务器健康
    const health = await checkHealth();
    if (health && !health.database_connected) {
        showNotification('数据库连接异常，部分功能受限', 'warning');
    }
    
    // 检查浏览器支持
    if (!checkBrowserSupport()) {
        showNotification('您的浏览器不支持推送通知', 'info');
        return;
    }
    
    // 注册 Service Worker
    swRegistration = await registerServiceWorker();
    if (!swRegistration) return;
    
    // 初始化界面
    initializeUI();
    
    console.log('应用初始化完成');
}

// 启动应用
window.addEventListener('load', initializeApp);

// 全局函数
window.handleTimerClick = handleTimerClick;
// 更新健康检查函数
window.checkHealth = async function() {
    try {
        const response = await fetch('/health');
        if (response.ok) {
            const health = await response.json();
            showNotification(`服务器状态: ${health.status}`, 'success');
            console.log('服务器健康状态:', health);
        } else {
            throw new Error('健康检查失败');
        }
    } catch (error) {
        showNotification('服务器检查失败: ' + error.message, 'error');
    }
};
// 添加表结构检查功能
window.checkTables = async function() {
    try {
        const response = await fetch('/debug/tables');
        if (response.ok) {
            const tables = await response.json();
            console.log('数据库表结构:', tables);
            showNotification('表结构检查完成，查看控制台', 'success');
        } else {
            throw new Error('表结构检查失败');
        }
    } catch (error) {
        console.error('表结构检查错误:', error);
        showNotification('检查失败: ' + error.message, 'error');
    }
};
// 更新调试面板
function addDebugInfo() {
    const debugDiv = document.createElement('div');
    debugDiv.style.marginTop = '20px';
    debugDiv.style.padding = '10px';
    debugDiv.style.background = '#f5f5f5';
    debugDiv.style.borderRadius = '5px';
    debugDiv.innerHTML = `
        <h4>调试功能</h4>
        <button onclick="checkHealth()" class="btn btn-sm btn-primary">服务器状态</button>
        <button onclick="checkTables()" class="btn btn-sm btn-info">检查表结构</button>
        <button onclick="testPush()" class="btn btn-sm btn-success">测试推送</button>
        <button onclick="clearAllData()" class="btn btn-sm btn-warning">清除数据</button>
        <div style="margin-top:10px; font-size:12px; color:#666;">
            当前问题: 订阅时服务器500错误
        </div>
    `;
    document.querySelector('.container').appendChild(debugDiv);
}
// 调试函数
window.testPush = async function() {
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (!subscription) {
            showNotification('没有订阅', 'error');
            return;
        }
        
        const subData = subscription.toJSON();
        const response = await fetch('/test_push', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                subscription: subData,
                message: '测试推送消息'
            })
        });
        
        if (response.ok) {
            showNotification('测试推送已发送', 'success');
        } else {
            throw new Error('推送失败');
        }
    } catch (error) {
        showNotification('测试失败: ' + error.message, 'error');
    }
};
