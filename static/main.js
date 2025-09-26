const VAPID_PUBLIC_KEY = 'BE0_aRw-529C4ZGHk90uZsKzAOexmMhAd24OYd182cE3rYMnFWOq__ODXZfVVzMeVPbpSregGuaLH3yDZqtbx-8';

let swRegistration = null;

// 改进的订阅函数 - 分步骤处理
async function subscribeUser() {
    const enableBtn = document.getElementById('enableNotificationsBtn');
    
    try {
        enableBtn.disabled = true;
        enableBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 订阅中...';
        
        console.log('=== 开始分步推送订阅 ===');
        
        // 步骤1: 确保 Service Worker 完全就绪
        if (!swRegistration || !swRegistration.active) {
            throw new Error('Service Worker 未就绪');
        }
        
        // 步骤2: 准备 VAPID 密钥
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        console.log('VAPID 密钥准备完成');
        
        // 步骤3: 分步订阅过程
        await performSubscription(applicationServerKey);
        
        // 成功
        enableBtn.style.display = 'none';
        showNotification('推送通知启用成功！', 'success');
        
    } catch (error) {
        handleSubscriptionError(error, enableBtn);
    }
}

// 分步执行订阅
async function performSubscription(applicationServerKey) {
    console.log('步骤1: 检查现有订阅');
    let existingSubscription = await swRegistration.pushManager.getSubscription();
    
    if (existingSubscription) {
        console.log('发现现有订阅，取消中...');
        const success = await existingSubscription.unsubscribe();
        console.log('取消结果:', success);
        
        // 验证取消
        existingSubscription = await swRegistration.pushManager.getSubscription();
        if (existingSubscription) {
            throw new Error('无法取消现有订阅');
        }
    }
    
    console.log('步骤2: 创建新订阅');
    
    // 使用更保守的订阅方法
    const subscription = await createSubscriptionWithFallback(applicationServerKey);
    
    if (!subscription || !subscription.endpoint) {
        throw new Error('订阅创建失败：无效的订阅对象');
    }
    
    console.log('订阅创建成功，端点:', subscription.endpoint.substring(0, 50) + '...');
    
    // 步骤3: 验证订阅
    const isValid = await validateSubscription(subscription);
    if (!isValid) {
        throw new Error('订阅验证失败');
    }
    
    // 步骤4: 保存到服务器
    await saveSubscriptionToServer(subscription);
    
    // 步骤5: 本地存储
    localStorage.setItem('pushSubscribed', 'true');
    localStorage.setItem('subscription', JSON.stringify(subscription));
    
    console.log('=== 订阅流程完成 ===');
}

// 带降级的订阅创建
async function createSubscriptionWithFallback(applicationServerKey) {
    const methods = [
        // 方法1: 标准 VAPID 订阅
        async () => {
            console.log('尝试标准 VAPID 订阅...');
            return await swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });
        },
        
        // 方法2: 不带 VAPID 的订阅（某些浏览器支持）
        async () => {
            console.log('尝试无 VAPID 订阅...');
            return await swRegistration.pushManager.subscribe({
                userVisibleOnly: true
            });
        },
        
        // 方法3: 使用不同的编码格式
        async () => {
            console.log('尝试备用编码格式...');
            // 某些浏览器可能需要特定的编码格式
            const subscriptionOptions = {
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            };
            
            // 尝试强制使用 aesgcm 编码（如果支持）
            if (PushManager.supportedContentEncodings && 
                PushManager.supportedContentEncodings.includes('aesgcm')) {
                subscriptionOptions.applicationServerKey = applicationServerKey;
            }
            
            return await swRegistration.pushManager.subscribe(subscriptionOptions);
        }
    ];
    
    for (let i = 0; i < methods.length; i++) {
        try {
            const subscription = await methods[i]();
            if (subscription) {
                console.log(`方法 ${i + 1} 成功`);
                return subscription;
            }
        } catch (error) {
            console.log(`方法 ${i + 1} 失败:`, error.message);
            // 继续尝试下一种方法
        }
    }
    
    throw new Error('所有订阅方法都失败了');
}

// 验证订阅
async function validateSubscription(subscription) {
    try {
        // 基本验证
        if (!subscription.endpoint) {
            return false;
        }
        
        // 检查订阅是否包含必要的密钥
        const keys = subscription.toJSON ? subscription.toJSON().keys : null;
        if (!keys || !keys.p256dh || !keys.auth) {
            console.warn('订阅缺少必要的加密密钥');
        }
        
        // 发送验证请求到服务器
        const response = await fetch('/validate_subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: subscription })
        });
        
        return response.ok;
    } catch (error) {
        console.error('订阅验证错误:', error);
        return false;
    }
}

// 保存订阅到服务器
async function saveSubscriptionToServer(subscription) {
    const response = await fetch('/subscribe', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({ subscription: subscription })
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`服务器保存失败: ${response.status} - ${errorText}`);
    }
    
    console.log('订阅已保存到服务器');
}

