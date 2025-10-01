import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException

# --- 1. 初始化與設定 ---
app = Flask(__name__, static_folder='static')
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {"pool_pre_ping": True}

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {"sub": "mailto:your-email@example.com"}

db = SQLAlchemy(app)
scheduler = BackgroundScheduler(daemon=True)

# --- 2. 資料庫模型 ---
class Subscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_json = db.Column(db.Text, nullable=False, unique=True)

class Timer(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_id = db.Column(db.Integer, db.ForeignKey('subscription.id'), nullable=False)
    client_id = db.Column(db.String(100), nullable=False) 
    expiry_time = db.Column(db.DateTime, nullable=False)
    message = db.Column(db.String(200), nullable=False)
    notified = db.Column(db.Boolean, default=False, nullable=False)
    subscription = db.relationship('Subscription', backref=db.backref('timers', lazy=True, cascade="all, delete-orphan"))

# --- 3. API 端點 ---
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

@app.route('/subscribe', methods=['POST'])
def subscribe():
    # ... 內容不變 ...
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
    # ... 內容不變 ...
    data = request.json
    sub_endpoint = data['subscription']['endpoint']
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(sub_endpoint)).first()
    if not sub_info: return jsonify({'status': 'error', 'message': 'Subscription not found'}), 404
    
    existing_timer = Timer.query.filter_by(subscription_id=sub_info.id, client_id=data['client_id']).first()
    if existing_timer:
        db.session.delete(existing_timer)
    
    expiry_time = datetime.utcnow() + timedelta(minutes=int(data['minutes']))
    new_timer = Timer(
        subscription_id=sub_info.id,
        client_id=data['client_id'],
        expiry_time=expiry_time,
        message=data['message'],
        notified=False # 確保新計時器是未通知狀態
    )
    db.session.add(new_timer)
    db.session.commit()
    return jsonify({'status': 'success', 'timer_id': new_timer.id})

@app.route('/api/timers/cancel', methods=['POST'])
def cancel_timer():
    # ... 內容不變 ...
    data = request.json
    timer_id_to_cancel = data.get('timer_id')
    timer_to_delete = Timer.query.get(timer_id_to_cancel)
    if timer_to_delete:
        db.session.delete(timer_to_delete)
        db.session.commit()
        return jsonify({'status': 'success'})
    return jsonify({'status': 'error', 'message': 'Timer not found'}), 404

@app.route('/api/timers/cancel_all', methods=['POST'])
def cancel_all_timers():
    # [修改] 刪除所有計時器，無論狀態為何
    data = request.json
    sub_endpoint = data['subscription']['endpoint']
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(sub_endpoint)).first()
    if sub_info:
        Timer.query.filter_by(subscription_id=sub_info.id).delete()
        db.session.commit()
        return jsonify({'status': 'success'})
    return jsonify({'status': 'error', 'message': 'Subscription not found'}), 404

@app.route('/api/timers', methods=['GET'])
def get_timers():
    # [修改] 回傳所有未刪除的計時器，讓前端決定如何顯示
    endpoint = request.args.get('endpoint')
    if not endpoint: return jsonify({"error": "Endpoint is required"}), 400
    
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(endpoint)).first()
    if not sub_info: return jsonify([])

    timers = Timer.query.filter_by(subscription_id=sub_info.id).all()
    now = datetime.utcnow()
    
    timers_data = []
    for timer in timers:
        # 即使已通知，只要還在資料庫裡，就回傳給前端
        status = 'completed' if timer.notified or now > timer.expiry_time else 'running'
        timers_data.append({
            "id": timer.id,
            "client_id": timer.client_id,
            "expiry_time": timer.expiry_time.isoformat() + 'Z',
            "status": status
        })
    return jsonify(timers_data)

# --- 4. 背景任務 ---
def send_notification(subscription_json_str, message):
    # ... 內容不變 ...
    try:
        subscription_info = json.loads(subscription_json_str)
        webpush(subscription_info=subscription_info, data=message, vapid_private_key=VAPID_PRIVATE_KEY, vapid_claims=VAPID_CLAIMS.copy())
        print(f"Notification sent successfully for message: {message}")
    except WebPushException as ex:
        print(f"WebPushException: {ex}")
        if ex.response and ex.response.status_code == 410:
            sub_to_delete = Subscription.query.filter_by(subscription_json=subscription_json_str).first()
            if sub_to_delete: db.session.delete(sub_to_delete); db.session.commit()

def check_timers():
    # ... 內容不變 ...
    with app.app_context():
        now = datetime.utcnow()
        due_timers = Timer.query.filter(Timer.expiry_time <= now, Timer.notified == False).all()
        if due_timers:
            for timer in due_timers:
                send_notification(timer.subscription.subscription_json, timer.message)
                timer.notified = True
            db.session.commit()

# --- 5. 啟動應用 ---
with app.app_context():
    db.create_all()

# [修改] 加快檢查頻率
scheduler.add_job(check_timers, 'interval', seconds=10)
scheduler.start()

if __name__ == '__main__':
    app.run(debug=True, use_reloader=False)

