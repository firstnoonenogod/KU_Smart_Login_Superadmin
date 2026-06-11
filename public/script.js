let lastActiveCount = null;
let lastInactiveCount = null;
let lastHistoryJSON = "";
let empPerformanceChartInstance = null;

const currentOrgId = sessionStorage.getItem('org_id'); // ดึง ID องค์กรตอนแอดมินล็อกอิน
const token = sessionStorage.getItem('superAdminToken');
if (!token) {
    window.location.href = 'login.html'; 
}

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// ===== Theme toggle (Light / Dark) =====
function applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme);
    localStorage.setItem('superadmin-theme', theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-bs-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
    
    // Re-render charts ที่ active อยู่
    setTimeout(() => {
        // Destroy เพื่อ force rebuild ด้วยสีใหม่
        if (globalBarChartInstance) { globalBarChartInstance.destroy(); globalBarChartInstance = null; }
        if (orgDoughnutChartInstance) { orgDoughnutChartInstance.destroy(); orgDoughnutChartInstance = null; }
        if (empPerformanceChartInstance) { empPerformanceChartInstance.destroy(); empPerformanceChartInstance = null; }
        if (singleEmpChartInstance) { singleEmpChartInstance.destroy(); singleEmpChartInstance = null; }
        
        // Reset cache เพื่อให้ orgDoughnut rebuild
        lastActiveCount = null;
        lastInactiveCount = null;
        lastHistoryJSON = "";
        
        // Reload data
        fetchOrganizations();   // rebuild globalBarChart
        const orgSelector = document.getElementById('orgSelector');
        if (orgSelector && document.getElementById('analytics-panel').classList.contains('active')) {
            if (typeof loadSelectedOrgAnalytics === 'function') loadSelectedOrgAnalytics();
        }
    }, 100);
}

// Init theme on load (ก่อน DOM render เพื่อกันกระพริบ)
(function initTheme() {
    const saved = localStorage.getItem('superadmin-theme') || 'light';
    applyTheme(saved);
})();

function getChartTextColor() {
    return document.documentElement.getAttribute('data-bs-theme') === 'dark' 
        ? '#cbd5e1' : '#475569';
}

// 1. ฟังก์ชันดึงสถิติตัวเลขด้านบน
async function fetchStats() {
    try {
        const res = await fetch('/api/dashboard/stats', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
        const data = await res.json();
        document.getElementById('stat-orgs').innerText = data.total_orgs;
        document.getElementById('stat-users').innerText = data.total_wifi_users;
    } catch (error) {
        console.error("ไม่สามารถดึงสถิติได้", error);
    }
}

// 2. ซ่อน/แสดง ช่อง "อายุการใช้งานของ Admin" ตามประเภทองค์กร
const radios = document.querySelectorAll('input[name="orgType"]');
const adminValidityDiv = document.getElementById('adminValidityDiv');

radios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        if (e.target.value === 'external') {
            adminValidityDiv.style.display = 'block';
            document.getElementById('adminValidity').required = true;
        } else {
            adminValidityDiv.style.display = 'none';
            document.getElementById('adminValidity').required = false;
        }
    });
});

