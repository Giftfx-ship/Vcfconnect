require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Database
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Database Connected'))
.catch(err => console.error('❌ Database Error:', err));

// ============ MODELS ============
const BatchSchema = new mongoose.Schema({
  batchNumber: { type: Number, required: true, unique: true },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  isDownloadable: { type: Boolean, default: false },
  totalContacts: { type: Number, default: 0 },
  groupLink: { type: String, default: process.env.GROUP_LINK },
}, { timestamps: true });

const ContactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', required: true },
  hasJoinedGroup: { type: Boolean, default: false },
  ipAddress: { type: String },
}, { timestamps: true });

const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
}, { timestamps: true });

const Batch = mongoose.model('Batch', BatchSchema);
const Contact = mongoose.model('Contact', ContactSchema);
const Admin = mongoose.model('Admin', AdminSchema);

// ============ AUTH ============
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) throw new Error();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const admin = await Admin.findById(decoded.id);
    if (!admin) throw new Error();
    req.admin = admin;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Please authenticate' });
  }
};

// ============ INITIALIZE ============
(async () => {
  const existingAdmin = await Admin.findOne({ username: process.env.ADMIN_USERNAME });
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await Admin.create({
      username: process.env.ADMIN_USERNAME,
      password: hashedPassword
    });
    console.log('✅ Admin created');
  }

  const existingBatch = await Batch.findOne({ isActive: true });
  if (!existingBatch) {
    const now = new Date();
    const endTime = new Date(now);
    endTime.setDate(endTime.getDate() + 2);
    await Batch.create({
      batchNumber: 1,
      startTime: now,
      endTime: endTime,
      isActive: true,
      isDownloadable: false,
    });
    console.log('✅ Initial batch created');
  }
})();

// ============ API ROUTES ============

// Get batch status
app.get('/api/batch/status', async (req, res) => {
  try {
    const batch = await Batch.findOne({ isActive: true });
    if (!batch) return res.status(404).json({ error: 'No active batch' });
    
    const now = new Date();
    const remaining = batch.endTime - now;
    
    res.json({
      batchNumber: batch.batchNumber,
      startTime: batch.startTime,
      endTime: batch.endTime,
      remaining: Math.max(0, remaining),
      isDownloadable: now >= batch.endTime,
      totalContacts: batch.totalContacts,
      groupLink: batch.groupLink,
      isActive: batch.isActive
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit contact
app.post('/api/submit', async (req, res) => {
  try {
    const { name, phone } = req.body;
    
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone required' });
    }
    
    const batch = await Batch.findOne({ isActive: true });
    if (!batch) return res.status(400).json({ error: 'No active batch' });
    
    const existing = await Contact.findOne({ 
      phone: phone,
      batchId: batch._id 
    });
    if (existing) {
      return res.status(400).json({ error: 'Phone number already submitted' });
    }
    
    const contact = await Contact.create({
      name,
      phone,
      batchId: batch._id,
      ipAddress: req.ip
    });
    
    batch.totalContacts += 1;
    await batch.save();
    
    res.json({
      success: true,
      message: 'Contact submitted successfully',
      contactId: contact._id,
      groupLink: batch.groupLink
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Track group join
app.post('/api/group/joined', async (req, res) => {
  try {
    const { contactId } = req.body;
    await Contact.findByIdAndUpdate(contactId, { hasJoinedGroup: true });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
    
    const isValid = await bcrypt.compare(password, admin.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: admin.username });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all contacts (admin only)
app.get('/api/admin/contacts', authenticate, async (req, res) => {
  try {
    const batch = await Batch.findOne({ isActive: true });
    if (!batch) return res.status(404).json({ error: 'No active batch' });
    
    const contacts = await Contact.find({ batchId: batch._id })
      .sort({ createdAt: -1 });
    
    res.json({
      contacts,
      total: contacts.length,
      batch: batch
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download VCF (admin only)
app.get('/api/admin/download/vcf', authenticate, async (req, res) => {
  try {
    const batch = await Batch.findOne({ isActive: true });
    if (!batch) return res.status(404).json({ error: 'No active batch' });
    
    const now = new Date();
    if (now < batch.endTime) {
      return res.status(400).json({ error: 'Batch not yet downloadable' });
    }
    
    const contacts = await Contact.find({ batchId: batch._id });
    
    let vcfContent = '';
    contacts.forEach(contact => {
      vcfContent += `BEGIN:VCARD\n`;
      vcfContent += `VERSION:3.0\n`;
      vcfContent += `FN:${contact.name}\n`;
      vcfContent += `TEL:+${contact.phone}\n`;
      vcfContent += `END:VCARD\n\n`;
    });
    
    res.setHeader('Content-Type', 'text/vcard');
    res.setHeader('Content-Disposition', `attachment; filename=batch_${batch.batchNumber}_contacts.vcf`);
    res.send(vcfContent);
    
    batch.isDownloadable = true;
    await batch.save();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start new batch (admin only)
app.post('/api/admin/new-batch', authenticate, async (req, res) => {
  try {
    await Batch.updateMany({ isActive: true }, { isActive: false });
    
    const lastBatch = await Batch.findOne().sort({ batchNumber: -1 });
    const newBatchNumber = lastBatch ? lastBatch.batchNumber + 1 : 1;
    
    const now = new Date();
    const endTime = new Date(now);
    endTime.setDate(endTime.getDate() + 2);
    
    const batch = await Batch.create({
      batchNumber: newBatchNumber,
      startTime: now,
      endTime: endTime,
      isActive: true,
      isDownloadable: false,
    });
    
    res.json({
      success: true,
      batch: batch
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ SERVE FRONTEND ============
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`👤 User: http://localhost:${PORT}`);
  console.log(`🔐 Admin: http://localhost:${PORT}/admin`);
});
