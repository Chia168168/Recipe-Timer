// ******** VAPID 公钥 ********
const VAPID_PUBLIC_KEY = 'BE0_aRw-529C4ZGHk90uZsKzAOexmMhAd24OYd182cE3rYMnFWOq__ODXZfVVzMeVPbpSregGuaLH3yDZqtbx-8';
// *********************

let swRegistration = null;

// ==================== 工具函数 ====================
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

// ==================== 浏览器支持检查 ====================
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

// ==================== 扩展冲突处理 ====================
function checkForExtensionConflicts() {
    const conflictIndicators = [
        'Extension context invalidated',
        'chrome-extension://',
        'moz-extension://'
    ];
    
    window.addEventListener('error', (event) => {
        const errorText = event.error?.message || event.message || '';
        if (conflictIndicators.some(indicator => errorText.includes(indicator))) {
            console.warn('检测到浏览器扩展冲突:', errorText);
            showExtensionConflictWarning();
        }
    });
    
    window.addEventListener('unhandledrejection', (event) => {
        const errorText = event.reason?.message || event.reason || '';
        if (conflictIndicators.some(indicator => errorText.includes(indicator))) {
            console.warn('检测到扩展相关的 Promise 拒绝:', errorText);
            showExtensionConflictWarning();
        }
    });
}

function showExtensionConflictWarning() {
    if (document.getElementById('extension-warning')) return;
    
    const warningDiv = document.createElement('div');
    warningDiv.id = 'extension-warning';
    warningDiv.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #fff3cd;
        border: 1px solid #ffeaa7;
        border-radius: 8px;
        padding: 15px;
        max-width: 500px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    
    warningDiv.innerHTML = `
        <h4 style="margin:0 0 10px 0; color: #856404;">⚠️ 浏览器扩展冲突检测</h4>
        <p style="margin:0 0 10px 0; color: #856404;">
            检测到浏览器扩展可能干扰推送通知功能。建议：
        </p>
        <ul style="margin:0 0 10px 0; padding-left: 20px; color: #856404;">
            <li>暂时禁用广告拦截器</li>
            <li>检查隐私保护扩展设置</li>
            <li>尝试无痕/隐私浏览模式</li>
        </ul>
        <div style="display: flex; gap: 10px;">
            <button onclick="disableWarning()" class="btn btn-sm btn-warning">忽略</button>
            <button onclick="openIncognito()" class="btn btn-sm btn-primary">打开无痕模式</button>
            <button onclick="reloadPage()" class="btn btn-sm btn-success">刷新页面</button>
        </div>
    `;
    
    document.body.appendChild(warningDiv);
    
    setTimeout(() => {
        disableWarning();
    }, 10000);
}

window.disableWarning = function() {
    const warning = document.getElementById('extension-warning');
    if (warning) warning.remove();
};

window.openIncognito = function() {
    const currentUrl = window.location.href;
    window.open(currentUrl, '_blank');
};

window.reloadPage = function() {
    window.location.reload();
};

// ==================== Service Worker 注册 ====================
async function registerServiceWorker() {
    if (!checkBrowserSupport()) {
        return null;
    }

    try {
        const registration = await registerSWWithRetry();
        return registration;
    } catch (error) {
        console.error('Service Worker 注册最终失败:', error);
        
        if (error.message.includes('extension') || error.message.includes('context')) {
            showNotification('浏览器扩展可能阻止了 Service Worker 注册。请尝试禁用扩展或使用无痕模式。', 'warning');
        } else {
            showNotification('Service Worker 注册失败: ' + error.message, 'error');
        }
        
        return null;
    }
}

async function registerSWWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`尝试注册 Service Worker (${attempt}/${maxRetries})...`);
            
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (let registration of registrations) {
                await registration.unregister();
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            const registration = await navigator.serviceWorker.register('/sw.js', {
                scope: '/'
            });
            
            await waitForSWActivation(registration);
            
            console.log('Service Worker 注册成功');
            return registration;
            
        } catch (error) {
            console.error(`尝试 ${attempt} 失败:`, error);
            
            if (attempt === maxRetries) {
                throw error;
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

function waitForSWActivation(registration, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('Service Worker 激活超时'));
        }, timeout);
        
        if (registration.active) {
            clearTimeout(timeoutId);
            resolve(registration);
            return;
        }
        
        const onStateChange = () => {
            if (registration.installing) {
                registration.installing.addEventListener('statechange', (e) => {
                    if (e.target.state === 'activated') {
                        clearTimeout(timeoutId);
                        resolve(registration);
                    } else if (e.target.state === 'redundant') {
                        clearTimeout(timeoutId);
                        reject(new Error('Service Worker 变为冗余状态'));
                    }
                });
            }
        };
        
        if (registration.installing) {
            onStateChange();
        } else {
            registration.addEventListener('updatefound', onStateChange);
        }
    });
}

// ==================== 推送订阅功能 ====================
async function subscribeWithExtensionSafety(applicationServerKey) {
    try {
        // 方法1: 直接订阅
        try {
            return await swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });
        } catch (directError) {
            console.warn('直接订阅失败，尝试备用方法:', directError.message);
            
            // 方法2: 延迟执行（绕过某些扩展）
            return await new Promise((resolve, reject) => {
                setTimeout(async () => {
                    try {
                        const subscription = await swRegistration.pushManager.subscribe({
                            userVisibleOnly: true,
                            applicationServerKey: applicationServerKey
                        });
                        resolve(subscription);
                    } catch (error) {
                        reject(error);
                    }
                }, 100);
            });
        }
    } catch (error) {
        throw error;
    }
}

