const path = require('path');
const dns = require('dns');
const os = require('os');
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || '0.0.0.0';
const mongoUri = process.env.MONGODB_URI;
const dnsServers = String(process.env.DNS_SERVERS || '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);

if (dnsServers.length > 0) {
    dns.setServers(dnsServers);
}

if (!mongoUri) {
    console.error('Missing MONGODB_URI in environment variables.');
    process.exit(1);
}

const rollPattern = /^\d{2}[A-Z]{2}\d[A-Z]\d{4}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const allowedStatuses = new Set(['present', 'absent', 'holiday']);

const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        rollNumber: { type: String, required: true, unique: true, trim: true, uppercase: true },
        branch: { type: String, required: true, trim: true },
        registrationDate: { type: Date, default: Date.now }
    },
    { versionKey: false }
);

const attendanceSchema = new mongoose.Schema(
    {
        rollNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
        date: { type: String, required: true, trim: true },
        subject: { type: String, required: true, trim: true },
        hours: { type: Number, required: true, min: 1 },
        status: { type: String, required: true, enum: ['present', 'absent', 'holiday'] },
        timestamp: { type: Date, default: Date.now }
    },
    { versionKey: false }
);

attendanceSchema.index({ rollNumber: 1, date: 1, subject: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
const AttendanceRecord = mongoose.model('AttendanceRecord', attendanceSchema);

function normalizeRollNumber(value) {
    return String(value || '').trim().toUpperCase();
}

function toPublicUser(user) {
    return {
        name: user.name,
        rollNumber: user.rollNumber,
        branch: user.branch,
        registrationDate: user.registrationDate
    };
}

function toPublicRecord(record) {
    return {
        id: record._id.toString(),
        date: record.date,
        subject: record.subject,
        hours: record.hours,
        status: record.status,
        timestamp: record.timestamp
    };
}

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static(path.resolve(__dirname)));

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res, next) => {
    try {
        const name = String(req.body?.name || '').trim();
        const rollNumber = normalizeRollNumber(req.body?.rollNumber);
        const branch = String(req.body?.branch || '').trim();

        if (!name || !rollNumber || !branch) {
            return res.status(400).json({ message: 'Name, roll number, and branch are required.' });
        }

        if (!rollPattern.test(rollNumber)) {
            return res.status(400).json({ message: 'Invalid roll number format.' });
        }

        const existingUser = await User.findOne({ rollNumber }).lean();
        if (existingUser) {
            return res.status(409).json({ message: 'User already registered.' });
        }

        const createdUser = await User.create({
            name,
            rollNumber,
            branch
        });

        return res.status(201).json({
            message: 'Registration successful.',
            user: toPublicUser(createdUser)
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/auth/login', async (req, res, next) => {
    try {
        const rollNumber = normalizeRollNumber(req.body?.rollNumber);

        if (!rollNumber) {
            return res.status(400).json({ message: 'Roll number is required.' });
        }

        if (!rollPattern.test(rollNumber)) {
            return res.status(400).json({ message: 'Invalid roll number format.' });
        }

        const user = await User.findOne({ rollNumber });
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        return res.json({
            message: 'Login successful.',
            user: toPublicUser(user)
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/profile/:rollNumber', async (req, res, next) => {
    try {
        const rollNumber = normalizeRollNumber(req.params.rollNumber);

        if (!rollPattern.test(rollNumber)) {
            return res.status(400).json({ message: 'Invalid roll number format.' });
        }

        const user = await User.findOne({ rollNumber });
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        return res.json({ user: toPublicUser(user) });
    } catch (error) {
        next(error);
    }
});

app.get('/api/attendance/:rollNumber', async (req, res, next) => {
    try {
        const rollNumber = normalizeRollNumber(req.params.rollNumber);

        if (!rollPattern.test(rollNumber)) {
            return res.status(400).json({ message: 'Invalid roll number format.' });
        }

        const records = await AttendanceRecord.find({ rollNumber })
            .sort({ date: -1, timestamp: -1 });

        return res.json({
            records: records.map(toPublicRecord)
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/attendance/:rollNumber', async (req, res, next) => {
    try {
        const rollNumber = normalizeRollNumber(req.params.rollNumber);
        const date = String(req.body?.date || '').trim();
        const subject = String(req.body?.subject || '').trim();
        const hours = Number(req.body?.hours);
        const status = String(req.body?.status || '').trim().toLowerCase();
        const upsert = Boolean(req.body?.upsert);

        if (!rollPattern.test(rollNumber)) {
            return res.status(400).json({ message: 'Invalid roll number format.' });
        }

        if (!datePattern.test(date) || !subject || !Number.isFinite(hours) || hours <= 0 || !allowedStatuses.has(status)) {
            return res.status(400).json({ message: 'Invalid attendance payload.' });
        }

        const user = await User.findOne({ rollNumber }).lean();
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const existingRecord = await AttendanceRecord.findOne({ rollNumber, date, subject });
        if (existingRecord && !upsert) {
            return res.status(409).json({
                code: 'DUPLICATE_ENTRY',
                message: 'Attendance already exists for this subject and date.'
            });
        }

        let record;
        if (existingRecord) {
            existingRecord.hours = hours;
            existingRecord.status = status;
            existingRecord.timestamp = new Date();
            record = await existingRecord.save();
        } else {
            record = await AttendanceRecord.create({
                rollNumber,
                date,
                subject,
                hours,
                status
            });
        }

        return res.json({
            message: 'Attendance saved successfully.',
            record: toPublicRecord(record)
        });
    } catch (error) {
        if (error && error.code === 11000) {
            return res.status(409).json({
                code: 'DUPLICATE_ENTRY',
                message: 'Attendance already exists for this subject and date.'
            });
        }
        next(error);
    }
});

app.delete('/api/attendance/:rollNumber/:recordId', async (req, res, next) => {
    try {
        const rollNumber = normalizeRollNumber(req.params.rollNumber);
        const recordId = String(req.params.recordId || '').trim();

        if (!rollPattern.test(rollNumber)) {
            return res.status(400).json({ message: 'Invalid roll number format.' });
        }

        if (!mongoose.Types.ObjectId.isValid(recordId)) {
            return res.status(400).json({ message: 'Invalid record id.' });
        }

        const result = await AttendanceRecord.deleteOne({
            _id: recordId,
            rollNumber
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Record not found.' });
        }

        return res.json({ message: 'Record deleted successfully.' });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/attendance/:rollNumber', async (req, res, next) => {
    try {
        const rollNumber = normalizeRollNumber(req.params.rollNumber);

        if (!rollPattern.test(rollNumber)) {
            return res.status(400).json({ message: 'Invalid roll number format.' });
        }

        const result = await AttendanceRecord.deleteMany({ rollNumber });
        return res.json({
            message: 'All attendance records deleted successfully.',
            deletedCount: result.deletedCount
        });
    } catch (error) {
        next(error);
    }
});

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'Attendance -Online-Master.html'));
});

app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ message: 'Internal server error.' });
});

async function startServer() {
    await mongoose.connect(mongoUri);
    app.listen(port, host, () => {
        const networkInterfaces = os.networkInterfaces();
        const lanUrls = [];

        Object.values(networkInterfaces).forEach((networkGroup) => {
            (networkGroup || []).forEach((network) => {
                if (network && network.family === 'IPv4' && !network.internal) {
                    lanUrls.push(`http://${network.address}:${port}`);
                }
            });
        });

        console.log(`Attendance API running on http://localhost:${port}`);
        lanUrls.forEach((url) => console.log(`LAN URL: ${url}`));
    });
}

startServer().catch((error) => {
    if (error && error.code === 'ECONNREFUSED' && String(error.hostname || '').startsWith('_mongodb._tcp.')) {
        console.error(
            'DNS SRV lookup failed for MongoDB Atlas. Set DNS_SERVERS in .env, e.g. DNS_SERVERS=8.8.8.8,1.1.1.1'
        );
    }
    console.error('Failed to start server:', error);
    process.exit(1);
});
