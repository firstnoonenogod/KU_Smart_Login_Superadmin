const { Pool } = require('pg');

// ตั้งค่าการเชื่อมต่อ PostgreSQL (ปรับเปลี่ยนตามเครื่องของคุณ)
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

const initDb = async () => {
    try {
        // [ข้อควรระวัง] หากรันบนระบบจริงที่เก่า ให้ Drop ตารางเดิมทิ้งก่อน (เฉพาะตอนอัปเกรดระบบ)
        // await pool.query('DROP TABLE IF EXISTS admin_stats, wifi_users, organizations CASCADE;');

        // 1. ตารางองค์กร
        await pool.query(`
            CREATE TABLE IF NOT EXISTS organizations (
                org_id SERIAL PRIMARY KEY,
                org_name VARCHAR(100) NOT NULL,
                org_type BOOLEAN NOT NULL, -- (true=ภายใน, false=ภายนอก)
                is_active BOOLEAN DEFAULT true,
                admin_user VARCHAR(50) UNIQUE NOT NULL,
                admin_pass CHAR(60) NOT NULL,
                user_policy_days SMALLINT DEFAULT 1,
                create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. ตารางระยะเวลาของแอดมินองค์กรภายนอก
        await pool.query(`
            CREATE TABLE IF NOT EXISTS org_access_periods (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(org_id) ON DELETE CASCADE,
                access_start DATE NOT NULL,
                access_end DATE NOT NULL,
                note TEXT
            );
        `);

        // 3. ตารางลงทะเบียนตู้ Kiosk
        await pool.query(`
            CREATE TABLE IF NOT EXISTS kiosk_machines (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(org_id) ON DELETE SET NULL,
                machine_id VARCHAR(20) UNIQUE NOT NULL,
                address VARCHAR(100),
                is_active BOOLEAN DEFAULT true
            );
        `);

        // 4. ตารางผู้ใช้งาน (ลบชื่อ-นามสกุลออก เหลือแค่ข้อมูลยืนยันตัวตน)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wifi_users (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(org_id) ON DELETE SET NULL,
                card_id CHAR(13) NOT NULL,
                username CHAR(14) UNIQUE NOT NULL
            );
        `);

        // 5. ตารางเก็บรหัสผ่านและเวลาหมดอายุ (ตามที่คุณต้องการ)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wifi_credentials (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES wifi_users(id) ON DELETE CASCADE,
                password CHAR(8) NOT NULL,
                create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expire_time TIMESTAMP NOT NULL,
                is_active BOOLEAN DEFAULT true
            );
        `);

        // 6. ตารางสถิติ (เปลี่ยนชื่อฟิลด์ตาม ER Diagram)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_stat (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(org_id) ON DELETE CASCADE,
                date DATE DEFAULT CURRENT_DATE,
                count INTEGER DEFAULT 0,
                UNIQUE(org_id, date)
            );
        `);

        // 7. ตารางเก็บรายชื่อพนักงาน (สำหรับ KU ALL-Login)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS org_employees (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(org_id) ON DELETE CASCADE,
                ku_email VARCHAR(100) NOT NULL,
                emp_policy_days SMALLINT DEFAULT 1,
                is_active BOOLEAN DEFAULT true,
                create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(org_id, ku_email)
            );
        `);

        await pool.query(`
            DO $$
            BEGIN
                -- เพิ่ม columns ถ้ายังไม่มี
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='org_employees' AND column_name='auth_type') THEN
                    ALTER TABLE org_employees ADD COLUMN auth_type VARCHAR(20) NOT NULL DEFAULT 'ku_sso';
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='org_employees' AND column_name='username') THEN
                    ALTER TABLE org_employees ADD COLUMN username VARCHAR(50);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='org_employees' AND column_name='password_hash') THEN
                    ALTER TABLE org_employees ADD COLUMN password_hash CHAR(60);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='org_employees' AND column_name='display_name') THEN
                    ALTER TABLE org_employees ADD COLUMN display_name VARCHAR(100);
                END IF;
                
                -- ทำให้ ku_email nullable
                ALTER TABLE org_employees ALTER COLUMN ku_email DROP NOT NULL;
                
                -- เพิ่ม constraints (ถ้ายังไม่มี)
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='auth_type_check') THEN
                    ALTER TABLE org_employees ADD CONSTRAINT auth_type_check 
                        CHECK (auth_type IN ('ku_sso', 'local'));
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ku_sso_requires_email') THEN
                    ALTER TABLE org_employees ADD CONSTRAINT ku_sso_requires_email 
                        CHECK (auth_type != 'ku_sso' OR ku_email IS NOT NULL);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='local_requires_credentials') THEN
                    ALTER TABLE org_employees ADD CONSTRAINT local_requires_credentials 
                        CHECK (auth_type != 'local' OR 
                               (username IS NOT NULL AND password_hash IS NOT NULL AND display_name IS NOT NULL));
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='username_unique') THEN
                    ALTER TABLE org_employees ADD CONSTRAINT username_unique UNIQUE (username);
                END IF;
                
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='display_name_per_org') THEN
                    ALTER TABLE org_employees ADD CONSTRAINT display_name_per_org UNIQUE (org_id, display_name);
                END IF;
            END $$;
        `);

        // 8. เพิ่มคอลัมน์เก็บชื่อคนออกรหัสในตาราง wifi_credentials
        await pool.query(`
            ALTER TABLE wifi_credentials 
            ADD COLUMN IF NOT EXISTS issued_by VARCHAR(100) DEFAULT 'Admin';
        `);

        // === 9. ตารางเก็บประวัติการพยายามออก guest ID ทุก attempt ===
        await pool.query(`
            CREATE TABLE IF NOT EXISTS verification_attempts (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(org_id) ON DELETE CASCADE,
                id_card VARCHAR(13),
                guest_name VARCHAR(200),
                result VARCHAR(30) NOT NULL,
                issued_by VARCHAR(100),
                attempt_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP
            );
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_attempts_org_time 
                ON verification_attempts(org_id, attempt_time DESC);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_attempts_expires 
                ON verification_attempts(expires_at);
        `);
        console.log("✅ Table verification_attempts ready");

        console.log("✅ อัปเกรด PostgreSQL Database Schema ใหม่สำเร็จ");
    } catch (err) {
        console.error("❌ Database Init Error:", err);
    }
};

module.exports = { pool, initDb };