async function fetchOrganizations() {
    const res = await fetch('/api/organizations', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const orgs = await res.json();
    
    const tbody = document.getElementById('org-table-body');
    tbody.innerHTML = '';
    
    orgs.forEach(org => {
        let typeBadge = org.org_type === 'internal' 
            ? '<span class="badge bg-success">ภายใน</span>' 
            : '<span class="badge bg-warning text-dark">ภายนอก</span>';
            
        let expiryText = org.org_type === 'internal' 
            ? '<span class="text-success fw-bold">ถาวร</span>' 
            : `<span class="text-danger fw-bold">ชั่วคราว</span>`;

    tbody.innerHTML += `
        <tr class="align-middle">
            <td class="px-4">${esc(org.name)} <br> ${typeBadge}</td>
            <td><span class="badge bg-secondary">${esc(org.admin_user)}</span></td>
            <td>ให้ User ละ ${org.user_policy_days} วัน</td>
            <td>${expiryText}</td>
            <td class="text-center">
                <button class="btn btn-sm btn-info shadow-sm rounded-pill px-3 me-1 text-white" onclick="toggleEmployeeRow(${org.id})">👥 ดูพนักงาน</button>
                <button class="btn btn-sm btn-primary shadow-sm rounded-pill px-3 me-1" onclick="shortcutToAnalytics(${org.id})">ดูกราฟ</button>
                <button class="btn btn-sm btn-danger shadow-sm rounded-pill px-3" onclick="deleteOrg(${org.id}, '${org.name}')">ลบ</button>
            </td>
        </tr>
        <tr id="emp-row-${org.id}" class="d-none bg-light">
            <td colspan="5" class="p-3">
                <div class="card card-body border-0 shadow-sm">
                    <h6 class="text-primary fw-bold mb-3">รายชื่อพนักงานที่ได้รับสิทธิ์ KU ALL-Login (องค์กร: ${esc(org.name)})</h6>
                    <table class="table table-sm table-bordered mb-0 bg-white">
                        <thead class="table-secondary"><tr><th>อีเมลพนักงาน</th><th>โควตา (วัน)</th><th class="text-center">จัดการ</th></tr></thead>
                        <tbody id="emp-tbody-${org.id}"><tr><td colspan="3" class="text-center text-muted">กำลังดึงข้อมูล...</td></tr></tbody>
                    </table>
                </div>
            </td>
        </tr>
    `;
    });
    // สั่งอัปเดตแผนภูมิแท่งเปรียบเทียบยอดหน้าแรกทันที
    renderGlobalBarChart(orgs);
}

// ----------------------------------------------------
// ระบบจัดการ Popup (แทนที่ alert/confirm เดิม)
// ----------------------------------------------------
// ตัวแปรเก็บ ID ชั่วคราวตอนกดปุ่มลบ
let currentDeleteId = null; 

// [Popup] ฟังก์ชันเปิดกล่อง "ยืนยันการลบ"
function deleteOrg(id, name) {
    currentDeleteId = id; // จำ ID ไว้ก่อน
    document.getElementById('deleteModalOrgName').innerText = name; // เอาชื่อไปโชว์ในกล่อง
    const deleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
    deleteModal.show();
}

// [Popup] เมื่อผู้ใช้กดปุ่ม "ยืนยันการลบ" ในกล่องแดง
document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    if (!currentDeleteId) return;

    // สั่งซ่อนกล่องยืนยัน
    const deleteModal = bootstrap.Modal.getInstance(document.getElementById('deleteModal'));
    deleteModal.hide();

    // ดำเนินการลบข้อมูลผ่าน API
    const res = await fetch(`/api/organizations/${currentDeleteId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const result = await res.json();
    if(result.success) {
        fetchOrganizations(); // โหลดตารางใหม่
        fetchStats();         // อัปเดตตัวเลข
    } else {
        alert("ไม่สามารถสร้างองค์กรได้: " + (result.message || "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์"));
    }
});

// ----------------------------------------------------
// 5. จัดการเมื่อกดปุ่มบันทึกเพิ่มองค์กร
// ----------------------------------------------------
document.getElementById('addOrgForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const orgType = document.querySelector('input[name="orgType"]:checked').value;
    
    const payload = {
        name: document.getElementById('orgName').value,
        org_type: orgType,
        user_policy_days: document.getElementById('userPolicy').value,
        admin_validity_days: orgType === 'external' ? document.getElementById('adminValidity').value : null
    };

    const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' , 'Authorization': `Bearer ${token}`},
        body: JSON.stringify(payload)
    });

    const result = await res.json();
    if(result.success) {
        // 1. ปิดหน้าต่าง "เพิ่มองค์กร"
        const addModal = bootstrap.Modal.getInstance(document.getElementById('addOrgModal'));
        addModal.hide();
        
        // 2. เอา Username/Password ไปใส่ในกล่อง "สำเร็จ"
        document.getElementById('showAdminUser').innerText = result.data.admin_user;
        document.getElementById('showAdminPass').innerText = result.data.admin_pass;
        
        // 3. เปิดกล่อง Popup "สำเร็จ"
        const successModal = new bootstrap.Modal(document.getElementById('successModal'));
        successModal.show();
        
        // 4. โหลดตารางและตัวเลขใหม่
        fetchOrganizations();
        fetchStats(); 
        
        // 5. ล้างฟอร์มไว้รอการกรอกรอบหน้า
        document.getElementById('addOrgForm').reset();
        adminValidityDiv.style.display = 'none'; 
    }
});

// 6. โหลดข้อมูลสถิติและตารางทันทีเมื่อเปิดหน้าเว็บ
window.onload = () => {
    fetchStats();
    fetchOrganizations();
};

// ====================================================
// สคริปต์ระบบสลับหน้าวิเคราะห์ข้อมูล, ฟิลเตอร์ช่วงเวลา และวาดกราฟ (Chart.js)
// ====================================================

let globalBarChartInstance = null;
let orgDoughnutChartInstance = null;
let currentLoadedHistory = []; // เก็บประวัติผู้ใช้ชั่วคราวเพื่อทำฟิลเตอร์หน้าบ้าน

// 1. ฟังก์ชันดึงรายชื่อแอดมินองค์กรทั้งหมดมาใส่ในช่องดรอปดาวน์เลือกข้อมูล
async function initAnalyticsPage() {
    try {
        const res = await fetch('/api/organizations', {
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('superAdminToken')}` }
        });
        const orgs = await res.json();
        
        const selector = document.getElementById('orgSelector');
        // ล้างข้อมูลยกเว้นตัวเลือกแรก
        selector.innerHTML = '<option value="all">ดูภาพรวมทุกองค์กรทั้งหมด</option>';
        
        orgs.forEach(org => {
            const opt = document.createElement('option');
            opt.value = org.id;
            opt.innerText = `${org.name} (${org.admin_user})`;
            selector.appendChild(opt);
        });
        
        // สั่งวาดกราฟเปรียบเทียบในหน้าหลักตัวแรกด้วย
        renderGlobalBarChart(orgs);
        // สั่งโหลดข้อมูลภาพรวมทั้งหมดมาขึ้นจอก่อนเริ่มต้น
        loadSelectedOrgAnalytics();
    } catch (e) {
        console.error("โหลดรายชื่อองค์กรล้มเหลว", e);
    }
}

