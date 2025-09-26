import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException
import logging
import traceback

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 初始化 Flask 应用
app = Flask(__name__, static_folder='static')

# 数据库配置
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

# 数据库模型 - 简化版本
class Subscription(db.Model):
    __tablename__ = 'subscription'
    
    id = db.Column(db.Integer, primary_key=True)
    endpoint = db.Column(db.Text)  # 使用Text类型避免长度限制
    subscription_json = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Timer(db.Model):
    __tablename__ = 'timer'
    
    id = db.Column(db.Integer, primary_key=True)
    subscription_id = db.Column(db.Integer)
    expiry_time = db.Column(db.DateTime)
    message = db.Column(db.Text)
    notified = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

# 数据库连接检查
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

# 订阅端点 - 详细错误处理
@app.route('/subscribe', methods=['POST'])
def subscribe():
    try:
        logger.info("=== 开始处理订阅请求 ===")
        
        # 检查请求数据
        if not request.data:
            logger.error("请求体为空")
            return jsonify({'error': '请求体为空'}), 400
            
        data = request.get_json()
        if not data:
            logger.error("JSON解析失败")
            return jsonify({'error': '无效的JSON数据'}), 400
        
        logger.info(f"收到数据: {json.dumps(data)[:200]}...")
        
        if 'subscription' not in data:
            logger.error("缺少subscription字段")
            return jsonify({'error': '缺少订阅数据'}), 400
        
        sub_data = data['subscription']
        endpoint = sub_data.get('endpoint', '')
        
        if not endpoint:
            logger.error("订阅数据缺少endpoint")
            return jsonify({'error': '无效的订阅数据'}), 400
        
        # 检查数据库连接
        if not check_db():
            logger.error("数据库连接失败")
            return jsonify({'error': '数据库连接失败'}), 500
        
        # 检查是否已存在
        logger.info(f"查找现有订阅: {endpoint[:50]}...")
        existing = Subscription.query.filter_by(endpoint=endpoint).first()
        if existing:
            logger.info("订阅已存在，返回现有ID")
            return jsonify({'status': 'exists', 'id': existing.id})
        
        # 创建新订阅
        logger.info("创建新订阅记录")
        new_sub = Subscription(
            endpoint=endpoint,
            subscription_json=json.dumps(sub_data, ensure_ascii=False)
        )
        
        db.session.add(new_sub)
        db.session.commit()
        
        logger.info(f"订阅创建成功，ID: {new_sub.id}")
        return jsonify({'status': 'success', 'id': new_sub.id})
        
    except Exception as e:
        logger.error(f"订阅处理错误: {str(e)}")
        logger.error(f"错误类型: {type(e)}")
        logger.error(f"错误堆栈: {traceback.format_exc()}")
        
        # 尝试回滚
        try:
            db.session.rollback()
        except Exception as rollback_error:
            logger.error(f"回滚失败: {rollback_error}")
            
        return jsonify({'error': '服务器内部错误'}), 500

# 其他端点保持不变
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
        db.session.rollback()
        return jsonify({'error': '服务器错误'}), 500

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

# 调试端点
@app.route('/debug/tables')
def debug_tables():
    try:
        from sqlalchemy import inspect
        inspector = inspect(db.engine)
        tables = inspector.get_table_names()
        
        result = {'tables': tables}
        
        if 'subscription' in tables:
            result['subscription_columns'] = [
                {'name': col['name'], 'type': str(col['type'])} 
                for col in inspector.get_columns('subscription')
            ]
            
        if 'timer' in tables:
            result['timer_columns'] = [
                {'name': col['name'], 'type': str(col['type'])} 
                for col in inspector.get_columns('timer')
            ]
            
        return jsonify(result)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

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
            logger.info("数据库表创建完成")
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
    logger.error("应用启动失败")

if __name__ == '__main__':
    app.run(debug=False)
