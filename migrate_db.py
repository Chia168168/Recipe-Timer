# migrate_db.py
import os
import sys

# 添加当前目录到 Python 路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app import app, db
from datetime import datetime

def migrate_database():
    with app.app_context():
        try:
            print("开始数据库迁移...")
            
            # 检查表结构
            from sqlalchemy import inspect, text
            inspector = inspect(db.engine)
            
            # 检查 subscription 表
            if 'subscription' in inspector.get_table_names():
                sub_columns = [col['name'] for col in inspector.get_columns('subscription')]
                print("subscription 表列:", sub_columns)
                
                # 添加缺失的列
                if 'endpoint' not in sub_columns:
                    print("添加 endpoint 列到 subscription 表...")
                    db.session.execute(text('ALTER TABLE subscription ADD COLUMN endpoint TEXT'))
                
                if 'created_at' not in sub_columns:
                    print("添加 created_at 列到 subscription 表...")
                    db.session.execute(text('ALTER TABLE subscription ADD COLUMN created_at TIMESTAMP'))
            
            # 检查 timer 表
            if 'timer' in inspector.get_table_names():
                timer_columns = [col['name'] for col in inspector.get_columns('timer')]
                print("timer 表列:", timer_columns)
                
                # 添加缺失的列
                if 'created_at' not in timer_columns:
                    print("添加 created_at 列到 timer 表...")
                    db.session.execute(text('ALTER TABLE timer ADD COLUMN created_at TIMESTAMP'))
                
                # 为现有数据设置默认值
                db.session.execute(text("UPDATE timer SET created_at = NOW() WHERE created_at IS NULL"))
            
            db.session.commit()
            print("数据库迁移完成!")
            
        except Exception as e:
            print(f"迁移失败: {e}")
            db.session.rollback()
            import traceback
            traceback.print_exc()

if __name__ == '__main__':
    migrate_database()
