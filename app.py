import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException
import logging

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 初始化 Flask 应用
app = Flask(__name__, static_folder='static')

# 数据库配置 - 简化版本
database_url = os.environ.get('DATABASE_URL', '')
if database_url.startswith('postgres://'):
    database_url = database_url.replace('postgres://', 'postgresql://', 1)

app.config['SQLALCHEMY_DATABASE_URI'] = database_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# VAPID 配置
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {"sub": "mailto:test@example.com"}

# 初始化数据库
db = SQLAlchemy(app)

# 数据库模型
class Subscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    endpoint = db.Column(db.String(500))
    subscription_json = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Timer(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_id = db.Column(db.Integer)
    expiry_time = db.Column(db.DateTime)
    message = db.Column(db.String(200))
    notified = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

# 简单的数据库连接检查
def check_db():
    try:
        db.session.execute("SELECT 1")
        return True
    except Exception as e:
        logger.error(f"数据库连接失败: {e}")
        return False

# 健康检查端点
@app.route('/health')
def health():
    db_ok = check_db()
    return jsonify({
        'status': 'ok' if db_ok else 'error',
        'database_connected': db_ok,
        'vapid_configured': bool(VAPID_PRIVATE_KEY),
        'timestamp': datetime.utcnow().isoformat()
    })

# 订阅端点
@app.route('/subscribe', methods=['POST'])
def subscribe():
    try:
        data = request.get_json()
        if not data or 'subscription' not in data:
            return jsonify({'error': '无效数据'}), 400
        
        sub_data = data['subscription']
        endpoint = sub_data.get('endpoint', '')
        
        if not endpoint:
            return jsonify({'error': '无效订阅'}), 400
        
        # 检查是否已存在
        existing = Subscription.query.filter_by(endpoint=endpoint).first()
        if existing:
            return jsonify({'status': 'exists', 'id': existing.id})
        
        # 创建新订阅
        new_sub = Subscription(
            endpoint=endpoint,
            subscription_json=json.dumps(sub_data)
        )
        db.session.add(new_sub)
        db.session.commit()
        
        return jsonify({'status': 'success', 'id': new_sub.id})
        
    except Exception as e:
        logger.error(f"订阅错误: {e}")
        return jsonify({'error': '服务器错误'}), 500

# 开始计时器
@app.route('/start_timer', methods=['POST'])
def start_timer():
    try:
        data = request.get_json()
        minutes = int(data.get('minutes', 0))
        sub_data = data.get('subscription', {})
        message = data.get('message', '计时完成!')
        
        endpoint = sub_data.get('endpoint', '')
        if not endpoint:
            return jsonify({'error': '无效订阅'}), 400
        
        # 查找或创建订阅
        sub = Subscription.query.filter_by(endpoint=endpoint).first()
        if not sub:
            sub = Subscription(
                endpoint=endpoint,
                subscription_json=json.dumps(sub_data)
            )
            db.session.add(sub)
            db.session.flush()
        
        # 创建计时器
        expiry = datetime.utcnow() + timedelta(minutes=minutes)
        timer = Timer(
            subscription_id=sub.id,
            expiry_time=expiry,
            message=message
        )
        db.session.add(timer)
        db.session.commit()
        
        return jsonify({
            'status': 'success',
            'timer_id': timer.id,
            'expiry_time': expiry.isoformat()
        })
        
    except Exception as e:
        logger.error(f"计时器错误: {e}")
        return jsonify({'error': '服务器错误'}), 500

# 测试推送
@app.route('/test_push', methods=['POST'])
def test_push():
    try:
        data = request.get_json()
        sub_data = data.get('subscription', {})
        message = data.get('message', '测试消息')
        
        if not sub_data:
            return jsonify({'error': '无订阅数据'}), 400
        
        # 发送推送
        send_push(sub_data, message)
        return jsonify({'status': 'success'})
        
    except Exception as e:
        logger.error(f"推送测试错误: {e}")
        return jsonify({'error': '推送失败'}), 500

# 推送函数
def send_push(subscription, message):
    if not VAPID_PRIVATE_KEY:
        logger.error("VAPID 密钥未配置")
        return
    
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps({
                "title": "食谱计时器",
                "body": message,
                "icon": "https://i.imgur.com/KNFdYyR.png"
            }),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=VAPID_CLAIMS
        )
        logger.info("推送发送成功")
    except Exception as e:
        logger.error(f"推送错误: {e}")

# 静态文件服务
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

# 计时器检查任务
def check_timers():
    with app.app_context():
        try:
            if not check_db():
                return
                
            now = datetime.utcnow()
            timers = Timer.query.filter(
                Timer.expiry_time <= now,
                Timer.notified == False
            ).all()
            
            for timer in timers:
                try:
                    sub = Subscription.query.get(timer.subscription_id)
                    if sub:
                        sub_data = json.loads(sub.subscription_json)
                        send_push(sub_data, timer.message)
                        timer.notified = True
                except Exception as e:
                    logger.error(f"处理计时器 {timer.id} 错误: {e}")
            
            db.session.commit()
            
        except Exception as e:
            logger.error(f"计时器检查错误: {e}")

# 初始化数据库
def init_db():
    try:
        with app.app_context():
            db.create_all()
            logger.info("数据库初始化完成")
            return True
    except Exception as e:
        logger.error(f"数据库初始化失败: {e}")
        return False

# 启动应用
if init_db():
    scheduler = BackgroundScheduler()
    scheduler.add_job(check_timers, 'interval', seconds=30)
    scheduler.start()
    logger.info("应用启动完成")
else:
    logger.error("应用启动失败 - 数据库问题")

if __name__ == '__main__':
    app.run(debug=False)
