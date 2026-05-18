if (sessionStorage.getItem('isSuperAdmin') !== 'true') {
    window.location.href = 'login.html'; 
}

// 1. ฟังก์ชันดึงสถิติตัวเลขด้านบน
async function fetchStats() {
    try {
        const res = await fetch('/api/dashboard/stats');
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

// 3. ฟังก์ชันดึงข้อมูลองค์กรมาแสดงในตาราง
async function fetchOrganizations() {
    const res = await fetch('/api/organizations');
    const orgs = await res.json();
    
    const tbody = document.getElementById('org-table-body');
    tbody.innerHTML = '';
    
    orgs.forEach(org => {
        let typeBadge = org.org_type === 'internal' 
            ? '<span class="badge bg-success">ภายใน</span>' 
            : '<span class="badge bg-warning text-dark">ภายนอก</span>';
            
        let expiryText = org.org_type === 'internal' 
            ? '<span class="text-success fw-bold">ถาวร</span>' 
            : `<span class="text-danger fw-bold">${new Date(org.admin_expiry_date).toLocaleDateString('th-TH')}</span>`;

        tbody.innerHTML += `
            <tr>
                <td class="px-4">${org.name} <br> ${typeBadge}</td>
                <td><span class="badge bg-secondary">${org.admin_user}</span></td>
                <td>ให้ User ละ ${org.user_policy_days} วัน</td>
                <td>${expiryText}</td>
                <td class="text-center">
                    <button class="btn btn-sm btn-primary shadow-sm rounded-pill px-3 me-1" onclick="viewOrgDetails(${org.id})">ดูข้อมูล</button>
                    <button class="btn btn-sm btn-danger shadow-sm rounded-pill px-3" onclick="deleteOrg(${org.id}, '${org.name}')">ลบ</button>
                </td>
            </tr>
        `;
    });
}

// ----------------------------------------------------
// ระบบจัดการ Popup (แทนที่ alert/confirm เดิม)
// ----------------------------------------------------

// [Popup] ฟังก์ชันสำหรับเปิดกล่อง "ดูข้อมูล"
function viewOrgDetails(id) {
    document.getElementById('viewModalOrgId').innerText = id;
    const viewModal = new bootstrap.Modal(document.getElementById('viewModal'));
    viewModal.show();
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
        method: 'DELETE'
    });
    
    const result = await res.json();
    if(result.success) {
        fetchOrganizations(); // โหลดตารางใหม่
        fetchStats();         // อัปเดตตัวเลข
    } else {
        alert("เกิดข้อผิดพลาดในการลบ: " + result.message);
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
        headers: { 'Content-Type': 'application/json' },
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