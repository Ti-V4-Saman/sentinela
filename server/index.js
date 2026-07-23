import express from 'express';
import cors from 'cors';
import pool from './db.js';

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper to normalize instance object format from DB to Frontend expectation
const formatInstance = (row) => ({
  id: row.id,
  name: row.name,
  token: row.token,
  status: row.status,
  phoneNumber: row.phone_number || '',
  contactName: row.contact_name || '',
  avatarUrl: row.avatar_url || '',
  webhookUrl: row.webhook_url || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

// GET all instances
app.get('/api/instances', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM instances ORDER BY created_at DESC');
    res.json(rows.map(formatInstance));
  } catch (error) {
    console.error('Error fetching instances:', error);
    res.status(500).json({ error: 'Failed to fetch instances' });
  }
});

// POST new instance
app.post('/api/instances', async (req, res) => {
  const { id, name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl } = req.body;
  if (!id || !name || !token) {
    return res.status(400).json({ error: 'id, name, and token are required' });
  }

  try {
    await pool.query(
      `INSERT INTO instances 
      (id, name, token, status, phone_number, contact_name, avatar_url, webhook_url) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, token, status || 'Disconnected', phoneNumber || null, contactName || null, avatarUrl || null, webhookUrl || null]
    );
    const [rows] = await pool.query('SELECT * FROM instances WHERE id = ?', [id]);
    res.status(201).json(formatInstance(rows[0]));
  } catch (error) {
    console.error('Error creating instance:', error);
    res.status(500).json({ error: 'Failed to create instance' });
  }
});

// PUT update instance
app.put('/api/instances/:id', async (req, res) => {
  const { id } = req.params;
  const { name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl } = req.body;
  
  try {
    // Dynamically build the update query based on provided fields
    const updates = [];
    const values = [];
    
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (token !== undefined) { updates.push('token = ?'); values.push(token); }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (phoneNumber !== undefined) { updates.push('phone_number = ?'); values.push(phoneNumber); }
    if (contactName !== undefined) { updates.push('contact_name = ?'); values.push(contactName); }
    if (avatarUrl !== undefined) { updates.push('avatar_url = ?'); values.push(avatarUrl); }
    if (webhookUrl !== undefined) { updates.push('webhook_url = ?'); values.push(webhookUrl); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `UPDATE instances SET ${updates.join(', ')} WHERE id = ?`;
    
    const [result] = await pool.query(query, values);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const [rows] = await pool.query('SELECT * FROM instances WHERE id = ?', [id]);
    res.json(formatInstance(rows[0]));
  } catch (error) {
    console.error('Error updating instance:', error);
    res.status(500).json({ error: 'Failed to update instance' });
  }
});

// DELETE instance
app.delete('/api/instances/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const [result] = await pool.query('DELETE FROM instances WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    res.json({ success: true, message: 'Instance deleted' });
  } catch (error) {
    console.error('Error deleting instance:', error);
    res.status(500).json({ error: 'Failed to delete instance' });
  }
});

app.listen(port, () => {
  console.log(`Sentinela Backend API running on port ${port}`);
});
