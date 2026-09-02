const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const moment = require('moment-jalaali');
const ExcelJS = require('exceljs');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));

const bookingLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    message: { error: 'تعداد تلاش‌های شما بیش از حد مجاز است. لطفاً یک دقیقه صبر کنید.' }
});

const db = new sqlite3.Database('./appointments.db');

db.serialize(() => {
    db.run(`PRAGMA journal_mode = WAL;`);
    db.run(`CREATE TABLE IF NOT EXISTS appointments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullname TEXT NOT NULL,
        student_id TEXT UNIQUE NOT NULL,
        date_shamsi TEXT NOT NULL,
        time_slot TEXT NOT NULL,
        created_at TEXT NOT NULL
    )`);
});

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

app.post('/api/book', bookingLimiter, (req, res) => {
    const { fullname, student_id, target_date } = req.body;

    if (!fullname || !student_id || !target_date) {
        return res.status(400).json({ error: 'لطفاً تمامی اطلاعات را وارد کنید.' });
    }

    const cleanName = fullname.trim();
    const cleanStudentId = student_id.trim();

    if (cleanName.length < 3 || cleanName.length > 50) {
        return res.status(400).json({ error: 'نام و نام خانوادگی وارد شده معتبر نیست.' });
    }

    // بررسی طول شماره دانشجویی (باید عدد و بین ۱ تا ۱۴ رقم باشد)
    const studentIdRegex = /^\d{1,14}$/;
    if (!studentIdRegex.test(cleanStudentId)) {
        return res.status(400).json({ error: 'شماره دانشجویی باید فقط شامل عدد و حداکثر ۱۴ رقم باشد.' });
    }

    // تعیین تاریخ بر اساس انتخاب کاربر
    let selectedDateShamsi = moment().format('jYYYY/jMM/jDD');
    if (target_date === 'tomorrow') {
        selectedDateShamsi = moment().add(1, 'day').format('jYYYY/jMM/jDD');
    }

    db.get(`SELECT * FROM appointments WHERE student_id = ?`, [cleanStudentId], (err, row) => {
        if (err) return res.status(500).json({ error: 'خطای سرور در بررسی نوبت.' });
        if (row) return res.status(400).json({ error: 'شما قبلاً یک نوبت فعال ثبت کرده‌اید.', appointment: row });

        getAvailableSlotForDate(selectedDateShamsi, (err, slot) => {
            if (err) return res.status(400).json({ error: err.message });
            const createdAt = moment().format('jYYYY/jMM/jDD HH:mm:ss');
            const stmt = db.prepare(`INSERT INTO appointments (fullname, student_id, date_shamsi, time_slot, created_at) VALUES (?, ?, ?, ?, ?)`);
            
            stmt.run(cleanName, cleanStudentId, slot.date, slot.time, function(err) {
                if (err) return res.status(500).json({ error: 'خطا در ثبت نوبت.' });
                res.json({ 
                    success: true, 
                    appointment: { 
                        id: this.lastID, 
                        fullname: cleanName, 
                        student_id: cleanStudentId, 
                        date_shamsi: slot.date, 
                        time_slot: slot.time 
                    } 
                });
            });
            stmt.finalize();
        });
    });
});

app.get('/api/admin/export-excel', (req, res) => {
    const adminKey = process.env.ADMIN_KEY || 'SecretAdminKey1403';
    if (req.query.key !== adminKey) return res.status(403).send('دسترسی غیرمجاز!');

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
app.listen(PORT, () => console.log(`Server running securely on port ${PORT}`));