// 2. ฟังก์ชันหลักในการดึงข้อมูลส่วนตัวของแอดมินที่ถูกเลือก
async function loadSelectedOrgAnalytics() {
    const orgId = document.getElementById('orgSelector').value;
    try {
        const res = await fetch(`/api/dashboard/org/${orgId}`, {
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('superAdminToken')}` }
        });
        const data = await res.json();
        
        if (data.success) {
            renderOrgDoughnutChart(data.activeCount, data.inactiveCount);
            
            // ตรวจสอบโครงสร้างเนื้อหาข้อมูลประวัติ หากไม่มีสมาชิกใหม่เพิ่มเข้ามาจริง จะข้ามการวาดตารางใหม่
            const currentHistoryJSON = JSON.stringify(data.history);
            if (lastHistoryJSON !== currentHistoryJSON) {
                lastHistoryJSON = currentHistoryJSON;
                currentLoadedHistory = data.history;
                
                // ดึงรายชื่อ staff ของ org ทั้งหมด (รวมคนที่ยังไม่เคยออกรหัส)
                await loadStaffDropdown(orgId);
                
                filterUserTimeframe('all');
            }
        }
    } catch (e) {
        console.error("โหลดข้อมูล Analytics ไม่สำเร็จ", e);
    }
}

// ดึงรายชื่อ staff ทั้งหมดในองค์กรเพื่อใส่ใน dropdown (รวมที่ยังไม่เคยออกรหัส)
async function loadStaffDropdown(orgId) {
    try {
        const res = await fetch(`/api/dashboard/org/${orgId}/staff`, {
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('superAdminToken')}` }
        });
        const result = await res.json();
        
        const empSelect = document.getElementById('employeeSelector');
        empSelect.innerHTML = '<option value="all">แสดงผลงานของทุกคน</option>';
        
        if (result.success && Array.isArray(result.staff)) {
            result.staff.forEach(name => {
                empSelect.innerHTML += `<option value="${esc(name)}">${esc(name)}</option>`;
            });
        }
    } catch (e) {
        console.error('โหลด staff dropdown ไม่สำเร็จ:', e);
    }
}

