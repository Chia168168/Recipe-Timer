import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException
import logging

# 配置日志
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# --- 初始化设定 ---
app = Flask(__name__, static_folder='static')

# 从环境变量读取设定
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {
    "sub": "mailto:your-email@example.com"  # 请改成您的实际邮箱
}

# 验证 VAPID 配置
if not VAPID_PRIVATE_KEY or not VAPID_PUBLIC_KEY:
    logger.warning("VAPID 密钥未完整配置！推送通知将无法工作")

db = SQLAlchemy(app)
scheduler = BackgroundScheduler(daemon=True)

# --- 数据库模型 ---
class Subscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_json = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Timer(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_id = db.Column(db.Integer, db.ForeignKey('subscription.id'), nullable=False)
    expiry_time = db.Column(db.DateTime, nullable=False)
    message = db.Column(db.String(200), nullable=False)
    notified = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    subscription = db.relationship('Subscription', backref=db.backref('timers', lazy=True))

# --- API 端点 ---
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

@app.route('/sw.js')
def serve_sw():
    return send_from_directory(app.static_folder, 'sw.js')

@app.route('/health')
def health_check():
    """健康检查端点"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.utcnow().isoformat(),
        'vapid_configured': bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY),
        'database_connected': db.engine.execute('SELECT 1') is not None,
        'subscription_count': Subscription.query.count(),
        'active_timers': Timer.query.filter(Timer.notified == False).count()
    })

@app.route('/subscribe', methods=['POST'])
def subscribe():
    try:
        data = request.json
        subscription_json = json.dumps(data['subscription'])
        
        logger.info(f"收到订阅请求，端点: {data['subscription']['endpoint'][:50]}...")
        
        # 检查是否已存在
        existing_sub = Subscription.query.filter_by(subscription_json=subscription_json).first()
        if existing_sub:
            logger.info("订阅已存在，返回现有ID")
            return jsonify({'status': 'exists', 'id': existing_sub.id}), 200

        new_sub = Subscription(subscription_json=subscription_json)
        db.session.add(new_sub)
        db.session.commit()
        
        logger.info(f"新订阅创建成功，ID: {new_sub.id}")
        return jsonify({'status': 'success', 'id': new_sub.id}), 201
        
    except Exception as e:
        logger.error(f"订阅处理错误: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/start_timer', methods=['POST'])
def start_timer():
    try:
        data = request.json
        minutes = int(data['minutes'])
        subscription_data = data['subscription']
        
        logger.info(f"开始计时器请求: {minutes} 分钟")
        
        # 记录调试信息
        if request.headers.get('X-Debug'):
            logger.debug(f"完整订阅数据: {json.dumps(subscription_data, indent=2)}")
        
        # 通过 endpoint 查找订阅
        subscription_endpoint = subscription_data['endpoint']
        sub_info = Subscription.query.filter(
            Subscription.subscription_json.contains(subscription_endpoint)
        ).first()

        if not sub_info:
            logger.warning(f"未找到订阅: {subscription_endpoint}")
            return jsonify({'status': 'error', 'message': 'Subscription not found'}), 404

        expiry_time = datetime.utcnow() + timedelta(minutes=minutes)
        message = data.get('message', f'您的 {minutes} 分钟计时器已完成！')
        
        new_timer = Timer(
            subscription_id=sub_info.id, 
            expiry_time=expiry_time, 
            message=message
        )
        db.session.add(new_timer)
        db.session.commit()
        
        logger.info(f"计时器创建成功: ID={new_timer.id}, 到期时间={expiry_time}")
        
        # 如果是调试模式，立即发送测试推送
        if request.headers.get('X-Debug'):
            try:
                send_notification(sub_info.subscription_json, "[测试] " + message)
                logger.info("调试推送已发送")
            except Exception as e:
                logger.error(f"调试推送失败: {str(e)}")
        
        return jsonify({
            'status': 'success', 
            'message': f'Timer set for {minutes} minutes.',
            'timer_id': new_timer.id,
            'expiry_time': expiry_time.isoformat()
        })
        
    except Exception as e:
        logger.error(f"计时器创建错误: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/test_push', methods=['POST'])
def test_push():
    """立即测试推送"""
    try:
        data = request.json
        subscription_info = data.get('subscription')
        message = data.get('message', '测试推送消息')
        
        if not subscription_info:
            return jsonify({'error': 'No subscription provided'}), 400
        
        # 查找对应的订阅记录
        subscription_endpoint = subscription_info['endpoint']
        sub_record = Subscription.query.filter(
            Subscription.subscription_json.contains(subscription_endpoint)
        ).first()
        
        if not sub_record:
            return jsonify({'error': 'Subscription not found in database'}), 404
        
        # 发送测试推送
        send_notification(sub_record.subscription_json, message)
        
        return jsonify({'status': 'success', 'message': '测试推送已发送'})
        
    except Exception as e:
        logger.error(f"测试推送错误: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/debug/subscriptions')
def debug_subscriptions():
    """调试端点：显示所有订阅"""
    subscriptions = Subscription.query.all()
    result = []
    for sub in subscriptions:
        result.append({
            'id': sub.id,
            'created_at': sub.created_at.isoformat(),
            'endpoint': json.loads(sub.subscription_json)['endpoint'],
            'timer_count': len(sub.timers)
        })
    return jsonify(result)

@app.route('/debug/timers')
def debug_timers():
    """调试端点：显示所有计时器"""
    timers = Timer.query.all()
    result = []
    for timer in timers:
        result.append({
            'id': timer.id,
            'message': timer.message,
            'expiry_time': timer.expiry_time.isoformat(),
            'notified': timer.notified,
            'created_at': timer.created_at.isoformat(),
            'subscription_id': timer.subscription_id
        })
    return jsonify(result)

# --- 背景计时与推送任务 ---
def send_notification(subscription_info, message):
    """发送推送通知"""
    if not VAPID_PRIVATE_KEY:
        logger.error("VAPID 私钥未配置，无法发送推送")
        return
        
    try:
        logger.info(f"发送推送消息: {message}")
        
        webpush(
            subscription_info=json.loads(subscription_info),
            data=json.dumps({
                "title": "食谱计时器",
                "body": message,
                "icon": "https://i.imgur.com/KNFdYyR.png"
            }),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=VAPID_CLAIMS.copy(),
            timeout=10  # 10秒超时
        )
        logger.info("推送发送成功")
        
    except WebPushException as ex:
        logger.error(f"推送异常: {ex}")
        if ex.response and ex.response.status_code == 410:
            logger.info("订阅已失效，正在删除...")
            # 如果订阅已失效 (410 Gone)，从数据库删除
            sub_to_delete = Subscription.query.filter_by(subscription_json=subscription_info).first()
            if sub_to_delete:
                # 先删除相关的计时器
                Timer.query.filter_by(subscription_id=sub_to_delete.id).delete()
                db.session.delete(sub_to_delete)
                db.session.commit()
                logger.info("失效订阅已删除")
        else:
            logger.error(f"推送发送错误: {ex}")
    except Exception as ex:
        logger.error(f"推送发送未知错误: {ex}")

def check_timers():
    """检查到期计时器"""
    with app.app_context():
        try:
            now = datetime.utcnow()
            logger.info(f"检查计时器 at {now}")
            
            due_timers = Timer.query.filter(
                Timer.expiry_time <= now, 
                Timer.notified == False
            ).all()
            
            logger.info(f"找到 {len(due_timers)} 个到期计时器")
            
            for timer in due_timers:
                logger.info(f"处理计时器 ID {timer}: {timer.message}")
                try:
                    send_notification(timer.subscription.subscription_json, timer.message)
                    timer.notified = True
                    logger.info(f"计时器 {timer.id} 已通知")
                except Exception as e:
                    logger.error(f"处理计时器 {timer.id} 错误: {str(e)}")
            
            db.session.commit()
            
        except Exception as e:
            logger.error(f"检查计时器任务错误: {str(e)}")

# --- 启动应用 ---
with app.app_context():
    db.create_all()
    logger.info("数据库表创建完成")

# 每 30 秒检查一次是否有计时器到期
scheduler.add_job(check_timers, 'interval', seconds=30)
scheduler.start()
logger.info("计时器调度器启动")

if __name__ == '__main__':
    app.run(debug=True, use_reloader=False)
