import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException

# --- 初始化設定 ---
app = Flask(__name__, static_folder='static')
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {"pool_pre_ping": True}

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {"sub": "mailto:your-email@example.com"}

db = SQLAlchemy(app)
scheduler = BackgroundScheduler(daemon=True)

# --- 資料庫模型 ---
class Subscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_json = db.Column(db.Text, nullable=False, unique=True)

class Timer(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_id = db.Column(db.Integer, db.ForeignKey('subscription.id'), nullable=False)
    # 新增一個 client_id 來對應前端的步驟
    client_id = db.Column(db.String(100), nullable=False) 
    expiry_time = db.Column(db.DateTime, nullable=False)
    message = db.Column(db.String(200), nullable=False)
    notified = db.Column(db.Boolean, default=False, nullable=False)
    subscription = db.relationship('Subscription', backref=db.backref('timers', lazy=True, cascade="all, delete-orphan"))

# --- API 端點 ---
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/subscribe', methods=['POST'])
def subscribe():
    data = request.json
    subscription_json = json.dumps(data['subscription'])
    existing_sub = Subscription.query.filter_by(subscription_json=subscription_json).first()
    if not existing_sub:
        new_sub = Subscription(subscription_json=subscription_json)
        db.session.add(new_sub)
        db.session.commit()
    return jsonify({'status': 'success'}), 201

@app.route('/start_timer', methods=['POST'])
def start_timer():
    data = request.json
    sub_endpoint = data['subscription']['endpoint']
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(sub_endpoint)).first()
    if not sub_info: return jsonify({'status': 'error', 'message': 'Subscription not found'}), 404
    
    # 如果同一個步驟的計時器已存在，先刪除舊的
    existing_timer = Timer.query.filter_by(subscription_id=sub_info.id, client_id=data['client_id']).first()
    if existing_timer:
        db.session.delete(existing_timer)
        db.session.commit()

    expiry_time = datetime.utcnow() + timedelta(minutes=int(data['minutes']))
    new_timer = Timer(
        subscription_id=sub_info.id,
        client_id=data['client_id'],
        expiry_time=expiry_time,
        message=data['message']
    )
    db.session.add(new_timer)
    db.session.commit()
    return jsonify({'status': 'success', 'timer_id': new_timer.id})

# [新功能] 取消單一計時器
@app.route('/api/timers/cancel', methods=['POST'])
def cancel_timer():
    data = request.json
    timer_id_to_cancel = data.get('timer_id')
    timer_to_delete = Timer.query.get(timer_id_to_cancel)
    if timer_to_delete:
        db.session.delete(timer_to_delete)
        db.session.commit()
        return jsonify({'status': 'success'})
    return jsonify({'status': 'error', 'message': 'Timer not found'}), 404

# [新功能] 取消所有計時器
@app.route('/api/timers/cancel_all', methods=['POST'])
def cancel_all_timers():
    data = request.json
    sub_endpoint = data['subscription']['endpoint']
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(sub_endpoint)).first()
    if sub_info:
        Timer.query.filter_by(subscription_id=sub_info.id).delete()
        db.session.commit()
        return jsonify({'status': 'success'})
    return jsonify({'status': 'error', 'message': 'Subscription not found'}), 404

# [優化] 查詢計時器 API
@app.route('/api/timers', methods=['GET'])
def get_timers():
    endpoint = request.args.get('endpoint')
    if not endpoint: return jsonify({"error": "Endpoint is required"}), 400
    
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(endpoint)).first()
    if not sub_info: return jsonify([])

    timers = Timer.query.filter_by(subscription_id=sub_info.id).all()
    now = datetime.utcnow()
    
    timers_data = []
    for timer in timers:
        status = 'completed' if timer.notified or now > timer.expiry_time else 'running'
        timers_data.append({
            "id": timer.id,
            "client_id": timer.client_id,
            "expiry_time": timer.expiry_time.isoformat() + 'Z',
            "status": status
        })
    return jsonify(timers_data)

# ... 其他函式和背景任務不變 (除了 check_timers 查詢邏輯微調)
@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

def send_notification(subscription_info, message):
    try:
        webpush(
            subscription_info=json.loads(subscription_info),
            data=message,
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=VAPID_CLAIMS.copy()
        )
        print("Notification sent successfully.")
    except WebPushException as ex:
        print(f"WebPushException: {ex}")
        if ex.response and ex.response.status_code == 410:
            print("Subscription is gone. Deleting...")
            # 如果訂閱已失效 (410 Gone)，從資料庫刪除
            sub_to_delete = Subscription.query.filter_by(subscription_json=json.dumps(subscription_info)).first()
            if sub_to_delete:
                db.session.delete(sub_to_delete)
                db.session.commit()
        else:
            print("An error occurred when sending notification.")
def check_timers():
    with app.app_context():
        now = datetime.utcnow()
        due_timers = Timer.query.filter(Timer.expiry_time <= now, Timer.notified == False).all()
        for timer in due_timers:
            send_notification(json.loads(timer.subscription.subscription_json), timer.message)
            timer.notified = True
        db.session.commit()

# --- 啟動應用 ---
with app.app_context():
    db.create_all()
scheduler.add_job(check_timers, 'interval', seconds=30)
scheduler.start()
# The rest of the original file (send_notification, if __name__ == '__main__') remains the same