// 3. ฟังก์ชันระบบฟิลเตอร์คัดกรองช่วงเวลาผู้ใช้ (วันนี้ / สัปดาห์นี้ / เดือนนี้)
// ตัวแปรสำหรับจำค่าว่าตอนนี้กำลังเลือกช่วงเวลาไหนอยู่
let currentTimeframe = 'all';

window.filterUserTimeframe = function(timeframe) {
    currentTimeframe = timeframe;
    const selectedEmp = document.getElementById('employeeSelector').value;
    const selectedOrg = document.getElementById('orgSelector').value;  // ✨ ใหม่

    document.querySelectorAll('.btn-group .btn').forEach(btn => btn.classList.remove('active'));
    const activeButton = document.getElementById(`filter-${timeframe}`);
    if (activeButton) activeButton.classList.add('active');

    const now = new Date();
    const todayStr = now.toDateString();
    
    const past7Days = new Date(); 
    past7Days.setDate(now.getDate() - 7);
    
    const past30Days = new Date(); 
    past30Days.setDate(now.getDate() - 30);

    // 1. กรองตามช่วงเวลา
    let filteredUsers = currentLoadedHistory.filter(user => {
        const userDate = new Date(user.created_at);
        if (timeframe === 'today') return userDate.toDateString() === todayStr;
        if (timeframe === 'week') return userDate >= past7Days;
        if (timeframe === 'month') return userDate >= past30Days;
        return true;
    });

    // 2. คำนวณรหัส Wi-Fi แบบไม่ซ้ำ (Unique Users)
    const uniqueUsersMap = new Map();
    filteredUsers.forEach(u => uniqueUsersMap.set(u.id_card, u));
    const uniqueUsersList = Array.from(uniqueUsersMap.values());

    const chartContainer = document.getElementById('emp-chart-container');
    const singleStatContainer = document.getElementById('single-emp-stat');

    if (selectedEmp === 'all') {
        // ===== L1 หรือ L2: doughnut chart =====
        chartContainer.classList.remove('hidden');
        chartContainer.classList.remove('d-none');
        singleStatContainer.classList.add('hidden');
        singleStatContainer.classList.add('d-none');
        
        const counts = {};
        let chartTitle = '';
        
        if (selectedOrg === 'all') {
            // 🆕 L1: ทุก org → group by org_name
            uniqueUsersList.forEach(u => {
                const key = u.org_name || 'ไม่ระบุองค์กร';
                counts[key] = (counts[key] || 0) + 1;
            });
            chartTitle = 'แยกตามองค์กร';
        } else {
            // L2: ราย org → group by staff
            uniqueUsersList.forEach(u => {
                const key = u.issued_by || 'Admin';
                counts[key] = (counts[key] || 0) + 1;
            });
            chartTitle = 'แยกตามพนักงาน';
        }
        
        renderDoughnutChart(counts, chartTitle);
        renderAnalyticsTable(uniqueUsersList);
        
    } else {
        // ===== 🆕 L3: เลือกพนักงานคนเดียว → active vs expired =====
        chartContainer.classList.add('hidden');
        chartContainer.classList.add('d-none');
        singleStatContainer.classList.remove('hidden');
        singleStatContainer.classList.remove('d-none');
        
        const myUsers = uniqueUsersList.filter(u => (u.issued_by || 'Admin') === selectedEmp);
        
        const activeUsers = myUsers.filter(u => u.expire_time && new Date(u.expire_time) >= now);
        const expiredUsers = myUsers.filter(u => !u.expire_time || new Date(u.expire_time) < now);
        
        renderActiveInactiveStats(selectedEmp, activeUsers.length, expiredUsers.length);
        renderAnalyticsTable(myUsers);
    }
};

