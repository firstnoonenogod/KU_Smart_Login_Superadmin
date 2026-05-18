# ใช้ Node.js เวอร์ชัน 20 แบบเบาๆ
FROM node:20-alpine

# ตั้งค่าโฟลเดอร์ทำงานในกล่อง
WORKDIR /app

# ก๊อปปี้ไฟล์รายการไลบรารีมาติดตั้งก่อน
COPY package*.json ./
RUN npm install

# ก๊อปปี้โค้ดทั้งหมดตามเข้าไป
COPY . .

# เปิดประตู 3000
EXPOSE 3000

# คำสั่งรันแอปตอนเปิดกล่อง
CMD ["npm", "start"]