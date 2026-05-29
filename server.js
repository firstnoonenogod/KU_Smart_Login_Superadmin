const axios = require('axios');
const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool, initDb } = require('./database');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const SUPER_HASH = process.env.SUPERADMIN_PASS;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        // อนุญาต same-origin (ไม่มี origin header) เสมอ
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// เริ่มต้นโครงสร้างฐานข้อมูล
initDb();

// Middleware ตรวจสอบสิทธิ์ (รับทั้ง Token ของ Super Admin และ Key ของตู้ Kiosk)
function requireAuth(req, res, next) {
    // 1. อนุญาตถ้าเป็นตู้ Kiosk (เช็คจาก X-Internal-Key)
    const internalKey = req.headers['x-internal-key'];
    if (internalKey && internalKey === process.env.INTERNAL_API_KEY) {
        return next();
    }

    // 2. อนุญาตถ้าเป็น Super Admin (เช็คจาก Token หน้าเว็บ)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: "Unauthorized: ไม่พบ Token หรือ API Key" });
    }
    
    const token = authHeader.split(' ')[1];
    try { 
        jwt.verify(token, process.env.JWT_SECRET); 
        next(); 
    } catch (err) { 
        res.status(401).json({ success: false, message: 'Unauthorized: Token หมดอายุหรือไม่ถูกต้อง' }); 
    }
}