// ===== Helper: Doughnut chart (รองรับทั้ง L1 by org และ L2 by staff) =====
function renderDoughnutChart(counts, titleLabel) {
    if (empPerformanceChartInstance) empPerformanceChartInstance.destroy();
    
    const ctx = document.getElementById('empPerformanceChart');
    if (!ctx) return;
    
    if (Object.keys(counts).length === 0) {
        // empty state
        const c = ctx.getContext('2d');
        c.clearRect(0, 0, ctx.width, ctx.height);
        c.font = '14px Krub, sans-serif';
        c.fillStyle = '#94a3b8';
        c.textAlign = 'center';
        c.fillText('ยังไม่มีข้อมูล', ctx.width / 2, ctx.height / 2);
        return;
    }
    
    const palette = ['#006664', '#B2BB1E', '#17a2b8', '#ffc107', '#6c757d', 
                     '#dc3545', '#fd7e14', '#20c997', '#0d6efd', '#6610f2',
                     '#198754', '#e83e8c', '#0dcaf0', '#adb5bd'];
    const colors = Object.keys(counts).map((_, i) => palette[i % palette.length]);
    
    empPerformanceChartInstance = new Chart(ctx.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: Object.keys(counts),
            datasets: [{ 
                data: Object.values(counts), 
                backgroundColor: colors,
                borderWidth: 2,
                borderColor: '#fff'
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: { 
                    position: 'right',
                    labels: { color: getChartTextColor() }
                },
                title: { 
                    display: true, 
                    text: titleLabel, 
                    font: { size: 13 },
                    color: getChartTextColor()
                }
            }
        }
    });
}

// ===== Helper: Active/Expired stats สำหรับ L3 =====
let singleEmpChartInstance = null;
function renderActiveInactiveStats(staffName, activeCount, expiredCount) {
    const total = activeCount + expiredCount;
    
    // อัปเดตตัวเลขใหญ่
    const nameEl = document.getElementById('single-emp-name');
    const countEl = document.getElementById('single-emp-count');
    const activeEl = document.getElementById('single-emp-active');
    const expiredEl = document.getElementById('single-emp-expired');
    
    if (nameEl) nameEl.innerText = staffName;
    if (countEl) countEl.innerText = total;
    if (activeEl) activeEl.innerText = activeCount;
    if (expiredEl) expiredEl.innerText = expiredCount;
    
    // วาด mini chart
    const canvas = document.getElementById('singleEmpChart');
    if (!canvas) return;
    
    if (singleEmpChartInstance) singleEmpChartInstance.destroy();
    
    if (total === 0) {
        // empty state
        const c = canvas.getContext('2d');
        c.clearRect(0, 0, canvas.width, canvas.height);
        c.font = '14px Krub, sans-serif';
        c.fillStyle = '#94a3b8';
        c.textAlign = 'center';
        c.fillText('ยังไม่มีการออกรหัส', canvas.width / 2, canvas.height / 2);
        return;
    }
    
    singleEmpChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['🟢 Active', '🔴 หมดอายุ'],
            datasets: [{
                data: [activeCount, expiredCount],
                backgroundColor: ['#28a745', '#dc3545'],
                borderWidth: 2,
                borderColor: '#fff'
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: { 
                    position: 'bottom',
                    labels: { color: getChartTextColor() }
                },
                title: { 
                    display: true, 
                    text: `สถานะรหัสที่ออกโดย ${staffName}`, 
                    font: { size: 13 },
                    color: getChartTextColor()
                }
            }
        }
    });
}

// 4. ฟังก์ชันวาดรายชื่อข้อมูลผู้ใช้ลงตารางประวัติ
function renderAnalyticsTable(users) {
    const tbody = document.getElementById('analytics-table-body');
    tbody.innerHTML = '';
    
    if (users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">❌ ไม่พบประวัติผู้ใช้งานในช่วงเวลาดังกล่าว</td></tr>';
        return;
    }
    
    users.forEach(user => {
        const dateStr = new Date(user.created_at).toLocaleString('th-TH');
        const badge = user.status === 'Active' 
            ? '<span class="badge bg-success">Active</span>' 
            : '<span class="badge bg-secondary">Inactive</span>';
            
        const maskedIdCard = user.id_card && user.id_card.length === 5
            ? user.id_card.substring(0,1) + '-' + user.id_card.substring(1) + '-XXXXX-XX-X'
            : '-';
        // ผลลัพธ์: "1-2345-XXXXX-XX-X"
            
        tbody.innerHTML += `
        <tr>
            <td class="px-4 font-mono text-muted">${maskedIdCard}</td>
            <td><span class="badge bg-light text-dark border font-mono">${esc(user.username)}</span></td>
            <td><small class="text-primary fw-semibold">${esc(user.org_name)}</small></td>
            <td><small>${dateStr}</small></td>
            <td><span class="badge bg-info text-dark shadow-sm">${esc(user.issued_by || 'Admin')}</span></td>
            <td class="text-center">${badge}</td>
        </tr>
    `;
    });
}

