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

// [Popup] ฟังก์ชันสำหรับเปิดกล่อง "ดูข้อมูล Dashboard"
async function viewOrgDetails(id) {
    // ล้างข้อมูลตารางเป็น Loading ก่อน
    const tbody = document.getElementById('dash-history-body');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3"><div class="spinner-border spinner-border-sm text-success" role="status"></div> กำลังโหลดข้อมูล...</td></tr>';
    
    // เปิด Popup
    const viewModal = new bootstrap.Modal(document.getElementById('viewModal'));
    viewModal.show();

    try {
        // ยิงไปขอข้อมูลจาก API ที่เราเพิ่งเขียน
        const res = await fetch(`/api/dashboard/org/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
        const data = await res.json();
        
        if(data.success) {
            // ยัดตัวเลขลงกล่องสถิติ
            document.getElementById('dash-today').innerText = data.stats.today;
            document.getElementById('dash-week').innerText = data.stats.this_week;
            document.getElementById('dash-month').innerText = data.stats.this_month;
            document.getElementById('dash-3month').innerText = data.stats.three_months;
            document.getElementById('dash-active').innerText = data.activeCount;
            document.getElementById('dash-inactive').innerText = data.inactiveCount;

            // วาดตารางประวัติ
            tbody.innerHTML = '';
            if(data.history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">ยังไม่มีประวัติการออกบัตรสำหรับองค์กรนี้</td></tr>';
            } else {
                data.history.forEach(user => {
                    const createDate = new Date(user.created_at).toLocaleString('th-TH');
                    
                    // ป้ายสถานะ
                    const statusBadge = user.status === 'Active' 
                        ? '<span class="badge bg-success">Active</span>'
                        : '<span class="badge bg-secondary">Inactive</span>';

                    // 🔒 ซ่อนเลขบัตรประชาชนตรงกลางเพื่อ PDPA (ความปลอดภัยข้อมูลส่วนบุคคล)
                    const hiddenIdCard = user.id_card && user.id_card.length === 13 
                        ? user.id_card.substring(0, 3) + 'XXXXXXX' + user.id_card.substring(10) 
                        : '-';

                    tbody.innerHTML += `
                        <tr>
                            <td>${user.fname_th || '-'} ${user.lname_th || ''}</td>
                            <td>${hiddenIdCard}</td>
                            <td><span class="badge bg-light text-dark border">${user.username}</span></td>
                            <td>${createDate}</td>
                            <td>${statusBadge}</td>
                        </tr>
                    `;
                });
            }
        }
    } catch (error) {
        console.error("Fetch Dashboard Error:", error);
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-3">เกิดข้อผิดพลาดในการโหลดข้อมูลเซิร์ฟเวอร์</td></tr>';
    }
}

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
            document.getElementById('ana-today').innerText = data.stats.today;
            document.getElementById('ana-week').innerText = data.stats.this_week;
            document.getElementById('ana-month').innerText = data.stats.this_month;
            document.getElementById('ana-3month').innerText = data.stats.three_months;
            
            renderOrgDoughnutChart(data.activeCount, data.inactiveCount);
            
            // ตรวจสอบโครงสร้างเนื้อหาข้อมูลประวัติ หากไม่มีสมาชิกใหม่เพิ่มเข้ามาจริง จะข้ามการวาดตารางใหม่
            const currentHistoryJSON = JSON.stringify(data.history);
            if (lastHistoryJSON !== currentHistoryJSON) {
                lastHistoryJSON = currentHistoryJSON;
                currentLoadedHistory = data.history;
                const empSelect = document.getElementById('employeeSelector');
                empSelect.innerHTML = '<option value="all">แสดงผลงานของทุกคน</option>';
                const uniqueEmps = [...new Set(data.history.map(u => u.issued_by || 'Admin'))];
                uniqueEmps.forEach(emp => {
                    empSelect.innerHTML += `<option value="${emp}">${emp}</option>`;
                });
                filterUserTimeframe('all'); 
            }
        }
    } catch (e) {
        console.error("โหลดข้อมูล Analytics ไม่สำเร็จ", e);
    }
}

// 3. ฟังก์ชันระบบฟิลเตอร์คัดกรองช่วงเวลาผู้ใช้ (วันนี้ / สัปดาห์นี้ / เดือนนี้)
// ตัวแปรสำหรับจำค่าว่าตอนนี้กำลังเลือกช่วงเวลาไหนอยู่
let currentTimeframe = 'all';

window.filterUserTimeframe = function(timeframe) {
    currentTimeframe = timeframe;
    const selectedEmp = document.getElementById('employeeSelector').value;

    document.querySelectorAll('.btn-group .btn').forEach(btn => btn.classList.remove('active'));
    const activeButton = document.getElementById(`filter-${timeframe}`);
    if (activeButton) activeButton.classList.add('active');

    // ย้ายการกำหนดวันที่มาไว้ "นอก Loop" เพื่อป้องกันบั๊กวันที่เพี้ยน
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

    // 3. แสดงผลตามการเลือกพนักงาน
    if (selectedEmp === 'all') {
        chartContainer.classList.remove('d-none');
        singleStatContainer.classList.add('d-none');
        
        const empCounts = {};
        uniqueUsersList.forEach(u => {
            const empName = u.issued_by || 'Admin'; // ป้องกันค่าว่าง
            empCounts[empName] = (empCounts[empName] || 0) + 1;
        });

        if (empPerformanceChartInstance) empPerformanceChartInstance.destroy();
        const ctx = document.getElementById('empPerformanceChart').getContext('2d');
        empPerformanceChartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: Object.keys(empCounts),
                datasets: [{ data: Object.values(empCounts), backgroundColor: ['#006664', '#B2BB1E', '#17a2b8', '#ffc107', '#6c757d'] }]
            },
            options: { maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
        });
        
        renderAnalyticsTable(uniqueUsersList);
        
    } else {
        chartContainer.classList.add('d-none');
        singleStatContainer.classList.remove('d-none');
        
        // ต้องดักค่าว่างเป็น 'Admin' เพื่อให้กรองตรงกับ Dropdown
        const myUniqueUsers = uniqueUsersList.filter(u => (u.issued_by || 'Admin') === selectedEmp);
        document.getElementById('single-emp-count').innerText = myUniqueUsers.length;
        
        renderAnalyticsTable(myUniqueUsers);
    }
};

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
            
        const maskedIdCard = user.id_card && user.id_card.length === 13 
            ? user.id_card.substring(0,3) + "-XXXXX-" + user.id_card.substring(10)
            : '-';
            
        tbody.innerHTML += `
            <tr>
                <td class="px-4 font-mono text-muted">${maskedIdCard}</td>
                <td><span class="badge bg-light text-dark border font-mono">${esc(user.username)}</span></td>
                <td><small class="text-primary fw-semibold">${esc(user.org_name)}</small></td>
                <td><small>${dateStr}</small></td>
                <td><span class="badge bg-info text-dark shadow-sm">${esc(user.issued_by || 'Admin')}</span></td> <td><small>${dateStr}</small></td>
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
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
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
                    legend: { position: 'bottom', labels: { boxWidth: 12 } }
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
        const res = await fetch(`/api/admin/employees?org_id=${orgId}`);
        const result = await res.json();
        const tbody = document.getElementById(`emp-tbody-${orgId}`);
        if (result.data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">ยังไม่มีการเพิ่มพนักงานในองค์กรนี้</td></tr>';
        } else {
            tbody.innerHTML = result.data.map(emp => `
                <tr>
                    <td class="fw-bold">${emp.ku_email}</td>
                    <td>${emp.emp_policy_days}</td>
                    <td class="text-center"><button class="btn btn-sm btn-outline-danger py-0" onclick="deleteEmpFromSuperAdmin(${emp.id}, ${orgId})">ลบสิทธิ์</button></td>
                </tr>
            `).join('');
        }
    } else {
        row.classList.add('d-none');
    }
}

async function deleteEmpFromSuperAdmin(empId, orgId) {
    if(!confirm('ยืนยันการลบสิทธิ์พนักงาน?')) return;
    await fetch(`/api/admin/employees/${empId}`, { method: 'DELETE' });
    document.getElementById(`emp-row-${orgId}`).classList.add('d-none'); 
    toggleEmployeeRow(orgId); // โหลดใหม่
}

async function loadEmployees() {
    if (!currentOrgId) return;
    const res = await fetch(`http://127.0.0.1:3000/api/admin/employees?org_id=${currentOrgId}`);
    const result = await res.json();
    const tbody = document.getElementById('employee-table-body');
    tbody.innerHTML = '';
    result.data.forEach(emp => {
        tbody.innerHTML += `<tr><td class="fw-bold text-primary">${emp.ku_email}</td><td>${emp.emp_policy_days} วัน</td><td class="text-center"><button class="btn btn-sm btn-danger px-3" onclick="deleteEmployee(${emp.id})">ลบสิทธิ์</button></td></tr>`;
    });
}

document.getElementById('add-employee-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('http://127.0.0.1:3000/api/admin/employees', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: currentOrgId, ku_email: document.getElementById('empEmail').value, emp_policy_days: document.getElementById('empDays').value })
    });
    const result = await res.json();
    if (result.success) { document.getElementById('empEmail').value = ''; loadEmployees(); }
    else alert(result.message);
});

async function deleteEmployee(empId) {
    if(!confirm('ลบสิทธิ์พนักงานคนนี้?')) return;
    await fetch(`http://127.0.0.1:3000/api/admin/employees/${empId}`, { method: 'DELETE' });
    loadEmployees();
}

if(document.getElementById('employee-table-body')) loadEmployees();

setInterval(() => {
    // ถ้าหน้าต่าง Popup (Modal) ไม่ได้เปิดอยู่ ค่อยโหลดข้อมูลใหม่ เพื่อไม่ให้ขัดจังหวะการใช้งาน
    if (!document.body.classList.contains('modal-open')) {
        // 1. อัปเดตข้อมูลหน้าหลัก
        fetchStats();
        fetchOrganizations();
        
        // 2. อัปเดตข้อมูลหน้าวิเคราะห์ (กราฟและตารางคน) เฉพาะตอนที่ผู้ใช้เลือกองค์กรไว้แล้ว
        const selectedOrg = document.getElementById('orgSelector');
        if (selectedOrg && selectedOrg.value) {
            loadSelectedOrgAnalytics();
        }
    }
}, 5000);