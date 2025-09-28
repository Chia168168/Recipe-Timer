import os
import json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException

# --- 初始化設定 ---
app = Flask(__name__, static_folder='static')

# 從環境變數讀取設定 (Render 會提供這些)
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    "pool_pre_ping": True,
}


VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY')
VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY')
VAPID_CLAIMS = {
    "sub": "mailto:your-email@example.com" # 請改成您的 Email
}

db = SQLAlchemy(app)
scheduler = BackgroundScheduler(daemon=True)

# --- 資料庫模型 ---
class Subscription(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_json = db.Column(db.Text, nullable=False)

class Timer(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    subscription_id = db.Column(db.Integer, db.ForeignKey('subscription.id'), nullable=False)
    expiry_time = db.Column(db.DateTime, nullable=False)
    message = db.Column(db.String(200), nullable=False)
    notified = db.Column(db.Boolean, default=False, nullable=False)
    subscription = db.relationship('Subscription', backref=db.backref('timers', lazy=True))

# --- API 端點 (修正後) ---
@app.route('/')
def index():
    # 主頁面路由
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/subscribe', methods=['POST'])
def subscribe():
    # 訂閱 API 路由 (優先匹配)
    data = request.json
    subscription_json = json.dumps(data['subscription'])
    
    existing_sub = Subscription.query.filter_by(subscription_json=subscription_json).first()
    if existing_sub:
        return jsonify({'status': 'exists', 'id': existing_sub.id}), 200

    new_sub = Subscription(subscription_json=subscription_json)
    db.session.add(new_sub)
    db.session.commit()
    return jsonify({'status': 'success', 'id': new_sub.id}), 201

@app.route('/start_timer', methods=['POST'])
def start_timer():
    # 計時器 API 路由 (優先匹配)
    data = request.json
    minutes = int(data['minutes'])
    subscription_endpoint = data['subscription']['endpoint']
    
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(subscription_endpoint)).first()

    if not sub_info:
        return jsonify({'status': 'error', 'message': 'Subscription not found'}), 404

    expiry_time = datetime.utcnow() + timedelta(minutes=minutes)
    message = data.get('message', f'您的 {minutes} 分鐘計時器已完成！')
    
    new_timer = Timer(subscription_id=sub_info.id, expiry_time=expiry_time, message=message)
    db.session.add(new_timer)
    db.session.commit()

    return jsonify({'status': 'success', 'message': f'Timer set for {minutes} minutes.'})
# ... 在 start_timer 函式後面新增 ...

@app.route('/api/timers', methods=['GET'])
def get_active_timers():
    # 這個 API 需要前端提供 subscription endpoint 作為識別
    endpoint = request.args.get('endpoint')
    if not endpoint:
        return jsonify({"error": "Endpoint is required"}), 400

    # 找到對應的 subscription
    sub_info = Subscription.query.filter(Subscription.subscription_json.contains(endpoint)).first()
    if not sub_info:
        # 如果找不到訂閱，可能已被刪除或尚未建立，回傳空列表
        return jsonify([])

    # 查詢該訂閱底下所有尚未被標記為「已通知」的計時器
    now = datetime.utcnow()
    active_timers = Timer.query.filter(
        Timer.subscription_id == sub_info.id,
        Timer.notified == False,
        Timer.expiry_time > now  # 只回傳還在倒數的
    ).all()

    # 將查詢結果轉換成 JSON 格式回傳給前端
    timers_data = [
        {
            "id": timer.id,
            "message": timer.message,
            "expiry_time": timer.expiry_time.isoformat() + 'Z' # 回傳標準 ISO 格式時間
        } 
        for timer in active_timers
    ]
    return jsonify(timers_data)

@app.route('/<path:path>')
def serve_static(path):
    # 通用靜態檔案路由 (最後匹配)
    # 用來處理 /main.js, /sw.js 等檔案請求
    return send_from_directory(app.static_folder, path)

# --- 背景計時與推播任務 ---
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
        print(f"Checking timers at {datetime.utcnow()} UTC...")
        now = datetime.utcnow()
        due_timers = Timer.query.filter(Timer.expiry_time <= now, Timer.notified == False).all()
        
        if not due_timers:
            print("No due timers found.")
            return

        for timer in due_timers:
            print(f"Found due timer ID: {timer.id}")
            send_notification(timer.subscription.subscription_json, timer.message)
            timer.notified = True
        
        db.session.commit()
        print(f"Processed {len(due_timers)} timers.")

# --- 啟動應用 ---
with app.app_context():
    db.create_all()

# 每 30 秒檢查一次是否有計時器到期
scheduler.add_job(check_timers, 'interval', seconds=30)
scheduler.start()

if __name__ == '__main__':
    app.run(debug=True, use_reloader=False) # 在本地測試時，關閉 reloader 避免 scheduler 跑兩次
