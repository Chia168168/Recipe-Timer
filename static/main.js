// ******** VAPID 公钥 ********
const VAPID_PUBLIC_KEY = 'BE0_aRw-529C4ZGHk90uZsKzAOexmMhAd24OYd182cE3rYMnFWOq__ODXZfVVzMeVPbpSregGuaLH3yDZqtbx-8';
// *********************

let swRegistration = null;

// 基础函数定义
function urlBase64ToUint8Array(base64String) {
    try {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        
        console.log('转换后的密钥长度:', outputArray.length);
        return outputArray;
    } catch (error) {
        console.error('密钥转换错误:', error);
        throw new Error('VAPID 公钥格式无效');
    }
}

function showNotification(message, type = 'info') {
    const container = document.getElementById('notificationContainer');
    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    let icon = 'fa-info-circle';
    if (type === 'success') icon = 'fa-check-circle';
    if (type === 'error') icon = 'fa-exclamation-circle';
    if (type === 'warning') icon = 'fa-exclamation-triangle';
    el.innerHTML = `<i class="fas ${icon}"></i><div>${message}</div>`;
    container.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 5000);
}

// 检查浏览器支持
function checkBrowserSupport() {
    if (!('serviceWorker' in navigator)) {
        showNotification('您的浏览器不支持 Service Worker', 'error');
        return false;
    }
    
    if (!('PushManager' in window)) {
        showNotification('您的浏览器不支持推送通知', 'error');
        return false;
    }
    
    if (!('Notification' in window)) {
        showNotification('您的浏览器不支持通知功能', 'error');
        return false;
    }
    
    return true;
}

// 注册 Service Worker
async function registerServiceWorker() {
    if (!checkBrowserSupport()) {
        return null;
    }

    try {
        // 先取消所有现有注册
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let registration of registrations) {
            await registration.unregister();
        }
        
        // 等待一小段时间确保取消完成
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 重新注册
        swRegistration = await navigator.serviceWorker.register('/sw.js', {
            scope: '/'
        });
        
        console.log('Service Worker 注册成功');
        
        // 等待激活
        return new Promise((resolve, reject) => {
            if (swRegistration.active) {
                console.log('Service Worker 已激活');
                resolve(swRegistration);
                return;
            }
            
            const checkActivation = () => {
                if (swRegistration.active) {
                    console.log('Service Worker 已激活');
                    resolve(swRegistration);
                }
            };
            
            // 立即检查一次
            checkActivation();
            
            // 监听状态变化
            swRegistration.addEventListener('updatefound', () => {
                const newWorker = swRegistration.installing;
                newWorker.addEventListener('statechange', () => {
                    console.log('Service Worker 状态变化:', newWorker.state);
                    if (newWorker.state === 'activated') {
                        resolve(swRegistration);
                    }
                });
            });
            
            // 超时处理
            setTimeout(() => {
                if (swRegistration.active) {
                    resolve(swRegistration);
                } else {
                    reject(new Error('Service Worker 激活超时'));
                }
            }, 10000);
        });
        
    } catch (error) {
        console.error('Service Worker 注册失败:', error);
        showNotification('Service Worker 注册失败: ' + error.message, 'error');
        return null;
    }
}

// 检查订阅状态
async function checkSubscriptionStatus() {
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        const pushSubscribed = localStorage.getItem('pushSubscribed') === 'true';
        
        if (subscription && pushSubscribed) {
            console.log('用户已订阅推送通知');
            document.getElementById('enableNotificationsBtn').style.display = 'none';
            return true;
        } else {
            console.log('用户未订阅或订阅状态不一致');
            document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
            return false;
        }
    } catch (error) {
        console.error('检查订阅状态失败:', error);
        document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
        return false;
    }
}