// 5. 📊 ฟังก์ชันวาดกราฟแท่งเปรียบเทียบแอดมินหน้าแรก (Bar Chart)
function renderGlobalBarChart(orgs) {
    const ctx = document.getElementById('globalBarChart').getContext('2d');
    const labels = orgs.map(o => o.name);
    const dataValues = orgs.map(o => o.user_count || 0); 
    
    if (globalBarChartInstance) {
        // หากมีกราฟอยู่แล้ว ให้ทำการส่ง Data ใหม่เข้าไปแอนิเมชันแทนการ Re-create
        globalBarChartInstance.data.labels = labels;
        globalBarChartInstance.data.datasets[0].data = dataValues;
        globalBarChartInstance.update();
    } else {
        globalBarChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'ยอดผู้ใช้งาน Wi-Fi (คน)',
                    data: dataValues,
                    backgroundColor: '#006664',
                    borderRadius: 5
                }]
            },
            options: {
                responsive: true,
                indexAxis: 'y',
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { 
                        beginAtZero: true,
                        ticks: { stepSize: 1, color: getChartTextColor() }
                    },
                    y: { 
                        ticks: { color: getChartTextColor() }
                    }
                }
            }
        });
    }
}

// 6. 🍩 ฟังก์ชันวาดกราฟวงกลมโดนัทสัดส่วนบัตร (Doughnut Chart)
function renderOrgDoughnutChart(active, inactive) {
    const ctx = document.getElementById('orgDoughnutChart').getContext('2d');
    
    // หากข้อมูลสถานะเท่าเดิมเป๊ะ ไม่ต้องขยับเขยื้อนโครงสร้างกราฟ
    if (lastActiveCount === active && lastInactiveCount === inactive) {
        return; 
    }
    
    lastActiveCount = active;
    lastInactiveCount = inactive;
    
    if (orgDoughnutChartInstance) {
        orgDoughnutChartInstance.data.datasets[0].data = [active, inactive];
        orgDoughnutChartInstance.update(); // หมุนกราฟนุ่มนวลเฉพาะตอนตัวเลขเปลี่ยน
    } else {
        orgDoughnutChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['ใช้งานอยู่ (Active)', 'หมดอายุ (Inactive)'],
                datasets: [{
                    data: [active, inactive],
                    backgroundColor: ['#28a745', '#6c757d'],
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { 
                        position: 'bottom', 
                        labels: { 
                            boxWidth: 12,
                            color: getChartTextColor()
                        } 
                    }
                }
            }
        });
    }
}

// เชื่อมต่อการกดชื่อองค์กรจากตารางหน้าหลัก ให้กดลิงก์ปุ๊บแล้ววิ่งสลับหน้าแท็บมาดูหน้าวิเคราะห์รายคนได้ทันที
function shortcutToAnalytics(orgId) {
    const tabEl = document.getElementById('analytics-tab');
    const tab = new bootstrap.Tab(tabEl);
    tab.show();
    initAnalyticsPage().then(() => {
        document.getElementById('orgSelector').value = orgId;
        loadSelectedOrgAnalytics();
    });
}

// ====================================================
// ระบบออกจากระบบ (Logout)
// ====================================================
document.getElementById('logoutBtn').addEventListener('click', () => {
    // 1. ถามยืนยัน
    if (confirm('คุณต้องการออกจากระบบใช่หรือไม่?')) {
        // 2. เคลียร์ Token ของ Super Admin ทิ้ง
        sessionStorage.removeItem('superAdminToken');
        
        // 3. (Optional) ล้างข้อมูล Session ทั้งหมดเพื่อความชัวร์ 100%
        sessionStorage.clear();
        
        // 4. เตะกลับไปหน้า Login
        window.location.href = 'login.html';
    }
});

