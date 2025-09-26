import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException
import logging
import time

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- 初始化设定 ---
app = Flask(__name__, static_folder='static')

# 从环境变量读取设定 - 修复数据库URL格式
database_url = os.environ.get('DATABASE_URL', '').replace('postgres://', 'postgresql://', 1)
app.config['SQLALCHEMY_DATABASE_URI'] = database_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# 数据库连接配置
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_recycle': 300,
    'pool_pre_ping': True,
}

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {
    "sub": "mailto:your-email@example.com"
}

db = SQLAlchemy(app)

# --- 数据库模型 ---
class Subscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    endpoint = db.Column(db.String(500), unique=True, nullable=False)
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

# 数据库连接检查
def check_db_connection():
    try:
        db.session.execute('SELECT 1')
        return True
    except Exception as e:
        logger.error(f"数据库连接失败: {e}")
        return False

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
    db_connected = check_db_connection()
    
    return jsonify({
        'status': 'healthy' if db_connected else 'degraded',
        'timestamp': datetime.utcnow().isoformat(),
        'vapid_configured': bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY),
        'database_connected': db_connected
    })

@app.route('/subscribe', methods=['POST'])
def subscribe():
    try:
        if not check_db_connection():
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500
            
        data = request.get_json()
        if not data or 'subscription' not in data:
            return jsonify({'status': 'error', 'message': '无效的请求数据'}), 400
            
        subscription_data = data['subscription']
        endpoint = subscription_data.get('endpoint', '')
        
        if not endpoint:
            return jsonify({'status': 'error', 'message': '无效的订阅数据'}), 400
            
        subscription_json = json.dumps(subscription_data)
        
        logger.info(f"收到订阅请求: {endpoint[:50]}...")
        
        # 查找现有订阅
        existing_sub = Subscription.query.filter_by(endpoint=endpoint).first()
        if existing_sub:
            return jsonify({'status': 'exists', 'id': existing_sub.id}), 200

        new_sub = Subscription(endpoint=endpoint, subscription_json=subscription_json)
        db.session.add(new_sub)
        db.session.commit()
        
        return jsonify({'status': 'success', 'id': new_sub.id}), 201
        
    except Exception as e:
        logger.error(f"订阅处理错误: {e}")
        db.session.rollback()
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500

@app.route('/start_timer', methods=['POST'])
def start_timer():
    try:
        if not check_db_connection():
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500
            
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': '无数据提供'}), 400
            
        minutes = int(data.get('minutes', 0))
        subscription_data = data.get('subscription')
        
        if not subscription_data:
            return jsonify({'status': 'error', 'message': '无订阅提供'}), 400
            
        endpoint = subscription_data.get('endpoint', '')
        if not endpoint:
            return jsonify({'status': 'error', 'message': '无效的订阅数据'}), 400
            
        # 查找或创建订阅
        sub_info = Subscription.query.filter_by(endpoint=endpoint).first()
        if not sub_info:
            subscription_json = json.dumps(subscription_data)
            new_sub = Subscription(endpoint=endpoint, subscription_json=subscription_json)
            db.session.add(new_sub)
            db.session.flush()
            sub_info = new_sub

        expiry_time = datetime.utcnow() + timedelta(minutes=minutes)
        message = data.get('message', f'您的 {minutes} 分钟计时器已完成！')
        
        new_timer = Timer(
            subscription_id=sub_info.id, 
            expiry_time=expiry_time, 
            message=message
        )
        db.session.add(new_timer)
        db.session.commit()
        
        return jsonify({
            'status': 'success', 
            'message': f'Timer set for {minutes} minutes.',
            'timer_id': new_timer.id,
            'expiry_time': expiry_time.isoformat()
        })
        
    except Exception as e:
        logger.error(f"计时器创建错误: {e}")
        db.session.rollback()
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500

@app.route('/test_push', methods=['POST'])
def test_push():
    """立即测试推送"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': '无数据提供'}), 400
            
        subscription_info = data.get('subscription')
        message = data.get('message', '测试推送消息')
        
        if not subscription_info:
            return jsonify({'error': '无订阅提供'}), 400
        
        # 直接使用提供的订阅信息
        subscription_json = json.dumps(subscription_info)
        send_notification(subscription_json, message)
        
        return jsonify({'status': 'success', 'message': '测试推送已发送'})
        
    except Exception as e:
        logger.error(f"测试推送错误: {e}")
        return jsonify({'error': '推送发送失败'}), 500

# 简化的调试端点
@app.route('/debug/status')
def debug_status():
    """简化的状态检查"""
    try:
        sub_count = db.session.query(Subscription).count()
        timer_count = db.session.query(Timer).count()
        
        return jsonify({
            'subscriptions': sub_count,
            'timers': timer_count,
            'database_connected': True
        })
    except:
        return jsonify({
            'subscriptions': 0,
            'timers': 0,
            'database_connected': False
        })

# --- 推送功能 ---
def send_notification(subscription_info, message):
    """发送推送通知"""
    if not VAPID_PRIVATE_KEY:
        logger.error("VAPID 私钥未配置")
        return
        
    try:
        if isinstance(subscription_info, str):
            subscription_info = json.loads(subscription_info)
                
        webpush(
            subscription_info=subscription_info,
            data=json.dumps({
                "title": "食谱计时器",
                "body": message,
                "icon": "https://i.imgur.com/KNFdYyR.png"
            }),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=VAPID_CLAIMS
        )
        logger.info("推送发送成功")
        
    except Exception as ex:
        logger.error(f"推送发送错误: {ex}")

def check_timers():
    """检查到期计时器"""
    with app.app_context():
        try:
            if not check_db_connection():
                return
                
            now = datetime.utcnow()
            due_timers = Timer.query.filter(
                Timer.expiry_time <= now, 
                Timer.notified == False
            ).all()
            
            for timer in due_timers:
                try:
                    send_notification(timer.subscription.subscription_json, timer.message)
                    timer.notified = True
                except Exception as e:
                    logger.error(f"处理计时器错误: {e}")
            
            db.session.commit()
            
        except Exception as e:
            logger.error(f"检查计时器任务错误: {e}")

# --- 启动应用 ---
def initialize_app():
    """初始化应用"""
    try:
        with app.app_context():
            db.create_all()
            logger.info("数据库初始化完成")
            
            # 启动调度器
            scheduler = BackgroundScheduler(daemon=True)
            scheduler.add_job(check_timers, 'interval', seconds=30)
            scheduler.start()
            logger.info("调度器启动完成")
            
            return True
    except Exception as e:
        logger.error(f"应用初始化失败: {e}")
        return False

# 应用启动
if initialize_app():
    logger.info("应用启动成功")
else:
    logger.error("应用启动失败")

if __name__ == '__main__':
    app.run(debug=False)
