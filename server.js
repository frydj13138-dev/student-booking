while (start.isBefore(end)) {
    slots.push(start.format('HH:mm'));
    start.add(10, 'minutes');
}

db.all(`SELECT time_slot, COUNT(*) as count FROM appointments WHERE date_shamsi = ? GROUP BY time_slot`, [todayShamsi], (err, rows) => {
    if (err) return callback(err, null);
    const counts = {};
    if (rows) rows.forEach(r => counts[r.time_slot] = r.count);

    for (let slot of slots) {
        if ((counts[slot] || 0) < 5) return callback(null, { date: todayShamsi, time: slot });
    }
    
    const tomorrowShamsi = moment().add(1, 'day').format('jYYYY/jMM/jDD');
    db.all(`SELECT time_slot, COUNT(*) as count FROM appointments WHERE date_shamsi = ? GROUP BY time_slot`, [tomorrowShamsi], (err, rowsTomorrow) => {
        if (err) return callback(err, null);
        const countsTomorrow = {};
        if (rowsTomorrow) rowsTomorrow.forEach(r => countsTomorrow[r.time_slot] = r.count);

        for (let slot of slots) {
            if ((countsTomorrow[slot] || 0) < 5) return callback(null, { date: tomorrowShamsi, time: slot });
        }
        callback(new Error('ظرفیت نوبت‌دهی تکمیل شده است.'), null);
    });
});
db.get(`SELECT * FROM appointments WHERE student_id = ?`, [student_id], (err, row) => {
    if (err) return res.status(500).json({ error: 'خطای سرور' });
    if (row) return res.status(400).json({ error: 'شما قبلاً یک نوبت فعال ثبت کرده‌اید.', appointment: row });

    getNextAvailableSlot((err, slot) => {
        if (err) return res.status(400).json({ error: err.message });
        const createdAt = moment().format('jYYYY/jMM/jDD HH:mm:ss');
        const stmt = db.prepare(`INSERT INTO appointments (fullname, student_id, date_shamsi, time_slot, created_at) VALUES (?, ?, ?, ?, ?)`);
        
        stmt.run(fullname, student_id, slot.date, slot.time, function(err) {
            if (err) return res.status(500).json({ error: 'خطا در ثبت نوبت.' });
            res.json({ success: true, appointment: { id: this.lastID, fullname, student_id, date_shamsi: slot.date, time_slot: slot.time } });
        });
        stmt.finalize();
    });
});