async function toggleEmployeeRow(orgId) {
    const row = document.getElementById(`emp-row-${orgId}`);
    if (row.classList.contains('d-none')) {
        row.classList.remove('d-none');
        const res = await fetch(`/api/admin/employees?org_id=${orgId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        const tbody = document.getElementById(`emp-tbody-${orgId}`);
        
        if (!result.success || !result.data || result.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">ยังไม่มีพนักงาน</td></tr>';
        } else {
            tbody.innerHTML = result.data.map(emp => {
                const isLocal = emp.auth_type === 'local';
                const identity = isLocal 
                    ? `<span class="badge bg-warning text-dark">Local</span> ${emp.display_name} <small class="text-muted">(${emp.username})</small>`
                    : `<span class="badge bg-info">KU SSO</span> ${emp.ku_email}`;
                
                const resetBtn = isLocal
                    ? `<button class="btn btn-sm btn-outline-warning py-0 me-1" onclick="resetStaffPassword(${emp.id}, '${emp.display_name}')">🔑 Reset</button>`
                    : '';
                
                return `<tr>
                    <td>${identity}</td>
                    <td>${emp.emp_policy_days} วัน</td>
                    <td>${emp.is_active ? '✅' : '❌'}</td>
                    <td class="text-center">
                        ${resetBtn}
                        <button class="btn btn-sm btn-outline-danger py-0" onclick="deleteEmpFromSuperAdmin(${emp.id}, ${orgId})">ลบ</button>
                    </td>
                </tr>`;
            }).join('');
        }
    } else {
        row.classList.add('d-none');
    }
}

async function deleteEmpFromSuperAdmin(empId, orgId) {
    if(!confirm('ยืนยันการลบสิทธิ์พนักงาน?')) return;
    await fetch(`/api/admin/employees/${empId}`, { 
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    document.getElementById(`emp-row-${orgId}`).classList.add('d-none'); 
    toggleEmployeeRow(orgId); // โหลดใหม่
}

// ==========================================
// ส่วนจัดการพนักงาน (Super Admin)
// ==========================================
async function loadEmployees() {
    if (!currentOrgId) return;
    try {
        // เพิ่ม headers เพื่อส่ง Token ยืนยันตัวตน
        const res = await fetch(`/api/admin/employees?org_id=${currentOrgId}`, {
            headers: { 'Authorization': `Bearer ${token}` } 
        });
        const result = await res.json();
        
        // 📌 ดัก Error กรณีไม่มีข้อมูลหรือ Token หมดอายุ
        if (!result.success || !result.data) {
            console.error("โหลดข้อมูลพนักงานไม่ได้:", result.message);
            return;
        }

        const tbody = document.getElementById('employee-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (result.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted p-4">ยังไม่มีพนักงานในองค์กรนี้</td></tr>';
            return;
        }

        result.data.forEach(emp => {
            tbody.innerHTML += `
                <tr>
                    <td class="fw-bold text-success">${esc(emp.ku_email)}</td>
                    <td>ให้ User ละ ${emp.emp_policy_days} วัน</td>
                    <td><button class="btn btn-sm btn-danger rounded-pill px-3" onclick="deleteEmployee(${emp.id})">ลบสิทธิ์</button></td>
                </tr>`;
        });
    } catch (e) {
        console.error("เชื่อมต่อระบบจัดการพนักงานล้มเหลว", e);
    }
}

async function showAddEmployeeModal(orgId) {
    // ดึงข้อมูล org เพื่อรู้ว่าภายใน/ภายนอก
    const orgRes = await fetch(`/api/organizations/${orgId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const orgData = await orgRes.json();
    if (!orgData.success) return alert('โหลดข้อมูล org ไม่สำเร็จ');
    
    const isInternal = orgData.data.org_type;
    currentOrgId = orgId;
    
    if (isInternal) {
        // === Org ภายใน: ใส่ KU email ===
        const email = prompt('กรอก KU Email ของพนักงาน (เช่น user@ku.th):');
        if (!email || !email.trim()) return;
        const days = parseInt(prompt('จำนวนวันที่ guest ใช้ Wi-Fi ได้ (1-30):', '1')) || 1;
        
        const res = await fetch('/api/admin/employees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ org_id: orgId, ku_email: email.trim(), emp_policy_days: days })
        });
        const result = await res.json();
        if (result.success) {
            alert('เพิ่มสำเร็จ');
            toggleEmployeeRow(orgId);  // refresh
            toggleEmployeeRow(orgId);
        } else {
            alert('Error: ' + result.message);
        }
    } else {
        // === Org ภายนอก: gen username/password ===
        const displayName = prompt('กรอกชื่อ Staff (ไม่ซ้ำในองค์กร):');
        if (!displayName || !displayName.trim()) return;
        
        const useDefault = confirm('ให้ระบบ gen Username ให้อัตโนมัติ?\n(กด Cancel เพื่อกำหนดเอง)');
        let customUsername = null;
        if (!useDefault) {
            customUsername = prompt('กำหนด Username (ไม่ซ้ำทั้งระบบ):');
            if (!customUsername || !customUsername.trim()) return;
        }
        
        const days = parseInt(prompt('จำนวนวันที่ guest ใช้ Wi-Fi ได้ (1-30):', '1')) || 1;
        
        const res = await fetch('/api/admin/employees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ 
                org_id: orgId, 
                display_name: displayName.trim(),
                username: customUsername,
                emp_policy_days: days 
            })
        });
        const result = await res.json();
        if (result.success && result.credentials) {
            // แสดงรหัสครั้งเดียว
            const msg = `✅ สร้างบัญชีสำเร็จ!\n\n` +
                       `ชื่อ: ${result.credentials.display_name}\n` +
                       `Username: ${result.credentials.username}\n` +
                       `Password: ${result.credentials.password}\n\n` +
                       `⚠️ โปรดแจ้งรหัสนี้แก่ staff — จะไม่แสดงอีกครั้ง`;
            
            // Copy to clipboard
            const copyText = `Username: ${result.credentials.username}\nPassword: ${result.credentials.password}`;
            navigator.clipboard.writeText(copyText).then(() => {
                alert(msg + '\n\n📋 ก็อปไปคลิปบอร์ดแล้ว');
            }).catch(() => alert(msg));
            
            toggleEmployeeRow(orgId);
            toggleEmployeeRow(orgId);
        } else {
            alert('Error: ' + result.message);
        }
    }
}

