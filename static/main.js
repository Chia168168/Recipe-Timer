// ******** VAPID 公钥 ********
const VAPID_PUBLIC_KEY = 'BE0_aRw-529C4ZGHk90uZsKzAOexmMhAd24OYd182cE3rYMnFWOq__ODXZfVVzMeVPbpSregGuaLH3yDZqtbx-8';
// *********************

let swRegistration = null;

// 改进的密钥转换函数
function urlBase64ToUint8Array(base64String) {
    try {
        // 移除可能的空白字符
        const cleanKey = base64String.trim();
        
        // 添加填充
        const padding = '='.repeat((4 - cleanKey.length % 4) % 4);
        const base64 = (cleanKey + padding)
            .replace(/-/g, '+')
            .replace(/_/g, '/');
            
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

// 显示通知
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
    
    return true;
}

// 订阅推送通知
async function subscribeUser() {
    try {
        if (!VAPID_PUBLIC_KEY) {
            showNotification('VAPID公钥未配置', 'error');
            return;
        }

        console.log('开始订阅，使用公钥:', VAPID_PUBLIC_KEY);
        
        const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
        console.log('转换后的密钥:', applicationServerKey);
        
        if (applicationServerKey.length !== 65) {
            showNotification(`密钥长度错误: ${applicationServerKey.length}，应为65`, 'error');
            return;
        }

        // 检查现有订阅
        let subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
            console.log('已有订阅，先取消:', subscription);
            await subscription.unsubscribe();
        }

        subscription = await swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey
        });

        console.log('订阅成功:', subscription);

        // 发送到服务器
        const response = await fetch('/subscribe', {
            method: 'POST',
            body: JSON.stringify({ subscription }),
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            localStorage.setItem('pushSubscribed', 'true');
            document.getElementById('enableNotificationsBtn').style.display = 'none';
            showNotification('推送通知启用成功！', 'success');
            
            // 保存订阅信息用于调试
            localStorage.setItem('subscription', JSON.stringify(subscription));
        } else {
            const errorText = await response.text();
            throw new Error(`服务器错误: ${response.status} - ${errorText}`);
        }

    } catch (err) {
        console.error('订阅失败详情:', err);
        
        if (err.name === 'InvalidAccessError') {
            showNotification('VAPID 密钥无效，请检查配置', 'error');
        } else if (err.name === 'NotAllowedError') {
            showNotification('通知权限被拒绝', 'error');
        } else if (err.name === 'NotSupportedError') {
            showNotification('浏览器不支持推送功能', 'error');
        } else {
            showNotification('订阅失败: ' + err.message, 'error');
        }
    }
}

// 注册 Service Worker
async function registerServiceWorker() {
    if (!checkBrowserSupport()) {
        return;
    }

    try {
        swRegistration = await navigator.serviceWorker.register('/sw.js', {
            scope: '/'
        });

        console.log('Service Worker 注册成功');

        // 等待激活
        if (swRegistration.active) {
            initializeUI();
        } else if (swRegistration.installing) {
            swRegistration.installing.addEventListener('statechange', (e) => {
                if (e.target.state === 'activated') {
                    initializeUI();
                }
            });
        } else {
            swRegistration.addEventListener('updatefound', () => {
                const newWorker = swRegistration.installing;
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'activated') {
                        initializeUI();
                    }
                });
            });
        }

    } catch (error) {
        console.error('Service Worker 注册失败:', error);
        showNotification('Service Worker 注册失败: ' + error.message, 'error');
    }
}

// 检查订阅状态
async function checkSubscriptionStatus() {
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
            console.log('用户已订阅:', subscription);
            localStorage.setItem('pushSubscribed', 'true');
            document.getElementById('enableNotificationsBtn').style.display = 'none';
            
            // 验证订阅是否仍然有效
            const response = await fetch('/subscribe', {
                method: 'POST',
                body: JSON.stringify({ subscription }),
                headers: {'Content-Type': 'application/json'}
            });
            
            if (!response.ok) {
                throw new Error('订阅验证失败');
            }
        } else {
            console.log('用户未订阅');
            localStorage.setItem('pushSubscribed', 'false');
            document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
        }
    } catch (error) {
        console.error('检查订阅状态失败:', error);
        localStorage.setItem('pushSubscribed', 'false');
        document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
    }
}

// 初始化界面
function initializeUI() {
    const enableNotificationsBtn = document.getElementById('enableNotificationsBtn');
    enableNotificationsBtn.addEventListener('click', subscribeUser);
    
    // 检查权限和订阅状态
    navigator.permissions.query({name: 'notifications'}).then((permissionStatus) => {
        console.log('通知权限状态:', permissionStatus.state);
        
        if (permissionStatus.state === 'granted') {
            checkSubscriptionStatus();
        } else {
            enableNotificationsBtn.style.display = 'inline-flex';
        }
        
        permissionStatus.onchange = () => {
            console.log('权限状态变更:', permissionStatus.state);
            if (permissionStatus.state === 'granted') {
                checkSubscriptionStatus();
            }
        };
    }).catch(error => {
        console.error('检查权限失败:', error);
        enableNotificationsBtn.style.display = 'inline-flex';
    });
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

// 渲染食谱（保持不变）
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

// 添加调试功能
function addDebugInfo() {
    const debugDiv = document.createElement('div');
    debugDiv.style.marginTop = '20px';
    debugDiv.style.padding = '10px';
    debugDiv.style.background = '#f5f5f5';
    debugDiv.style.borderRadius = '5px';
    debugDiv.innerHTML = `
        <button onclick="testSubscription()" class="btn btn-sm">测试订阅</button>
        <button onclick="clearSubscription()" class="btn btn-sm">清除订阅</button>
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

window.clearSubscription = async function() {
    try {
        const subscription = await swRegistration.pushManager.getSubscription();
        if (subscription) {
            await subscription.unsubscribe();
            localStorage.removeItem('pushSubscribed');
            localStorage.removeItem('subscription');
            document.getElementById('enableNotificationsBtn').style.display = 'inline-flex';
            showNotification('订阅已清除', 'success');
        }
    } catch (error) {
        console.error('清除失败:', error);
    }
}

// 程序入口
window.addEventListener('load', () => {
    if (!checkBrowserSupport()) {
        renderRecipes();
        return;
    }
    
    registerServiceWorker();
    renderRecipes();
    addDebugInfo();
});