// 订阅推送通知
async function subscribeUser() {
    const enableBtn = document.getElementById('enableNotificationsBtn');
    
    try {
        enableBtn.disabled = true;
        enableBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 订阅中...';
        
        console.log('=== 开始推送订阅流程 ===');
        
        // 1. 检查网络连接
        if (!navigator.onLine) {
            throw new Error('网络连接不可用，请检查网络连接');
        }
        
        // 2. 检查通知权限
        const permission = await Notification.requestPermission();
        console.log('通知权限状态:', permission);
        
        if (permission !== 'granted') {
            throw new Error('通知权限未被授予');
        }
        
        // 3. 验证 VAPID 密钥
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        console.log('VAPID 密钥验证成功，长度:', applicationServerKey.length);
        
        // 4. 检查并清理现有订阅
        let existingSubscription = await swRegistration.pushManager.getSubscription();
        if (existingSubscription) {
            console.log('发现现有订阅，正在取消...');
            await existingSubscription.unsubscribe();
            console.log('现有订阅已取消');
        }
        
        // 5. 创建新订阅
        console.log('正在创建新订阅...');
        const subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey
        });
        
        console.log('订阅创建成功');
        
        // 6. 验证订阅对象
        if (!subscription.endpoint) {
            throw new Error('订阅对象无效：缺少 endpoint');
        }
        
        console.log('推送服务端点:', subscription.endpoint);
        
        // 7. 发送到服务器
        console.log('正在发送订阅信息到服务器...');
        const response = await fetch('/subscribe', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ subscription })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('服务器响应错误:', response.status, errorText);
            throw new Error(`服务器错误: ${response.status}`);
        }
        
        // 8. 成功处理
        localStorage.setItem('pushSubscribed', 'true');
        localStorage.setItem('subscription', JSON.stringify(subscription));
        enableBtn.style.display = 'none';
        
        showNotification('推送通知启用成功！', 'success');
        console.log('=== 推送订阅流程完成 ===');
        
    } catch (error) {
        console.error('订阅失败详情:', error);
        
        // 错误处理
        let errorMessage = '订阅失败';
        
        if (error.name === 'AbortError' || error.message.includes('push service error')) {
            errorMessage = '推送服务错误。可能的原因：\n' +
                          '- 浏览器推送服务暂时不可用\n' +
                          '- 防火墙或网络限制\n' +
                          '- 请尝试使用 Chrome 或 Firefox\n' +
                          '- 检查浏览器是否最新版本';
        } else if (error.name === 'NotAllowedError') {
            errorMessage = '通知权限被拒绝。请在浏览器设置中允许通知';
        } else if (error.name === 'NotSupportedError') {
            errorMessage = '您的浏览器不支持推送通知功能';
        } else if (error.message.includes('网络') || error.message.includes('超时')) {
            errorMessage = '网络连接问题：' + error.message;
        } else {
            errorMessage = error.message;
        }
        
        showNotification(errorMessage, 'error');
        
        // 重置按钮状态
        enableBtn.disabled = false;
        enableBtn.innerHTML = '<i class="fas fa-bell"></i> 启用推送通知';
    }
}

// 处理计时器按钮点击
async function handleTimerClick(minutes, recipeName) {
    if (localStorage.getItem('pushSubscribed') !== 'true') {
        showNotification('请先启用推送通知', 'warning');
        return;
    }

    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (!subscription) {
            showNotification('找不到订阅，请重新启用通知', 'error');
            localStorage.setItem('pushSubscribed', 'false');
            initializeUI();
            return;
        }

        const response = await fetch('/start_timer', {
            method: 'POST',
            body: JSON.stringify({
                minutes: minutes,
                message: `食谱「${recipeName}」的 ${minutes} 分钟计时已完成！`,
                subscription: subscription
            }),
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            showNotification(`已设定 ${minutes} 分钟计时器！`, 'success');
        } else {
            throw new Error(`HTTP错误: ${response.status}`);
        }
    } catch(err) {
        console.error('设定计时器失败:', err);
        showNotification('设定失败: ' + err.message, 'error');
    }
}

