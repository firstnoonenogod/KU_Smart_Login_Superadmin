const axios = require('axios');
const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool, initDb } = require('./database');

const app = express();
const PORT = 3000;
const SUPER_HASH = process.env.SUPERADMIN_PASS;

app.use(cors({
    origin: ['http://158.108.217.46:8000', 'http://localhost:8000', 'http://158.108.217.46:3000', 'http://localhost:3000']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// เริ่มต้นโครงสร้างฐานข้อมูล
initDb();

// Middleware ตรวจสอบสิทธิ์ Super Admin
function requireSuperAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: "Unauthorized: ไม่พบ Token" });
    }
    
    const token = authHeader.split(' ')[1];
    try { 
        jwt.verify(token, process.env.JWT_SECRET); 
        next(); 
    } catch (err) { 
        res.status(401).json({ success: false, message: 'Unauthorized: Token หมดอายุหรือไม่ถูกต้อง' }); 
    }
}

// ==========================================
// API สำหรับ Super Admin
// ==========================================

// ล็อกอิน Super Admin
app.post('/api/superadmin/login', async (req, res) => {
    const { username, password } = req.body;

    if (username !== process.env.SUPERADMIN_USER) {
        return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง" });
    }
    
    const isMatch = await bcrypt.compare(password, SUPER_HASH);
    if (!isMatch) {
        return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง" });
    }
    
    const token = jwt.sign({ role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ success: true, token: token });
});

