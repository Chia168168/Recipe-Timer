import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException

# ==============================================================================
# --- 1. 初始化與設定 ---
# ==============================================================================
app = Flask(__name__, static_folder='static')

# 從環境變數讀取設定
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# [修正] 增加資料庫連線池設定，解決閒置連線中斷問題
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    "pool_pre_ping": True,
}

VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {
    "sub": "mailto:your-email@example.com" # 建議改成您自己的 Email
}

db = SQLAlchemy(app)
scheduler = BackgroundScheduler(daemon=True)

# ==============================================================================
# --- 2. 資料庫模型 (Database Models) ---
# ==============================================================================
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

# ==============================================================================
# --- 3. API 端點 (Routes) ---
# ==============================================================================

# --- 前端靜態檔案路由 ---
@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

# --- 功能 API 路由 ---
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

@app.route('/api/timers/cancel_all', methods=['POST'])
def cancel_all_timers():
    data = request.json
    sub_endpoint = data['subscription']['endpoint']
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(sub_endpoint)).first()
    if sub_info:
        Timer.query.filter_by(subscription_id=sub_info.id, notified=False).delete()
        db.session.commit()
        return jsonify({'status': 'success'})
    return jsonify({'status': 'error', 'message': 'Subscription not found'}), 404

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
        # 只有尚未過期或剛過期但還沒被背景任務標記為 notified 的計時器才需要顯示
        if not timer.notified:
            status = 'completed' if now > timer.expiry_time else 'running'
            timers_data.append({
                "id": timer.id,
                "client_id": timer.client_id,
                "expiry_time": timer.expiry_time.isoformat() + 'Z',
                "status": status
            })
    return jsonify(timers_data)

# ==============================================================================
# --- 4. 背景任務 (Background Task) ---
# ==============================================================================
def send_notification(subscription_json_str, message):
    try:
        subscription_info = json.loads(subscription_json_str)
        webpush(
            subscription_info=subscription_info,
            data=message,
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims=VAPID_CLAIMS.copy()
        )
        print(f"Notification sent successfully for message: {message}")
    except WebPushException as ex:
        print(f"WebPushException: {ex}")
        if ex.response and ex.response.status_code == 410:
            print("Subscription is gone or expired. Deleting...")
            sub_to_delete = Subscription.query.filter_by(subscription_json=subscription_json_str).first()
            if sub_to_delete:
                db.session.delete(sub_to_delete)
                db.session.commit()
                print("Subscription deleted.")

def check_timers():
    with app.app_context():
        now = datetime.utcnow()
        due_timers = Timer.query.filter(Timer.expiry_time <= now, Timer.notified == False).all()
        
        if due_timers:
            print(f"Found {len(due_timers)} due timers to process.")
            for timer in due_timers:
                send_notification(timer.subscription.subscription_json, timer.message)
                timer.notified = True
            db.session.commit()
            print("Finished processing due timers.")

# ==============================================================================
# --- 5. 啟動應用 ---
# ==============================================================================
with app.app_context():
    db.create_all()

# 設定排程器每 30 秒執行一次 check_timers 任務
scheduler.add_job(check_timers, 'interval', seconds=30)
scheduler.start()

# Gunicorn 在 Render 上會直接執行 'app' 這個實例，所以這段主要用於本地測試
if __name__ == '__main__':
    # use_reloader=False 是為了避免 APScheduler 在本地 debug 模式下執行兩次
    app.run(debug=True, use_reloader=False)
