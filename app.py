import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException
import logging
import time
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.exc import OperationalError, DisconnectionError

# 配置日志
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# --- 初始化设定 ---
app = Flask(__name__, static_folder='static')

# 从环境变量读取设定 - 修复数据库URL格式
database_url = os.environ.get('DATABASE_URL')
if database_url and database_url.startswith('postgres://'):
    database_url = database_url.replace('postgres://', 'postgresql://', 1)

app.config['SQLALCHEMY_DATABASE_URI'] = database_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_recycle': 300,
    'pool_pre_ping': True,
    'pool_size': 5,
    'max_overflow': 10
}

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {
    "sub": "mailto:your-email@example.com"  # 请改成您的实际邮箱
}

# 数据库重试机制
def get_db_connection(max_retries=3, retry_delay=1):
    for attempt in range(max_retries):
        try:
            db.session.execute('SELECT 1')
            return True
        except (OperationalError, DisconnectionError) as e:
            logger.warning(f"数据库连接失败，尝试 {attempt + 1}/{max_retries}: {e}")
            if attempt < max_retries - 1:
                time.sleep(retry_delay)
                continue
            else:
                logger.error("数据库连接最终失败")
                return False

db = SQLAlchemy(app)
scheduler = BackgroundScheduler(daemon=True)

# --- 数据库模型 ---
class Subscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    endpoint = db.Column(db.String(500), unique=True, nullable=False)  # 添加唯一索引
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

# 数据库健康检查中间件
@app.before_request
def check_db_connection():
    if request.endpoint and request.endpoint not in ['static', 'health']:
        if not get_db_connection():
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500

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
    """健康检查端点 - 简化版本避免数据库查询"""
    try:
        # 简单的数据库连接测试，不进行复杂查询
        db.session.execute('SELECT 1')
        db_connected = True
    except:
        db_connected = False
        
    return jsonify({
        'status': 'healthy' if db_connected else 'degraded',
        'timestamp': datetime.utcnow().isoformat(),
        'vapid_configured': bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY),
        'database_connected': db_connected
    })

@app.route('/subscribe', methods=['POST'])
def subscribe():
    try:
        if not get_db_connection():
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500
            
        data = request.json
        if not data or 'subscription' not in data:
            return jsonify({'status': 'error', 'message': 'Invalid request data'}), 400
            
        subscription_data = data['subscription']
        endpoint = subscription_data.get('endpoint', '')
        
        if not endpoint:
            return jsonify({'status': 'error', 'message': 'Invalid subscription data'}), 400
            
        subscription_json = json.dumps(subscription_data)
        
        logger.info(f"收到订阅请求，端点: {endpoint[:50]}...")
        
        # 使用 endpoint 作为唯一标识进行查找
        existing_sub = Subscription.query.filter_by(endpoint=endpoint).first()
        if existing_sub:
            logger.info("订阅已存在，返回现有ID")
            return jsonify({'status': 'exists', 'id': existing_sub.id}), 200

        new_sub = Subscription(endpoint=endpoint, subscription_json=subscription_json)
        db.session.add(new_sub)
        db.session.commit()
        
        logger.info(f"新订阅创建成功，ID: {new_sub.id}")
        return jsonify({'status': 'success', 'id': new_sub.id}), 201
        
    except Exception as e:
        logger.error(f"订阅处理错误: {str(e)}")
        db.session.rollback()
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500

@app.route('/start_timer', methods=['POST'])
def start_timer():
    try:
        if not get_db_connection():
            return jsonify({'status': 'error', 'message': '数据库连接失败'}), 500
            
        data = request.json
        if not data:
            return jsonify({'status': 'error', 'message': 'No data provided'}), 400
            
        minutes = int(data.get('minutes', 0))
        subscription_data = data.get('subscription')
        
        if not subscription_data:
            return jsonify({'status': 'error', 'message': 'No subscription provided'}), 400
            
        logger.info(f"开始计时器请求: {minutes} 分钟")
        
        # 使用 endpoint 查找订阅
        endpoint = subscription_data.get('endpoint', '')
        if not endpoint:
            return jsonify({'status': 'error', 'message': 'Invalid subscription data'}), 400
            
        sub_info = Subscription.query.filter_by(endpoint=endpoint).first()

        if not sub_info:
            logger.warning(f"未找到订阅: {endpoint}")
            # 创建新订阅
            subscription_json = json.dumps(subscription_data)
            new_sub = Subscription(endpoint=endpoint, subscription_json=subscription_json)
            db.session.add(new_sub)
            db.session.flush()
            sub_info = new_sub
            logger.info(f"创建了新订阅: {new_sub.id}")

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
        
        return jsonify({
            'status': 'success', 
            'message': f'Timer set for {minutes} minutes.',
            'timer_id': new_timer.id,
            'expiry_time': expiry_time.isoformat()
        })
        
    except Exception as e:
        logger.error(f"计时器创建错误: {str(e)}")
        db.session.rollback()
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500