// 渲染食谱
function renderRecipes() {
    const recipeList = [
        { title: '基础面团发酵', steps: [{ text: '第一次发酵 60 分钟', time: 60 }, { text: '第二次发酵 30 分钟', time: 30 }] },
        { title: '烤鸡', steps: [{ text: '腌渍 120 分钟', time: 120 }, { text: '烘烤 45 分钟', time: 45 }] },
        { title: '测试用', steps: [{ text: '1 分钟快速测试', time: 1 }] }
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
    const enableBtn = document.getElementById('enableNotificationsBtn');
    enableBtn.addEventListener('click', subscribeUser);
    
    // 检查现有订阅状态
    checkSubscriptionStatus();
}

// 清除所有数据
window.clearAllData = async function() {
    try {
        // 取消现有订阅
        const subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
            await subscription.unsubscribe();
        }
        
        // 清除本地存储
        localStorage.removeItem('pushSubscribed');
        localStorage.removeItem('subscription');
        
        // 清除 Service Worker
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let registration of registrations) {
            await registration.unregister();
        }
        
        // 重新加载页面
        location.reload();
    } catch (error) {
        console.error('清除数据失败:', error);
        showNotification('清除失败: ' + error.message, 'error');
    }
}

// 添加调试功能
function addDebugInfo() {
    const debugDiv = document.createElement('div');
    debugDiv.style.marginTop = '20px';
    debugDiv.style.padding = '10px';
    debugDiv.style.background = '#f5f5f5';
    debugDiv.style.borderRadius = '5px';
    debugDiv.innerHTML = `
        <h4>调试功能</h4>
        <button onclick="testSubscription()" class="btn btn-sm btn-info">测试订阅状态</button>
        <button onclick="clearAllData()" class="btn btn-sm btn-warning">清除所有数据</button>
        <button onclick="runDiagnostics()" class="btn btn-sm btn-success">运行诊断</button>
    `;
    document.querySelector('.container').appendChild(debugDiv);
}

window.testSubscription = async function() {
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
            console.log('当前订阅:', subscription);
            showNotification('订阅存在，查看控制台', 'success');
        } else {
            showNotification('无订阅', 'warning');
        }
    } catch (error) {
        console.error('测试失败:', error);
    }
}

window.runDiagnostics = async function() {
    console.log('=== 运行诊断 ===');
    
    // 检查浏览器支持
    console.log('Service Worker 支持:', 'serviceWorker' in navigator);
    console.log('Push Manager 支持:', 'PushManager' in window);
    console.log('Notification 支持:', 'Notification' in window);
    
    // 检查权限
    const permission = await Notification.permission;
    console.log('通知权限:', permission);
    
    // 检查网络
    console.log('在线状态:', navigator.onLine);
    
    // 检查 Service Worker
    if (swRegistration) {
        console.log('Service Worker 状态:', swRegistration.active?.state);
    }
    
    // 检查订阅
    const subscription = await swRegistration.pushManager.getSubscription();
    console.log('订阅状态:', subscription ? '已订阅' : '未订阅');
    
    showNotification('诊断完成，查看控制台', 'success');
}

// 主初始化函数
async function initializeApp() {
    try {
        // 先渲染食谱，即使推送功能有问题也能使用基本功能
        renderRecipes();
        
        // 检查浏览器支持
        if (!checkBrowserSupport()) {
            console.log('浏览器不支持必要功能，仅显示基本界面');
            return;
        }
        
        // 注册 Service Worker
        swRegistration = await registerServiceWorker();
        if (!swRegistration) {
            console.log('Service Worker 注册失败，仅显示基本界面');
            return;
        }
        
        // 初始化界面
        initializeUI();
        
        // 添加调试信息
        addDebugInfo();
        
        console.log('应用初始化完成');
        
    } catch (error) {
        console.error('应用初始化失败:', error);
        showNotification('应用初始化失败: ' + error.message, 'error');
    }
}

// 程序入口点
window.addEventListener('load', () => {
    initializeApp();
});

// 确保 handleTimerClick 在全局可访问
window.handleTimerClick = handleTimerClick;