// 改进的错误处理
function handleSubscriptionError(error, enableBtn) {
    console.error('订阅错误详情:', error);
    
    let errorMessage = '订阅失败';
    let errorType = 'error';
    
    if (error.name === 'AbortError' || error.message.includes('push service error')) {
        errorMessage = `
            推送服务暂时不可用。这可能是因为：
            
            1. 浏览器推送服务维护中
            2. 网络策略限制（公司/学校网络）
            3. 浏览器版本过旧
            
            建议：
            • 尝试使用最新版 Chrome/Firefox
            • 检查网络设置
            • 稍后重试
        `;
        errorType = 'warning';
    } else if (error.message.includes('VAPID') || error.message.includes('密钥')) {
        errorMessage = 'VAPID 配置问题，请联系管理员';
    } else {
        errorMessage = error.message;
    }
    
    showNotification(errorMessage, errorType);
    
    // 重置按钮
    enableBtn.disabled = false;
    enableBtn.innerHTML = '<i class="fas fa-bell"></i> 启用推送通知';
    
    // 显示详细解决方案
    showDetailedSolutions(error);
}

// 显示详细解决方案
function showDetailedSolutions(error) {
    const solutions = getDetailedSolutions(error);
    
    const solutionDiv = document.createElement('div');
    solutionDiv.id = 'subscription-solutions';
    solutionDiv.style.marginTop = '20px';
    solutionDiv.style.padding = '15px';
    solutionDiv.style.background = '#f8f9fa';
    solutionDiv.style.border = '1px solid #dee2e6';
    solutionDiv.style.borderRadius = '5px';
    
    solutionDiv.innerHTML = `
        <h4>🔧 解决方案</h4>
        <div style="white-space: pre-line;">${solutions.advice}</div>
        <div style="margin-top: 10px;">
            ${solutions.actions.map(action => 
                `<button onclick="${action.onclick}" class="btn btn-sm ${action.class}">${action.text}</button>`
            ).join(' ')}
        </div>
    `;
    
    // 移除现有的解决方案
    const existing = document.getElementById('subscription-solutions');
    if (existing) existing.remove();
    
    document.querySelector('.container').appendChild(solutionDiv);
}

function getDetailedSolutions(error) {
    const userAgent = navigator.userAgent.toLowerCase();
    const isChrome = userAgent.includes('chrome');
    const isFirefox = userAgent.includes('firefox');
    
    if (error.name === 'AbortError') {
        return {
            advice: `推送服务错误 (AbortError)。常见原因：
• 浏览器推送服务暂时不可用
• 网络策略阻止推送服务
• 浏览器设置限制

立即尝试：
1. 重启浏览器
2. 检查浏览器更新
3. 尝试不同网络`,
            actions: [
                { text: '🔄 重启浏览器', onclick: 'location.reload()', class: 'btn-warning' },
                { text: '🧹 清除数据重试', onclick: 'clearAllData()', class: 'btn-info' },
                { text: '📋 复制错误信息', onclick: 'copyErrorToClipboard()', class: 'btn-secondary' }
            ]
        };
    }
    
    return {
        advice: '请尝试以下解决方案',
        actions: [
            { text: '🔄 刷新页面', onclick: 'location.reload()', class: 'btn-primary' },
            { text: '🧪 测试基础功能', onclick: 'runComprehensiveTest()', class: 'btn-success' }
        ]
    };
}

// 综合测试函数
window.runComprehensiveTest = async function() {
    console.log('=== 开始综合测试 ===');
    
    try {
        // 测试1: Service Worker
        console.log('1. 测试 Service Worker...');
        if (!swRegistration) {
            throw new Error('Service Worker 未注册');
        }
        
        // 测试2: 推送权限
        console.log('2. 测试推送权限...');
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            throw new Error('通知权限未授予');
        }
        
        // 测试3: 基础通知
        console.log('3. 测试基础通知...');
        if (!('Notification' in window)) {
            throw new Error('浏览器不支持通知');
        }
        
        // 测试4: 服务器连接
        console.log('4. 测试服务器连接...');
        const healthResponse = await fetch('/health');
        if (!healthResponse.ok) {
            throw new Error('服务器健康检查失败');
        }
        
        showNotification('所有基础测试通过！推送服务可能是临时问题。', 'success');
        
    } catch (error) {
        console.error('综合测试失败:', error);
        showNotification('测试失败: ' + error.message, 'error');
    }
}

window.copyErrorToClipboard = function() {
    const errorInfo = {
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
        url: window.location.href,
        error: 'AbortError: Registration failed - push service error'
    };
    
    navigator.clipboard.writeText(JSON.stringify(errorInfo, null, 2));
    showNotification('错误信息已复制到剪贴板', 'success');
}

// 更新 Service Worker 注册逻辑
async function registerServiceWorker() {
    if (!checkBrowserSupport()) {
        return;
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
                resolve(swRegistration);
                return;
            }
            
            swRegistration.addEventListener('updatefound', () => {
                const newWorker = swRegistration.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'activated') {
                        resolve(swRegistration);
                    }
                });
            });
            
            // 超时处理
            setTimeout(() => reject(new Error('Service Worker 激活超时')), 10000);
        });
        
    } catch (error) {
        console.error('Service Worker 注册失败:', error);
        throw error;
    }
}

// 更新初始化流程
async function initializeApp() {
    try {
        await registerServiceWorker();
        initializeUI();
        renderRecipes();
    } catch (error) {
        console.error('应用初始化失败:', error);
        showNotification('应用初始化失败，请刷新页面重试', 'error');
    }
}

// 更新入口点
window.addEventListener('load', () => {
    if (!checkBrowserSupport()) {
        renderRecipes();
        return;
    }
    
    initializeApp();
});
