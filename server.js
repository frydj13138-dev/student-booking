const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const moment = require('moment-jalaali');
const ExcelJS = require('exceljs');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./appointments.db');

db.serialize(() => {
    db.run(`PRAGMA journal_mode = WAL;`);
    
    // جدول نوبت‌ها
    db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullname TEXT NOT NULL,
        student_id TEXT NOT NULL,
        date_shamsi TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`);

    // جدول کاربران ادمین
    db.run(`CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    )`);

    // ایجاد اکانت سوپر ادمین پیش‌فرض
    db.run(`INSERT OR IGNORE INTO admin_users (username, password, role) VALUES ('superadmin', '09965234543', 'super')`);
});

// میدل‌ور بررسی دسترسی ادمین‌ها
function authenticateAdmin(req, res, next) {
    let authHeader = req.headers.authorization;
    if (!authHeader && req.query.auth) {
        authHeader = req.query.auth;
    }

    if (!authHeader || !authHeader.startsWith('Basic ')) {
        return res.status(401).json({ error: 'دسترسی غیرمجاز!' });
    }

    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii').split(':');
    const username = credentials[0];
    const password = credentials[1];

    db.get(`SELECT * FROM admin_users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
        if (err || !user) return res.status(403).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
        req.adminUser = user;
        next();
    });
}

function getAvailableSlotForDate(selectedDateShamsi, callback) {
    const slots = [];
    let start = moment('08:00', 'HH:mm');
    const end = moment('14:00', 'HH:mm');

    while (start.isBefore(end)) {
        slots.push(start.format('HH:mm'));
        start.add(10, 'minutes');
    }

    db.all(`SELECT time_slot, COUNT(*) as count FROM appointments WHERE date_shamsi = ? GROUP BY time_slot`, [selectedDateShamsi], (err, rows) => {
        if (err) return callback(err, null);
        const counts = {};
        if (rows) rows.forEach(r => counts[r.time_slot] = r.count);

        for (let slot of slots) {
            if ((counts[slot] || 0) < 5) return callback(null, { date: selectedDateShamsi, time: slot });
        }
        callback(new Error('ظرفیت نوبت‌دهی برای این تاریخ تکمیل شده است.'), null);
    });
}

app.post('/api/book', (req, res) => {
    const { fullname, student_id, target_date } = req.body;

    if (!fullname || !student_id || !target_date) {
        return res.status(400).json({ error: 'لطفاً تمامی اطلاعات را وارد کنید.' });
    }

    const cleanName = fullname.trim();
    const cleanStudentId = student_id.trim();
    const selectedDateShamsi = target_date.trim();

    db.get(`SELECT * FROM appointments WHERE student_id = ? AND date_shamsi = ?`, [cleanStudentId, selectedDateShamsi], (err, row) => {
        if (err) return res.status(500).json({ error: 'خطا در دیتابیس.' });
        if (row) {
            return res.status(400).json({ error: `شما قبلاً برای تاریخ ${selectedDateShamsi} نوبت ثبت کرده‌اید.` });
        }

        getAvailableSlotForDate(selectedDateShamsi, (err, slot) => {
            if (err) return res.status(400).json({ error: err.message });
            const createdAt = moment().format('jYYYY/jMM/jDD HH:mm:ss');
            
            db.run(`INSERT INTO appointments (fullname, student_id, date_shamsi, time_slot, created_at) VALUES (?, ?, ?, ?, ?)`,
                [cleanName, cleanStudentId, slot.date, slot.time, createdAt],
                function(err) {
                    if (err) return res.status(500).json({ error: 'خطا در ثبت نوبت.' });
                    res.json({ 
                        success: true, 
                        appointment: { id: this.lastID, fullname: cleanName, student_id: cleanStudentId, date_shamsi: slot.date, time_slot: slot.time } 
                    });
                }
            );
        });
    });
});

// ورود ادمین
app.get('/api/admin/login', authenticateAdmin, (req, res) => {
    res.json({ success: true, role: req.adminUser.role });
});

// تعریف ادمین جدید (مخصوص سوپر ادمین)
app.post('/api/admin/create-user', authenticateAdmin, (req, res) => {
    if (req.adminUser.role !== 'super') {
        return res.status(403).json({ error: 'فقط سوپر ادمین مجاز به ایجاد ادمین جدید است.' });
    }
    const { username, password, role } = req.body;
    db.run(`INSERT INTO admin_users (username, password, role) VALUES (?, ?, ?)`, [username, password, role || 'admin'], (err) => {
        if (err) return res.status(400).json({ error: 'این نام کاربری قبلاً وجود دارد.' });
        res.json({ success: true, message: 'ادمین جدید ایجاد شد.' });
    });
});

// مشاهده لیست نوبت‌ها
app.get('/api/admin/list', authenticateAdmin, (req, res) => {
    db.all(`SELECT * FROM appointments ORDER BY date_shamsi DESC, time_slot ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'خطا در دریافت لیست.' });
        res.json(rows);
    });
});

// حذف نوبت (مخصوص سوپر ادمین)
app.delete('/api/admin/delete/:id', authenticateAdmin, (req, res) => {
    if (req.adminUser.role !== 'super') {
        return res.status(403).json({ error: 'شما دسترسی لازم برای حذف نوبت را ندارید.' });
    }
    db.run(`DELETE FROM appointments WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: 'خطا در حذف نوبت.' });
        res.json({ success: true });
    });
});

// دانلود خروجی اکسل (مشترک برای همه ادمین‌ها)
app.get('/api/admin/export-excel', authenticateAdmin, (req, res) => {
    db.all(`SELECT * FROM appointments ORDER BY date_shamsi ASC, time_slot ASC`, [], async (err, rows) => {
        if (err) return res.status(500).send('خطا در دیتابیس');
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('نوبت ها');
        worksheet.columns = [
            { header: 'کد پیگیری', key: 'id', width: 10 },
            { header: 'نام و نام خانوادگی', key: 'fullname', width: 25 },
            { header: 'شماره دانشجویی', key: 'student_id', width: 18 },
            { header: 'تاریخ نوبت', key: 'date_shamsi', width: 18 },
            { header: 'ساعت نوبت', key: 'time_slot', width: 12 },
            { header: 'زمان ثبت', key: 'created_at', width: 22 }
        ];
        rows.forEach(row => worksheet.addRow(row));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Appointments.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
