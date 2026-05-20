const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt'); // เพิ่มไลบรารี bcrypt
const jwt = require('jsonwebtoken');
const { pool, initDb } = require('./database');

const app = express();
const PORT = 3000;

const SUPER_HASH = process.env.SUPER_ADMIN_HASH;

app.use(cors({
    origin: ['http://158.108.217.46:8000', 'http://localhost:8000', 'http://158.108.217.46:3000', 'http://localhost:3000']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// เริ่มต้นฐานข้อมูล
initDb();

function requireSuperAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: "Unauthorized: ไม่พบ Token" });
    }
    
    const token = authHeader.split(' ')[1];
    try { 
        // เช็คว่า Token ถูกต้องและยังไม่หมดอายุใช่ไหม
        jwt.verify(token, process.env.JWT_SECRET); 
        next(); // ผ่านได้!
    } catch (err) { 
        res.status(401).json({ success: false, message: 'Unauthorized: Token หมดอายุหรือไม่ถูกต้อง' }); 
    }
}

// Login สำหรับ Super Admin
app.post('/api/superadmin/login', async (req, res) => {
    const { username, password } = req.body;
    
    // 1. เช็ค Username
    if (username !== process.env.SUPERADMIN_USER) {
        return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง" });
    }
    
    // 2. เช็ค Password กับ Hash
    const isMatch = await bcrypt.compare(password, SUPER_HASH);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง" });
    }
    
    // 3. รหัสถูกปุ๊บ ออกบัตรผ่าน (Token) ให้เลย มีอายุ 8 ชั่วโมง
    const token = jwt.sign({ role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    
    res.json({ success: true, token: token });
});

// ดึงสถิติ Dashboard รวม
app.get('/api/dashboard/stats', requireSuperAdmin, async (req, res) => {
    try {
        const orgCount = await pool.query('SELECT COUNT(*) FROM organizations');
        // ใช้ DISTINCT id_card เพื่อไม่ให้คนที่มีบัตรประชาชนเดียวกันถูกนับซ้ำในยอดรวมระบบ
        const userCount = await pool.query('SELECT COUNT(DISTINCT id_card) FROM wifi_users');
        
        res.json({ 
            total_orgs: parseInt(orgCount.rows[0].count), 
            total_wifi_users: parseInt(userCount.rows[0].count) 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ดึงรายชื่อองค์กร
app.get('/api/organizations', requireSuperAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM organizations ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// เพิ่มองค์กรใหม่ (อัปเดตให้เข้ารหัสผ่านด้วย bcrypt + แก้ไขลอจิกวันหมดอายุ)
app.post('/api/organizations', requireSuperAdmin, async (req, res) => {
    const { name, org_type, admin_validity_days, user_policy_days } = req.body;
    const admin_user = "admin_" + Math.random().toString(36).substr(2, 5);
    
    // สร้างรหัสผ่านแบบธรรมดา (Plain text) ไว้ก่อน
    const plain_admin_pass = Math.random().toString(36).slice(-8);
    
    let admin_expiry_date = null;

    if (org_type === 'external' && admin_validity_days) {
        admin_expiry_date = new Date();
        
        // 1. คำนวณวันหมดอายุ โดยหักออก 1 วัน (เพราะนับวันที่สร้างเป็นวันที่ 1)
        admin_expiry_date.setDate(admin_expiry_date.getDate() + (parseInt(admin_validity_days) - 1));
        
        // 2. ตั้งเวลาให้เป็นเวลา 23:59:59 ของวันนั้น
        admin_expiry_date.setHours(23, 59, 59, 999);
    }

    try {
        // ทำการเข้ารหัสผ่าน (Hash) โดยใช้ Salt rounds = 10
        const hashed_admin_pass = await bcrypt.hash(plain_admin_pass, 10);

        // บันทึกรหัสที่ถูก Hash แล้วลงฐานข้อมูล
        const sql = `INSERT INTO organizations (name, org_type, admin_user, admin_pass, user_policy_days, admin_expiry_date) 
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
        const result = await pool.query(sql, [name, org_type, admin_user, hashed_admin_pass, user_policy_days, admin_expiry_date]);
        
        // เตรียมข้อมูลส่งกลับให้หน้าเว็บ (Popup)
        const responseData = result.rows[0];
        // เปลี่ยนค่าพาสเวิร์ดใน Response กลับเป็นแบบธรรมดา เพื่อให้ Popup แสดงผลให้คนดูได้ (แต่ใน DB ปลอดภัยแล้ว)
        responseData.admin_pass = plain_admin_pass;

        res.json({ success: true, data: responseData });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ลบองค์กร
app.get('/api/dashboard/org/:id', requireSuperAdmin, async (req, res) => {
    const orgId = req.params.id;
    try {
        let policyDays = 1;
        
        if (orgId !== 'all') {
            const orgRes = await pool.query('SELECT user_policy_days FROM organizations WHERE id = $1', [orgId]);
            if (orgRes.rows.length > 0) {
                policyDays = orgRes.rows[0].user_policy_days;
            }
        }

        // ค้นหาตาม Org ID ปกติ หรือค้นหาทั้งหมดถ้าส่งค่า 'all' มา
        const whereClause = orgId === 'all' ? '' : `WHERE org_id = ${parseInt(orgId)}`;
        const statsWhereClause = orgId === 'all' ? '' : `WHERE org_id = ${parseInt(orgId)}`;

        // ดึงสถิติแยกตามช่วงเวลา
        const statsQuery = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN issue_date = CURRENT_DATE THEN total_issued ELSE 0 END), 0) as today,
                COALESCE(SUM(CASE WHEN issue_date >= CURRENT_DATE - INTERVAL '7 days' THEN total_issued ELSE 0 END), 0) as this_week,
                COALESCE(SUM(CASE WHEN issue_date >= date_trunc('month', CURRENT_DATE) THEN total_issued ELSE 0 END), 0) as this_month,
                COALESCE(SUM(CASE WHEN issue_date >= CURRENT_DATE - INTERVAL '3 months' THEN total_issued ELSE 0 END), 0) as three_months
            FROM admin_stats 
            ${statsWhereClause}
        `);

        // ดึงประวัติผู้ใช้งาน (ดึงชื่อองค์กรพ่วงมาโชว์ด้วย เผื่อกรณีองค์กรถูกลบจะขึ้นว่า "องค์กรที่ถูกลบ")
        const historyQuery = await pool.query(`
            SELECT u.fname_th, u.lname_th, u.id_card, u.username, u.created_at, COALESCE(o.name, 'องค์กรที่ถูกลบไปแล้ว') as org_name
            FROM wifi_users u
            LEFT JOIN organizations o ON u.org_id = o.id
            ${whereClause}
            ORDER BY u.created_at DESC
        `);

        let activeCount = 0;
        let inactiveCount = 0;
        const now = new Date();
        
        const historyList = historyQuery.rows.map(user => {
            const createdDate = new Date(user.created_at);
            const expireDate = new Date(createdDate.getTime() + (policyDays * 24 * 60 * 60 * 1000));
            
            let status = 'Inactive';
            if (now <= expireDate) {
                status = 'Active';
                activeCount++;
            } else {
                inactiveCount++;
            }

            return { ...user, status };
        });

        res.json({
            success: true,
            stats: statsQuery.rows[0],
            activeCount,
            inactiveCount,
            history: historyList
        });
    } catch (err) {
        console.error("Dashboard Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// --- API สำหรับ ADMIN องค์กร (ที่เพื่อนคุณจะเรียกใช้) ---

// ==========================================
// 1. API Login สำหรับ Admin องค์กร (อัปเดตให้เช็คด้วย bcrypt)
// ==========================================
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // ค้นหาในตาราง organizations โดยดึง admin_pass ออกมาด้วย (ค้นหาแค่ username ก่อน)
        const query = 'SELECT id, name, org_type, user_policy_days, admin_expiry_date, admin_pass FROM organizations WHERE admin_user = $1';
        const result = await pool.query(query, [username]);

        if (result.rows.length > 0) {
            const orgData = result.rows[0];

            // ใช้ bcrypt.compare เทียบรหัสผ่านที่รับมา กับรหัสที่ถูก Hash ไว้ใน Database
            const isMatch = await bcrypt.compare(password, orgData.admin_pass);

            if (!isMatch) {
                // ถ้ารหัสไม่ตรง
                return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง!" });
            }

            // เช็คเพิ่มเติม: ถ้าเป็นหน่วยงานภายนอก หมดอายุหรือยัง?
            if (orgData.org_type === 'external' && orgData.admin_expiry_date && new Date(orgData.admin_expiry_date) < new Date()) {
                return res.status(403).json({ success: false, message: "บัญชีผู้ดูแลระบบนี้หมดอายุการใช้งานแล้ว!" });
            }

            // ล็อกอินสำเร็จ ส่งข้อมูลกลับไปให้เพื่อนคุณใช้ต่อ
            res.json({
                success: true,
                message: "ล็อกอินเข้าสู่ระบบสำเร็จ",
                data: {
                    org_id: orgData.id,
                    org_name: orgData.name,
                    org_type: orgData.org_type,
                    user_policy_days: orgData.user_policy_days
                }
            });
        } else {
            // ไม่พบ Username
            res.status(401).json({
                success: false,
                message: "Username หรือ Password ไม่ถูกต้อง!"
            });
        }
    } catch (err) {
        console.error("Admin Login Error:", err);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
    }
});

// 2. บันทึก User Wi-Fi ใหม่ และอัปเดตสถิติ
// ---  API สำหรับรับข้อมูลจากตู้ Kiosk (อัปเดตใหม่ ป้องกันคนซ้ำ) ---
app.post('/api/admin/issue-wifi', async (req, res) => {
    const { org_id, username, password, fname_th, lname_th, fname_en, lname_en, id_card } = req.body;
    
    try {
        // 1. ตรวจสอบว่ามีผู้ใช้งานนี้ (เลขบัตรนี้) ในองค์กรนี้อยู่แล้วหรือไม่
        const existingUser = await pool.query(
            'SELECT * FROM wifi_users WHERE org_id = $1 AND id_card = $2',
            [org_id, id_card]
        );

        if (existingUser.rows.length > 0) {
            // กรณีที่ 1: มีคนนี้อยู่แล้ว -> แค่อัปเดต Username/Password และเวลาให้ใหม่ (ไม่บวกสถิติ)
            await pool.query(`
                UPDATE wifi_users 
                SET username = $1, password = $2, created_at = CURRENT_TIMESTAMP
                WHERE org_id = $3 AND id_card = $4
            `, [username, password, org_id, id_card]);
            
            console.log(`♻️ อัปเดตข้อมูลผู้ใช้เดิม (มาขอซ้ำ): ${fname_th} ${lname_th}`);
            
        } else {
            // กรณีที่ 2: เป็นผู้ใช้งานใหม่ -> บันทึกชื่อลงฐานข้อมูล และบวกสถิติ
            await pool.query(`
                INSERT INTO wifi_users (org_id, username, password, fname_th, lname_th, fname_en, lname_en, id_card)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [org_id, username, password, fname_th, lname_th, fname_en, lname_en, id_card]);

            // อัปเดตสถิติรายวัน (บวกเพิ่ม 1)
            await pool.query(`
                INSERT INTO admin_stats (org_id, issue_date, total_issued)
                VALUES ($1, CURRENT_DATE, 1)
                ON CONFLICT (org_id, issue_date)
                DO UPDATE SET total_issued = admin_stats.total_issued + 1;
            `, [org_id]);
            
            console.log(`✅ ออกรหัส Wi-Fi ใหม่สำเร็จ: ${username}`);
        }

        res.json({ success: true, message: "บันทึกผู้ใช้สำเร็จ" });
    } catch (err) {
        console.error("Issue Wi-Fi Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API สำหรับดึงข้อมูล Dashboard ของแต่ละองค์กร 
app.get('/api/dashboard/org/:id', async (req, res) => {
    const orgId = req.params.id;
    try {
        // 1. ดึงข้อมูลองค์กร (เพื่อเอา user_policy_days มาคิดวันหมดอายุ Active/Inactive)
        const orgRes = await pool.query('SELECT user_policy_days FROM organizations WHERE id = $1', [orgId]);
        if (orgRes.rows.length === 0) return res.status(404).json({ error: "ไม่พบองค์กร" });
        const policyDays = orgRes.rows[0].user_policy_days;

        // 2. ดึงสถิติ วันนี้, สัปดาห์นี้, เดือนนี้, 3 เดือน
        const statsQuery = await pool.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN issue_date = CURRENT_DATE THEN total_issued ELSE 0 END), 0) as today,
                COALESCE(SUM(CASE WHEN issue_date >= CURRENT_DATE - INTERVAL '7 days' THEN total_issued ELSE 0 END), 0) as this_week,
                COALESCE(SUM(CASE WHEN issue_date >= date_trunc('month', CURRENT_DATE) THEN total_issued ELSE 0 END), 0) as this_month,
                COALESCE(SUM(CASE WHEN issue_date >= CURRENT_DATE - INTERVAL '3 months' THEN total_issued ELSE 0 END), 0) as three_months
            FROM admin_stats 
            WHERE org_id = $1
        `, [orgId]);

        // 3. ดึงประวัติการออกบัตร (เรียงจากล่าสุดลงไป)
        const historyQuery = await pool.query(`
            SELECT fname_th, lname_th, id_card, username, created_at 
            FROM wifi_users 
            WHERE org_id = $1 
            ORDER BY created_at DESC
        `, [orgId]);

        // 4. คำนวณ Active / Inactive จากวันที่สร้าง + จำนวนวัน Policy
        let activeCount = 0;
        let inactiveCount = 0;
        const now = new Date();
        
        const historyList = historyQuery.rows.map(user => {
            const createdDate = new Date(user.created_at);
            // คำนวณเวลาหมดอายุบัตร
            const expireDate = new Date(createdDate.getTime() + (policyDays * 24 * 60 * 60 * 1000));
            
            let status = 'Inactive';
            if (now <= expireDate) {
                status = 'Active';
                activeCount++;
            } else {
                inactiveCount++;
            }

            return {
                ...user,
                status: status
            };
        });

        res.json({
            success: true,
            stats: statsQuery.rows[0],
            activeCount,
            inactiveCount,
            history: historyList
        });
    } catch (err) {
        console.error("Dashboard Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

// --- ระบบตั้งเวลาลบข้อมูลอัตโนมัติ (Cleanup) ---

setInterval(async () => {
    try {
        const delUsers = await pool.query("DELETE FROM wifi_users WHERE created_at < NOW() - INTERVAL '90 days'");
        const delOrgs = await pool.query("DELETE FROM organizations WHERE org_type = 'external' AND admin_expiry_date <= NOW()");
        
        if (delUsers.rowCount > 0 || delOrgs.rowCount > 0) {
            console.log(`🧹 Cleanup done: Removed ${delUsers.rowCount} users and ${delOrgs.rowCount} expired orgs`);
        }
    } catch (err) {
        console.error("Cleanup error:", err);
    }
}, 60000);

app.listen(PORT, () => console.log(`🚀 PostgreSQL Server running on http://localhost:${PORT}`));