async function subscribeUser() {
    const enableBtn = document.getElementById('enableNotificationsBtn');
    
    try {
        enableBtn.disabled = true;
        enableBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 订阅中...';
        
        console.log('开始推送订阅（扩展安全模式）...');
        
        if (!navigator.onLine) {
            throw new Error('网络连接不可用');
        }
        
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            throw new Error('通知权限未被授予');
        }
        
        const existingSubscription = await swRegistration.pushManager.getSubscription();
        if (existingSubscription) {
            await existingSubscription.unsubscribe();
        }
        
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        const subscription = await subscribeWithExtensionSafety(applicationServerKey);
        
        if (!subscription.endpoint) {
            throw new Error('订阅对象无效');
        }
        
        console.log('订阅成功，端点:', subscription.endpoint.substring(0, 50) + '...');
        
        const response = await fetch('/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription })
        });
        
        if (!response.ok) {
            throw new Error(`服务器错误: ${response.status}`);
        }
        
        localStorage.setItem('pushSubscribed', 'true');
        localStorage.setItem('subscription', JSON.stringify(subscription));
        enableBtn.style.display = 'none';
        
        showNotification('推送通知启用成功！', 'success');
        
    } catch (error) {
        console.error('订阅失败:', error);
        
        let errorMessage = '订阅失败';
        if (error.message.includes('Extension context')) {
            errorMessage = '浏览器扩展冲突。请尝试：\n1. 禁用广告拦截器\n2. 使用无痕模式\n3. 检查扩展设置';
        } else if (error.name === 'AbortError' || error.message.includes('push service error')) {
            errorMessage = '推送服务错误。可能的原因：\n- 浏览器推送服务暂时不可用\n- 防火墙或网络限制\n- 请尝试使用 Chrome 或 Firefox';
        } else if (error.name === 'NotAllowedError') {
            errorMessage = '通知权限被拒绝。请在浏览器设置中允许通知';
        } else if (error.name === 'NotSupportedError') {
            errorMessage = '您的浏览器不支持推送通知功能';
        } else {
            errorMessage = error.message;
        }
        
        showNotification(errorMessage, 'error');
        
        enableBtn.disabled = false;
        enableBtn.innerHTML = '<i class="fas fa-bell"></i> 启用推送通知';
    }
}

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

// ==================== 计时器功能 ====================
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

// ==================== 食谱渲染 ====================
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

// ==================== 界面初始化 ====================
function initializeUI() {
    const enableBtn = document.getElementById('enableNotificationsBtn');
    enableBtn.addEventListener('click', subscribeUser);
    
    checkSubscriptionStatus();
}

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
        <button onclick="testBasicNotification()" class="btn btn-sm btn-primary">测试基础通知</button>
    `;
    document.querySelector('.container').appendChild(debugDiv);
}

// ==================== 调试功能 ====================
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
    
    console.log('Service Worker 支持:', 'serviceWorker' in navigator);
    console.log('Push Manager 支持:', 'PushManager' in window);
    console.log('Notification 支持:', 'Notification' in window);
    
    const permission = await Notification.permission;
    console.log('通知权限:', permission);
    
    console.log('在线状态:', navigator.onLine);
    
    if (swRegistration) {
        console.log('Service Worker 状态:', swRegistration.active?.state);
    }
    
    const subscription = await swRegistration.pushManager.getSubscription();
    console.log('订阅状态:', subscription ? '已订阅' : '未订阅');
    
    showNotification('诊断完成，查看控制台', 'success');
}

window.testBasicNotification = async function() {
    try {
        if (!('Notification' in window)) {
            throw new Error('浏览器不支持通知');
        }
        
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            throw new Error('通知权限未被授予');
        }
        
        new Notification('测试通知', {
            body: '这是一个测试通知，说明浏览器通知功能正常',
            icon: 'https://i.imgur.com/KNFdYyR.png'
        });
        
        showNotification('基础通知测试成功！', 'success');
    } catch (error) {
        showNotification('基础通知测试失败: ' + error.message, 'error');
    }
}

window.clearAllData = async function() {
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
            await subscription.unsubscribe();
        }
        
        localStorage.removeItem('pushSubscribed');
        localStorage.removeItem('subscription');
        
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (let registration of registrations) {
            await registration.unregister();
        }
        
        location.reload();
    } catch (error) {
        console.error('清除数据失败:', error);
        showNotification('清除失败: ' + error.message, 'error');
    }
}

// ==================== 主初始化函数 ====================
async function initializeApp() {
    try {
        // 启动扩展冲突检测
        checkForExtensionConflicts();
        
        // 先渲染食谱，确保基本功能可用
        renderRecipes();
        
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

// ==================== 程序入口点 ====================
window.addEventListener('load', () => {
    initializeApp();
});

// 确保 handleTimerClick 在全局可访问
window.handleTimerClick = handleTimerClick;