@app.route('/test_push', methods=['POST'])
def test_push():
    """立即测试推送 - 简化版本"""
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'No data provided'}), 400
            
        subscription_info = data.get('subscription')
        message = data.get('message', '测试推送消息')
        
        if not subscription_info:
            return jsonify({'error': 'No subscription provided'}), 400
        
        # 直接使用提供的订阅信息，不查询数据库
        subscription_json = json.dumps(subscription_info)
        
        # 发送测试推送
        send_notification(subscription_json, message)
        
        return jsonify({'status': 'success', 'message': '测试推送已发送'})
        
    except Exception as e:
        logger.error(f"测试推送错误: {str(e)}")
        return jsonify({'error': '推送发送失败'}), 500

# 简化的调试端点，避免复杂查询
@app.route('/debug/status')
def debug_status():
    """简化的状态检查"""
    try:
        sub_count = db.session.execute('SELECT COUNT(*) FROM subscription').scalar()
        timer_count = db.session.execute('SELECT COUNT(*) FROM timer').scalar()
        
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

# --- 背景计时与推送任务 ---
def send_notification(subscription_info, message):
    """发送推送通知"""
    if not VAPID_PRIVATE_KEY:
        logger.error("VAPID 私钥未配置，无法发送推送")
        return
        
    try:
        logger.info(f"发送推送消息: {message}")
        
        # 确保订阅信息是字典
        if isinstance(subscription_info, str):
            try:
                subscription_info = json.loads(subscription_info)
            except json.JSONDecodeError:
                logger.error("无效的订阅JSON格式")
                return
                
        webpush(
            subscription_info=subscription_info,
            data=json.dumps({
                "title": "食谱计时器",
                "body": message,
                "icon": "https://i.imgur.com/KNFdYyR.png"
            }),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=VAPID_CLAIMS.copy(),
            timeout=10
        )
        logger.info("推送发送成功")
        
    except Exception as ex:
        logger.error(f"推送发送错误: {ex}")

def check_timers():
    """检查到期计时器 - 简化版本"""
    with app.app_context():
        try:
            if not get_db_connection():
                logger.error("数据库连接失败，跳过计时器检查")
                return
                
            now = datetime.utcnow()
            logger.info(f"检查计时器 at {now}")
            
            # 使用原始SQL查询避免复杂ORM操作
            due_timers = db.session.execute(
                "SELECT t.id, t.message, s.subscription_json " +
                "FROM timer t JOIN subscription s ON t.subscription_id = s.id " +
                "WHERE t.expiry_time <= :now AND t.notified = false",
                {'now': now}
            ).fetchall()
            
            logger.info(f"找到 {len(due_timers)} 个到期计时器")
            
            for timer in due_timers:
                logger.info(f"处理计时器 ID {timer.id}: {timer.message}")
                try:
                    send_notification(timer.subscription_json, timer.message)
                    # 标记为已通知
                    db.session.execute(
                        "UPDATE timer SET notified = true WHERE id = :id",
                        {'id': timer.id}
                    )
                    logger.info(f"计时器 {timer.id} 已通知")
                except Exception as e:
                    logger.error(f"处理计时器 {timer.id} 错误: {str(e)}")
            
            db.session.commit()
            
        except Exception as e:
            logger.error(f"检查计时器任务错误: {str(e)}")
            db.session.rollback()

# --- 启动应用 ---
def initialize_database():
    """初始化数据库"""
    max_retries = 3
    for attempt in range(max_retries):
        try:
            with app.app_context():
                db.create_all()
                logger.info("数据库表创建完成")
                return True
        except Exception as e:
            logger.error(f"数据库初始化失败 (尝试 {attempt + 1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                time.sleep(2)
                continue
            else:
                logger.error("数据库初始化最终失败")
                return False

if initialize_database():
    # 每 30 秒检查一次是否有计时器到期
    scheduler.add_job(check_timers, 'interval', seconds=30)
    scheduler.start()
    logger.info("计时器调度器启动")
else:
    logger.error("应用启动失败：数据库初始化失败")

if __name__ == '__main__':
    app.run(debug=True, use_reloader=False)
