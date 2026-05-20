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
        // 1. สร้างตารางองค์กร (ถ้ายังไม่มี)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS organizations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                org_type VARCHAR(50) NOT NULL,
                admin_user VARCHAR(100) UNIQUE NOT NULL,
                admin_pass VARCHAR(100) NOT NULL,
                user_policy_days INTEGER DEFAULT 1,
                admin_expiry_date TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. สร้างตารางเก็บ User Wi-Fi (เก็บ 90 วัน)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wifi_users (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                password VARCHAR(50) NOT NULL,
                fname_th VARCHAR(100),
                lname_th VARCHAR(100),
                fname_en VARCHAR(100),
                lname_en VARCHAR(100),
                id_card VARCHAR(13),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 3. สร้างตารางสถิติ (เก็บ 1 ปี)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_stats (
                id SERIAL PRIMARY KEY,
                org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
                issue_date DATE DEFAULT CURRENT_DATE,
                total_issued INTEGER DEFAULT 0,
                UNIQUE(org_id, issue_date)
            );
        `);

        console.log("✅ PostgreSQL Database & Tables Initialized");
    } catch (err) {
        console.error("❌ Database Init Error:", err);
    }
};

module.exports = { pool, initDb };