// ดึงข้อมูลสถิติภาพรวม
app.get('/api/dashboard/stats', requireSuperAdmin, async (req, res) => {
    try {
        const orgCount = await pool.query('SELECT COUNT(*) FROM organizations');
        const userCount = await pool.query('SELECT COUNT(DISTINCT card_id) FROM wifi_users');
        
        res.json({ 
            total_orgs: parseInt(orgCount.rows[0].count), 
            total_wifi_users: parseInt(userCount.rows[0].count) 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ดึงรายชื่อองค์กรทั้งหมด (พร้อมนับจำนวนยอดผู้ใช้งานจริงรายองค์กร)
app.get('/api/organizations', requireSuperAdmin, async (req, res) => {
    try {
        const query = `
            SELECT o.org_id, o.org_name, o.org_type, o.admin_user, o.user_policy_days,
                   COUNT(u.id)::int as user_count
            FROM organizations o
            LEFT JOIN wifi_users u ON o.org_id = u.org_id
            GROUP BY o.org_id
            ORDER BY o.org_id DESC
        `;
        const result = await pool.query(query);
        const formatted = result.rows.map(row => ({
            id: row.org_id,
            name: row.org_name,
            org_type: row.org_type ? 'internal' : 'external',
            admin_user: row.admin_user,
            user_policy_days: row.user_policy_days,
            user_count: row.user_count
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// สร้างบัญชีองค์กรใหม่
app.post('/api/organizations', requireSuperAdmin, async (req, res) => {
    const { name, org_type, admin_validity_days, user_policy_days } = req.body;
    const admin_user = "admin_" + Math.random().toString(36).substr(2, 5);
    const plain_admin_pass = Math.random().toString(36).slice(-8);
    const isInternal = org_type === 'internal';
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hashed_admin_pass = await bcrypt.hash(plain_admin_pass, 10);

        const orgSql = `INSERT INTO organizations (org_name, org_type, admin_user, admin_pass, user_policy_days) 
                        VALUES ($1, $2, $3, $4, $5) RETURNING org_id, org_name`;
        const orgResult = await client.query(orgSql, [name, isInternal, admin_user, hashed_admin_pass, user_policy_days]);
        const newOrgId = orgResult.rows[0].org_id;

        if (!isInternal && admin_validity_days) {
            const end_date = new Date();
            end_date.setDate(end_date.getDate() + parseInt(admin_validity_days) - 1);
            await client.query(`
                INSERT INTO org_access_periods (org_id, access_start, access_end, note) 
                VALUES ($1, CURRENT_DATE, $2, 'สร้างจากระบบ Super Admin')
            `, [newOrgId, end_date]);
        }

        await client.query('COMMIT');
        res.json({ success: true, data: { admin_user, admin_pass: plain_admin_pass } });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ลบองค์กร
app.delete('/api/organizations/:id', requireSuperAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM organizations WHERE org_id = $1', [id]);
        res.json({ success: true, message: "ลบองค์กรสำเร็จ" });
    } catch (err) {
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการลบ" });
    }
});

// ==========================================
// API สำหรับ Admin องค์กร
// ==========================================

// ล็อกอิน Admin องค์กร
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const query = `
            SELECT o.org_id, o.org_name, o.org_type, o.user_policy_days, o.admin_pass, p.access_end 
            FROM organizations o
            LEFT JOIN org_access_periods p ON o.org_id = p.org_id
            WHERE o.admin_user = $1 AND o.is_active = true
        `;
        const result = await pool.query(query, [username]);

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง!" });
        }

        const orgData = result.rows[0];
        const isMatch = await bcrypt.compare(password, orgData.admin_pass);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Username หรือ Password ไม่ถูกต้อง!" });
        }

        if (orgData.org_type === false && orgData.access_end && new Date(orgData.access_end) < new Date()) {
            return res.status(403).json({ success: false, message: "บัญชีผู้ดูแลระบบนี้หมดอายุการใช้งานแล้ว!" });
        }

        res.json({
            success: true,
            message: "ล็อกอินเข้าสู่ระบบสำเร็จ",
            data: {
                org_id: orgData.org_id,
                org_name: orgData.org_name,
                org_type: orgData.org_type ? 'internal' : 'external',
                user_policy_days: orgData.user_policy_days
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
    }
});

// --- 1. API ดึงรายชื่อพนักงาน ---
app.get('/api/admin/employees', async (req, res) => {
    const org_id = req.query.org_id; 
    try {
        const result = await pool.query('SELECT * FROM org_employees WHERE org_id = $1 ORDER BY id DESC', [org_id]);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 2. API เพิ่มพนักงาน ---
app.post('/api/admin/employees', async (req, res) => {
    const { org_id, ku_email, emp_policy_days } = req.body;
    try {
        const orgRes = await pool.query('SELECT user_policy_days FROM organizations WHERE org_id = $1', [org_id]);
        if (emp_policy_days > orgRes.rows[0].user_policy_days) {
            return res.status(400).json({ success: false, message: "สิทธิ์จำนวนวัน ต้องไม่เกินสิทธิ์ขององค์กร" });
        }
        await pool.query(`INSERT INTO org_employees (org_id, ku_email, emp_policy_days) VALUES ($1, $2, $3)`, [org_id, ku_email, emp_policy_days]);
        res.json({ success: true, message: "เพิ่มสิทธิ์พนักงานสำเร็จ" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 3. API ลบพนักงาน ---
app.delete('/api/admin/employees/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM org_employees WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: "ลบสิทธิ์พนักงานสำเร็จ" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- 4. API ส่งไปหน้าล็อกอิน KU ---
app.get('/api/auth/ku-login', (req, res) => {
    const authUrl = `https://alllogin.ku.ac.th/realms/KU-Alllogin/protocol/openid-connect/auth?client_id=${process.env.KU_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.KU_REDIRECT_URI)}&response_type=code&scope=basic openid`;
    res.redirect(authUrl);
});

// --- 5. API รับค่ากลับมาจาก KU (Callback) ---
app.get('/api/auth/ku-callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("Authorization Code missing");

    try {
        const tokenResponse = await axios.post('https://alllogin.ku.ac.th/realms/KU-Alllogin/protocol/openid-connect/token', 
            new URLSearchParams({ grant_type: 'authorization_code', code: code, client_id: process.env.KU_CLIENT_ID, client_secret: process.env.KU_CLIENT_SECRET, redirect_uri: process.env.KU_REDIRECT_URI }).toString(), 
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const userInfo = await axios.get('https://alllogin.ku.ac.th/realms/KU-Alllogin/protocol/openid-connect/userinfo', { headers: { 'Authorization': `Bearer ${tokenResponse.data.access_token}` } });
        const userEmail = userInfo.data.email || userInfo.data.mail; 
        const empCheck = await pool.query(`SELECT e.*, o.org_name FROM org_employees e JOIN organizations o ON e.org_id = o.org_id WHERE e.ku_email = $1 AND e.is_active = true`, [userEmail]);

        if (empCheck.rows.length === 0) return res.status(403).send("คุณไม่ได้รับสิทธิ์ในการใช้งานระบบ Kiosk นี้");

        const employeeData = empCheck.rows[0];
        const kioskToken = jwt.sign({ role: 'employee', org_id: employeeData.org_id, email: employeeData.ku_email, policy_days: employeeData.emp_policy_days }, process.env.JWT_SECRET, { expiresIn: '8h' });

        // กลับไปหน้าตู้ Kiosk พอร์ต 8000
        res.redirect(`http://158.108.217.46:8000/?token=${kioskToken}&orgName=${encodeURIComponent(employeeData.org_name)}`);
    } catch (err) {
        res.status(500).send("SSO Error: ไม่สามารถเข้าสู่ระบบได้");
    }
});

// บันทึกการออกรหัส Wi-Fi (รับข้อมูลจาก Kiosk)
app.post('/api/admin/issue-wifi', async (req, res) => {
    const { org_id, username, password, id_card , issued_by} = req.body; 
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // คำนวณเวลาหมดอายุจากโควตา
        const orgRes = await client.query('SELECT user_policy_days FROM organizations WHERE org_id = $1', [org_id]);
        const policyDays = orgRes.rows.length > 0 ? orgRes.rows[0].user_policy_days : 1;
        const expireTime = new Date();
        expireTime.setDate(expireTime.getDate() + policyDays);

        // จัดการข้อมูลผู้ใช้ (สร้างใหม่ หรือ อัปเดตข้อมูลเดิม)
        let userId;
        const existingUser = await client.query('SELECT id FROM wifi_users WHERE card_id = $1', [id_card]);

        if (existingUser.rows.length > 0) {
            userId = existingUser.rows[0].id;
            await client.query('UPDATE wifi_users SET username = $1, org_id = $2 WHERE id = $3', [username, org_id, userId]);
        } else {
            const newUser = await client.query(`
                INSERT INTO wifi_users (org_id, card_id, username)
                VALUES ($1, $2, $3) RETURNING id
            `, [org_id, id_card, username]);
            userId = newUser.rows[0].id;
        }

        // บันทึกรหัสผ่านใหม่
        await client.query(`
            INSERT INTO wifi_credentials (user_id, password, expire_time, issued_by)
            VALUES ($1, $2, $3)
        `, [userId, password, expireTime]);

        // อัปเดตยอดการออกบัตรรายวัน
        await client.query(`
            INSERT INTO admin_stat (org_id, date, count)
            VALUES ($1, CURRENT_DATE, 1)
            ON CONFLICT (org_id, date)
            DO UPDATE SET count = admin_stat.count + 1;
        `, [org_id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "ออกรหัสและบันทึกประวัติสำเร็จ" });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// ดึงข้อมูล Dashboard ขององค์กร และประวัติผู้ใช้งาน
app.get('/api/dashboard/org/:id', requireSuperAdmin, async (req, res) => {
    const orgId = req.params.id;
    try {
        let statsQuery;
        let historyQuery;

        // แยกเงื่อนไข: กรณีขอดู "ทั้งหมด (all)" ไม่ต้องใส่ WHERE org_id
        if (orgId === 'all') {
            statsQuery = await pool.query(`
                SELECT 
                    COALESCE(SUM(CASE WHEN date = CURRENT_DATE THEN count ELSE 0 END), 0) as today,
                    COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '7 days' THEN count ELSE 0 END), 0) as this_week,
                    COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE) THEN count ELSE 0 END), 0) as this_month,
                    COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '3 months' THEN count ELSE 0 END), 0) as three_months
                FROM admin_stat 
            `);

            historyQuery = await pool.query(`
                SELECT 
                    u.card_id as id_card, 
                    u.username, 
                    c.create_time as created_at, 
                    c.expire_time,
                    c.issued_by,
                    COALESCE(o.org_name, 'องค์กรที่ถูกลบไปแล้ว') as org_name
                FROM wifi_users u
                JOIN wifi_credentials c ON u.id = c.user_id
                LEFT JOIN organizations o ON u.org_id = o.org_id
                ORDER BY c.create_time DESC
            `);
        } 
        // แยกเงื่อนไข: กรณีดูเฉพาะองค์กร (มีส่งเลข ID มา) ใช้ WHERE org_id = $1
        else {
            statsQuery = await pool.query(`
                SELECT 
                    COALESCE(SUM(CASE WHEN date = CURRENT_DATE THEN count ELSE 0 END), 0) as today,
                    COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '7 days' THEN count ELSE 0 END), 0) as this_week,
                    COALESCE(SUM(CASE WHEN date >= date_trunc('month', CURRENT_DATE) THEN count ELSE 0 END), 0) as this_month,
                    COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '3 months' THEN count ELSE 0 END), 0) as three_months
                FROM admin_stat 
                WHERE org_id = $1
            `, [orgId]);

            historyQuery = await pool.query(`
                SELECT 
                    u.card_id as id_card, 
                    u.username, 
                    c.create_time as created_at, 
                    c.expire_time,
                    COALESCE(o.org_name, 'องค์กรที่ถูกลบไปแล้ว') as org_name
                FROM wifi_users u
                JOIN wifi_credentials c ON u.id = c.user_id
                LEFT JOIN organizations o ON u.org_id = o.org_id
                WHERE u.org_id = $1
                ORDER BY c.create_time DESC
            `, [orgId]);
        }

        // นำข้อมูลมาคำนวณสถานะ Active / Inactive
        let activeCount = 0;
        let inactiveCount = 0;
        const now = new Date();
        
        const historyList = historyQuery.rows.map(user => {
            let status = 'Inactive';
            // อิงจาก expire_time ในตาราง wifi_credentials ได้ตรงๆ เลย 
            if (now <= new Date(user.expire_time)) {
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

// ==========================================
// ระบบ Cleanup (ล้างข้อมูลเก่า)
// ==========================================
setInterval(async () => {
    try {
        const delCreds = await pool.query("DELETE FROM wifi_credentials WHERE expire_time < NOW() - INTERVAL '90 days'");
        
        const disableOrgs = await pool.query(`
            UPDATE organizations SET is_active = false 
            WHERE org_type = false AND org_id IN (
                SELECT org_id FROM org_access_periods WHERE access_end < CURRENT_DATE
            ) AND is_active = true
        `);
        
        if (delCreds.rowCount > 0 || disableOrgs.rowCount > 0) {
            console.log(`🧹 Cleanup: รหัสเก่าลบ ${delCreds.rowCount} รายการ, ปิดแอดมินหมดอายุ ${disableOrgs.rowCount} บัญชี`);
        }
    } catch (err) {
        console.error("Cleanup error:", err);
    }
}, 60000);

app.listen(PORT, () => console.log(`🚀 PostgreSQL Server running on http://localhost:${PORT}`));