// คำนวณ expires_at ตามประเภท org
async function computeAttemptExpiresAt(orgId) {
    if (!orgId) return null;
    try {
        const result = await pool.query(
            `SELECT o.org_type, ap.access_end 
             FROM organizations o
             LEFT JOIN org_access_periods ap ON o.org_id = ap.org_id
             WHERE o.org_id = $1
             LIMIT 1`,
            [orgId]
        );
        if (result.rows.length === 0) return null;
        const { org_type, access_end } = result.rows[0];
        
        // Org ภายนอกที่มี access_end → ใช้ access_end
        if (!org_type && access_end) {
            return new Date(access_end);
        }
        // Default: 90 วันจากตอนนี้
        const d = new Date();
        d.setDate(d.getDate() + 90);
        return d;
    } catch {
        return null;
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
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
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
app.get('/api/organizations', requireAuth, async (req, res) => {
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
app.post('/api/organizations', requireAuth, async (req, res) => {
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
app.delete('/api/organizations/:id', requireAuth, async (req, res) => {
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
app.get('/api/admin/employees', requireAuth, async (req, res) => {
    const { org_id } = req.query;
    if (!org_id) return res.status(400).json({ success: false, message: 'ต้องระบุ org_id' });
    
    try {
        const result = await pool.query(
            `SELECT id, org_id, auth_type, ku_email, username, display_name, 
                    emp_policy_days, is_active, create_time
             FROM org_employees 
             WHERE org_id = $1 
             ORDER BY auth_type, COALESCE(display_name, ku_email)`,
            [org_id]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'โหลดไม่สำเร็จ' });
    }
});

function generateStaffCredentials() {
    const username = 'staff_' + crypto.randomBytes(4).toString('hex');
    const password = crypto.randomBytes(6).toString('base64')
                            .replace(/[+/=]/g, '').slice(0, 10);
    return { username, password };
}


// --- 2. API เพิ่มพนักงาน ---
app.post('/api/admin/employees', requireAuth, async (req, res) => {
    const { org_id, ku_email, display_name, username, emp_policy_days } = req.body;
    
    if (!org_id) return res.status(400).json({ success: false, message: 'ต้องระบุ org_id' });
    
    try {
        // ตรวจ org type
        const orgRes = await pool.query('SELECT org_type FROM organizations WHERE org_id = $1', [org_id]);
        if (orgRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบองค์กรนี้' });
        }
        const isInternal = orgRes.rows[0].org_type;  // true = ภายใน
        
        if (isInternal) {
            // ===== Org ภายใน: ใช้ KU SSO =====
            if (!ku_email) {
                return res.status(400).json({ success: false, message: 'ต้องระบุ ku_email สำหรับองค์กรภายใน' });
            }
            await pool.query(
                `INSERT INTO org_employees (org_id, auth_type, ku_email, emp_policy_days)
                 VALUES ($1, 'ku_sso', $2, $3)`,
                [org_id, ku_email, emp_policy_days || 1]
            );
            return res.json({ success: true, auth_type: 'ku_sso' });
        } else {
            // ===== Org ภายนอก: Local Login =====
            if (!display_name) {
                return res.status(400).json({ success: false, message: 'ต้องระบุชื่อ (display_name) สำหรับองค์กรภายนอก' });
            }
            
            // Gen username + password (admin แก้ username ได้)
            const generated = generateStaffCredentials();
            const finalUsername = (username && username.trim()) ? username.trim() : generated.username;
            const plainPassword = generated.password;  // จะแสดงให้ admin ครั้งเดียว
            const passwordHash = await bcrypt.hash(plainPassword, 10);
            
            await pool.query(
                `INSERT INTO org_employees (org_id, auth_type, username, password_hash, display_name, emp_policy_days)
                 VALUES ($1, 'local', $2, $3, $4, $5)`,
                [org_id, finalUsername, passwordHash, display_name.trim(), emp_policy_days || 1]
            );
            
            return res.json({
                success: true,
                auth_type: 'local',
                credentials: {
                    username: finalUsername,
                    password: plainPassword,  // ✨ แสดงครั้งเดียวเท่านั้น
                    display_name: display_name.trim()
                },
                message: 'สร้างสำเร็จ! โปรดแจ้งรหัสนี้แก่ staff (จะไม่แสดงอีกหลังปิดหน้าต่าง)'
            });
        }
    } catch (err) {
        // จัดการ unique violations
        if (err.code === '23505') {  // PostgreSQL unique_violation
            if (err.constraint === 'username_unique') {
                return res.status(409).json({ success: false, message: 'Username นี้มีในระบบแล้ว' });
            }
            if (err.constraint === 'display_name_per_org') {
                return res.status(409).json({ success: false, message: 'ชื่อนี้มีในองค์กรแล้ว' });
            }
            if (err.constraint === 'org_employees_org_id_ku_email_key') {
                return res.status(409).json({ success: false, message: 'KU email นี้มีในองค์กรแล้ว' });
            }
        }
        console.error('Add employee error:', err);
        res.status(500).json({ success: false, message: 'เพิ่มไม่สำเร็จ: ' + err.message });
    }
});

// Reset password ของ local staff (admin เท่านั้น)
app.post('/api/admin/employees/:id/reset-password', requireAuth, async (req, res) => {
    const empId = parseInt(req.params.id);
    try {
        const empRes = await pool.query(
            'SELECT auth_type, username FROM org_employees WHERE id = $1',
            [empId]
        );
        if (empRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบ staff คนนี้' });
        }
        if (empRes.rows[0].auth_type !== 'local') {
            return res.status(400).json({ success: false, message: 'reset password ได้เฉพาะ staff แบบ local' });
        }
        
        // Gen password ใหม่
        const newPassword = crypto.randomBytes(6).toString('base64')
                                  .replace(/[+/=]/g, '').slice(0, 10);
        const newHash = await bcrypt.hash(newPassword, 10);
        
        await pool.query(
            'UPDATE org_employees SET password_hash = $1 WHERE id = $2',
            [newHash, empId]
        );
        
        res.json({
            success: true,
            credentials: {
                username: empRes.rows[0].username,
                password: newPassword
            },
            message: 'รีเซ็ตรหัสผ่านสำเร็จ - โปรดแจ้ง staff รหัสใหม่นี้'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'รีเซ็ตไม่สำเร็จ' });
    }
});

// Staff Login (สำหรับ org ภายนอก ที่ใช้ username/password)
app.post('/api/auth/staff-login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'กรุณากรอก username และ password' });
    }
    
    try {
        const result = await pool.query(
            `SELECT e.id, e.org_id, e.username, e.password_hash, e.display_name, 
                    e.emp_policy_days, e.is_active,
                    o.org_name, o.is_active AS org_active,
                    o.user_policy_days
             FROM org_employees e
             JOIN organizations o ON e.org_id = o.org_id
             WHERE e.username = $1 AND e.auth_type = 'local'`,
            [username]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'ไม่พบบัญชีนี้' });
        }
        
        const staff = result.rows[0];
        if (!staff.is_active) {
            return res.status(403).json({ success: false, message: 'บัญชีนี้ถูกปิดใช้งาน' });
        }
        if (!staff.org_active) {
            return res.status(403).json({ success: false, message: 'องค์กรนี้ถูกปิดใช้งาน' });
        }
        
        const match = await bcrypt.compare(password, staff.password_hash);
        if (!match) {
            return res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
        }
        
        // (Optional) เช็ค access_period สำหรับ org ภายนอก
        const periodRes = await pool.query(
            `SELECT 1 FROM org_access_periods 
             WHERE org_id = $1 AND CURRENT_DATE BETWEEN access_start AND access_end LIMIT 1`,
            [staff.org_id]
        );
        if (periodRes.rows.length === 0) {
            return res.status(403).json({ 
                success: false, 
                message: 'องค์กรของคุณไม่อยู่ในช่วงเวลาที่ใช้ระบบได้' 
            });
        }
        
        // สร้าง JWT
        const token = jwt.sign(
            { 
                staff_id: staff.id,
                org_id: staff.org_id,
                username: staff.username,
                display_name: staff.display_name,
                auth_type: 'local'
            },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );
        
        res.json({
            success: true,
            token,
            payload: {
                org_id: staff.org_id,
                org_name: staff.org_name,
                display_name: staff.display_name,
                policy_days: Math.min(staff.emp_policy_days, staff.user_policy_days),
                auth_type: 'local'
            }
        });
    } catch (err) {
        console.error('Staff login error:', err);
        res.status(500).json({ success: false, message: 'ระบบขัดข้อง' });
    }
});

// --- 3. API ลบพนักงาน ---
app.delete('/api/admin/employees/:id', requireAuth, async (req, res) => {
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

        // กลับไปหน้าตู้ Kiosk พอร์ต 8000 ผ่าน localhost
        const KIOSK_PUBLIC_URL = process.env.KIOSK_PUBLIC_URL || 'http://localhost:8000';
        res.redirect(`${KIOSK_PUBLIC_URL}/?token=${kioskToken}&orgName=${encodeURIComponent(employeeData.org_name)}`);    } catch (err) {
        res.status(500).send("SSO Error: ไม่สามารถเข้าสู่ระบบได้");
    }
});

function requireInternalKey(req, res, next) {
    if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}


// บันทึก verification attempt (เรียกจาก Kiosk ทุกครั้งหลัง verify)
app.post('/api/admin/log-attempt', requireAuth, async (req, res) => {
    const { org_id, id_card, guest_name, result, issued_by } = req.body;
    
    if (!result) return res.status(400).json({ success: false, message: 'ต้องระบุ result' });
    
    try {
        const expiresAt = await computeAttemptExpiresAt(org_id);
        await pool.query(
            `INSERT INTO verification_attempts 
             (org_id, id_card, guest_name, result, issued_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [org_id || null, id_card || null, guest_name || null, result, issued_by || 'Admin', expiresAt]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Log attempt error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ดึงประวัติ attempts สำหรับแสดงในตาราง Kiosk
app.get('/api/admin/attempts', requireAuth, async (req, res) => {
    const { org_id, range, search, limit } = req.query;
    
    if (!org_id) return res.status(400).json({ success: false, message: 'ต้องระบุ org_id' });
    
    try {
        // Build WHERE clause
        const conditions = ['org_id = $1'];
        const params = [parseInt(org_id)];
        let idx = 2;
        
        // Filter by range
        const rangeMap = {
            'today': "attempt_time >= CURRENT_DATE",
            'week':  "attempt_time >= CURRENT_DATE - INTERVAL '7 days'",
            'month': "attempt_time >= CURRENT_DATE - INTERVAL '30 days'",
            '3month': "attempt_time >= CURRENT_DATE - INTERVAL '90 days'",
        };
        if (range && rangeMap[range]) {
            conditions.push(rangeMap[range]);
        }
        
        // Search by name (case-insensitive partial match)
        if (search && search.trim()) {
            conditions.push(`guest_name ILIKE $${idx}`);
            params.push(`%${search.trim()}%`);
            idx++;
        }
        
        // เพิ่ม limit (default 200)
        const limitNum = Math.min(parseInt(limit) || 200, 1000);
        
        const query = `
            SELECT id, id_card, guest_name, result, issued_by, attempt_time
            FROM verification_attempts
            WHERE ${conditions.join(' AND ')}
            ORDER BY attempt_time DESC
            LIMIT ${limitNum}
        `;
        
        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Get attempts error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// บันทึกการออกรหัส Wi-Fi (รับข้อมูลจาก Kiosk)
app.post('/api/admin/issue-wifi', requireAuth, async (req, res) => {
    const { org_id, username, password, id_card, issued_by } = req.body; 
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // คำนวณเวลาหมดอายุจากโควตา (นับจากวันที่ปัจจุบัน)
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

        // เช็คว่ามีประวัติรับรหัสเดิมอยู่ไหม เพื่อ Reset สิทธิ์และเวลา
        const existingCred = await client.query('SELECT id FROM wifi_credentials WHERE user_id = $1', [userId]);

        if (existingCred.rows.length > 0) {
            // อัปเดตเวลาลงทะเบียนใหม่ (create_time) และต่อเวลาหมดอายุ (expire_time) ให้ใหม่
            await client.query(`
                UPDATE wifi_credentials 
                SET password = $1, 
                    expire_time = $2, 
                    create_time = CURRENT_TIMESTAMP, 
                    issued_by = $3
                WHERE user_id = $4
            `, [password, expireTime, issued_by || 'Admin', userId]);
        } else {
            // ถ้าเพิ่งเคยรับครั้งแรก ให้สร้างใหม่
            await client.query(`
                INSERT INTO wifi_credentials (user_id, password, expire_time, issued_by)
                VALUES ($1, $2, $3, $4)
            `, [userId, password, expireTime, issued_by || 'Admin']);
        }

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

// ดึงรายชื่อ staff ที่เคย/ยังไม่เคยออกรหัส สำหรับ dropdown chart
app.get('/api/dashboard/org/:id/staff', requireAuth, async (req, res) => {
    const orgId = req.params.id;
    try {
        let query;
        let params = [];
        
        if (orgId === 'all') {
            query = `
                SELECT 
                    CASE 
                        WHEN auth_type = 'local' THEN display_name
                        WHEN auth_type = 'ku_sso' THEN ku_email
                    END AS name
                FROM org_employees 
                WHERE is_active = true
                ORDER BY name
            `;
        } else {
            query = `
                SELECT 
                    CASE 
                        WHEN auth_type = 'local' THEN display_name
                        WHEN auth_type = 'ku_sso' THEN ku_email
                    END AS name
                FROM org_employees 
                WHERE org_id = $1 AND is_active = true
                ORDER BY name
            `;
            params = [orgId];
        }
        
        const result = await pool.query(query, params);
        const names = result.rows.map(r => r.name).filter(Boolean);
        
        res.json({ 
            success: true, 
            staff: ['Admin', ...names]
        });
    } catch (err) {
        console.error('Get staff list error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ดึงข้อมูล Dashboard ขององค์กร และประวัติผู้ใช้งาน
app.get('/api/dashboard/org/:id', requireAuth, async (req, res) => {
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

// ดึงรายชื่อ staff ที่เคย/ยังไม่เคยออกรหัส สำหรับ dropdown chart
app.get('/api/dashboard/org/:id/staff', requireAuth, async (req, res) => {
    const orgId = req.params.id;
    try {
        let query;
        let params = [];
        
        if (orgId === 'all') {
            // ทุก org รวมกัน
            query = `
                SELECT 
                    CASE 
                        WHEN auth_type = 'local' THEN display_name
                        WHEN auth_type = 'ku_sso' THEN ku_email
                    END AS name,
                    auth_type
                FROM org_employees 
                WHERE is_active = true
                ORDER BY auth_type, name
            `;
        } else {
            query = `
                SELECT 
                    CASE 
                        WHEN auth_type = 'local' THEN display_name
                        WHEN auth_type = 'ku_sso' THEN ku_email
                    END AS name,
                    auth_type
                FROM org_employees 
                WHERE org_id = $1 AND is_active = true
                ORDER BY auth_type, name
            `;
            params = [orgId];
        }
        
        const result = await pool.query(query, params);
        // กรอง null ออกและเพิ่ม 'Admin' ตัวแรกเสมอ
        const names = result.rows
            .map(r => r.name)
            .filter(Boolean);
        
        res.json({ 
            success: true, 
            staff: ['Admin', ...names]    // Admin = Org Admin ที่ออกรหัสเอง
        });
    } catch (err) {
        console.error('Get staff list error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// ระบบ Cleanup (ล้างข้อมูลเก่า)
// ==========================================
setInterval(async () => {
    try {
        const delCreds = await pool.query("DELETE FROM wifi_credentials WHERE expire_time < NOW() - INTERVAL '90 days'");
        
        // ✨ ลบ attempts ที่หมดอายุ
        const delAttempts = await pool.query(
            "DELETE FROM verification_attempts WHERE expires_at IS NOT NULL AND expires_at < NOW()"
        );
        
        const disableOrgs = await pool.query(`
            UPDATE organizations SET is_active = false 
            WHERE org_type = false AND org_id IN (
                SELECT org_id FROM org_access_periods WHERE access_end < CURRENT_DATE
            ) AND is_active = true
        `);
        
        if (delCreds.rowCount > 0 || delAttempts.rowCount > 0 || disableOrgs.rowCount > 0) {
            console.log(`🧹 Cleanup: รหัส ${delCreds.rowCount}, attempts ${delAttempts.rowCount}, ปิด admin ${disableOrgs.rowCount}`);
        }
    } catch (err) {
        console.error("Cleanup error:", err);
    }
}, 60000);

app.listen(PORT, () => console.log(`🚀 PostgreSQL Server running on http://localhost:${PORT}`));