async function resetStaffPassword(empId, displayName) {
    if (!confirm(`รีเซ็ตรหัสผ่านของ "${displayName}"?`)) return;
    
    const res = await fetch(`/api/admin/employees/${empId}/reset-password`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = await res.json();
    if (result.success && result.credentials) {
        const msg = `🔑 รหัสใหม่:\n\nUsername: ${result.credentials.username}\n` +
                   `Password: ${result.credentials.password}\n\n` +
                   `⚠️ แจ้ง staff โดยเร็ว`;
        navigator.clipboard.writeText(
            `Username: ${result.credentials.username}\nPassword: ${result.credentials.password}`
        );
        alert(msg + '\n\n📋 ก็อปแล้ว');
    } else {
        alert('Error: ' + result.message);
    }
}

async function deleteEmployee(empId) {
    if(!confirm('ลบสิทธิ์พนักงานคนนี้?')) return;
    try {
        await fetch(`/api/admin/employees/${empId}`, { 
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` } // ส่ง Token ไปด้วย
        });
        loadEmployees();
    } catch (e) {
        alert("เซิร์ฟเวอร์มีปัญหา");
    }
}

if(document.getElementById('employee-table-body')) loadEmployees();

setInterval(() => {
    if (!document.body.classList.contains('modal-open')) {
        const isViewingEmp = document.querySelectorAll('tr[id^="emp-row-"]:not(.d-none)').length > 0;
        
        fetchStats();
        
        if (!isViewingEmp) {
            fetchOrganizations();
        }
        
        const selectedOrg = document.getElementById('orgSelector');
        if (selectedOrg && selectedOrg.value) {
            loadSelectedOrgAnalytics();
        }
    }
}, 5000);