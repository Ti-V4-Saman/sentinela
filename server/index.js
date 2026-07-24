import express from 'express';
import cors from 'cors';
import pool from './db.js';

const app = express();
const port = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET_KEY || '';

app.use(cors());
app.use(express.json());

// Auth middleware - require X-Sentinela-Key header
app.use('/api', (req, res, next) => {
  const key = req.headers['x-sentinela-key'];
  if (!API_SECRET || key !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Helper to normalize instance object format from DB to Frontend expectation
const formatInstance = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
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

// Helper to generate a new unique record in tenants table and return its ID
const createUniqueTenant = async (instanceName, instanceId) => {
  const uniqueTenantName = `Tenant - ${instanceName || 'Instancia'} (${instanceId}) - ${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const [result] = await pool.query('INSERT INTO tenants (name) VALUES (?)', [uniqueTenantName]);
  return result.insertId;
};

// GET all instances
app.get('/api/instances', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM sentinela_instances ORDER BY created_at DESC');
    res.json(rows.map(formatInstance));
  } catch (error) {
    console.error('Error fetching instances:', error);
    res.status(500).json({ error: 'Failed to fetch instances' });
  }
});

// POST new instance
app.post('/api/instances', async (req, res) => {
  const { id, name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl, tenantId } = req.body;
  if (!id || !name || !token) {
    return res.status(400).json({ error: 'id, name, and token are required' });
  }

  try {
    let finalTenantId = tenantId;
    if (!finalTenantId) {
      finalTenantId = await createUniqueTenant(name, id);
    }

    await pool.query(
      `INSERT INTO sentinela_instances 
      (id, tenant_id, name, token, status, phone_number, contact_name, avatar_url, webhook_url) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, finalTenantId, name, token, status || 'Disconnected', phoneNumber || null, contactName || null, avatarUrl || null, webhookUrl || null]
    );
    const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
    res.status(201).json(formatInstance(rows[0]));
  } catch (error) {
    console.error('Error creating instance:', error);
    res.status(500).json({ error: 'Failed to create instance' });
  }
});

// PUT update instance
app.put('/api/instances/:id', async (req, res) => {
  const { id } = req.params;
  const { name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl, tenantId } = req.body;
  
  try {
    const [existingRows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const currentInstance = existingRows[0];
    let finalTenantId = tenantId || currentInstance.tenant_id;

    if (!finalTenantId) {
      finalTenantId = await createUniqueTenant(name || currentInstance.name, id);
    }

    // Dynamically build the update query based on provided fields
    const updates = ['tenant_id = ?'];
    const values = [finalTenantId];
    
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (token !== undefined) { updates.push('token = ?'); values.push(token); }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (phoneNumber !== undefined) { updates.push('phone_number = ?'); values.push(phoneNumber); }
    if (contactName !== undefined) { updates.push('contact_name = ?'); values.push(contactName); }
    if (avatarUrl !== undefined) { updates.push('avatar_url = ?'); values.push(avatarUrl); }
    if (webhookUrl !== undefined) { updates.push('webhook_url = ?'); values.push(webhookUrl); }

    values.push(id);
    const query = `UPDATE sentinela_instances SET ${updates.join(', ')} WHERE id = ?`;
    
    await pool.query(query, values);

    const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
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
    const [result] = await pool.query('DELETE FROM sentinela_instances WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Instance not found' });
    }
    res.json({ success: true, message: 'Instance deleted' });
  } catch (error) {
    console.error('Error deleting instance:', error);
    res.status(500).json({ error: 'Failed to delete instance' });
  }
});

// Auto-create table on startup & backfill tenant_id if NULL
const ensureTableExists = async () => {
  try {
    const createTenantsTable = `
      CREATE TABLE IF NOT EXISTS tenants (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL UNIQUE,
        status ENUM('active', 'suspended') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;
    await pool.query(createTenantsTable);

    const createInstancesTable = `
      CREATE TABLE IF NOT EXISTS sentinela_instances (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id BIGINT UNSIGNED NULL,
        name VARCHAR(100) NOT NULL,
        token VARCHAR(128) NOT NULL,
        status VARCHAR(50) DEFAULT 'Disconnected',
        phone_number VARCHAR(50),
        contact_name VARCHAR(100),
        avatar_url TEXT,
        webhook_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_tenant_id (tenant_id),
        CONSTRAINT fk_si_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;
    await pool.query(createInstancesTable);

    // Backfill any existing instances where tenant_id IS NULL
    const [nullInstances] = await pool.query('SELECT id, name FROM sentinela_instances WHERE tenant_id IS NULL');
    for (const inst of nullInstances) {
      const newTenantId = await createUniqueTenant(inst.name, inst.id);
      await pool.query('UPDATE sentinela_instances SET tenant_id = ? WHERE id = ?', [newTenantId, inst.id]);
      console.log(`[Sentinela DB] Gerado novo tenant_id #${newTenantId} para instância "${inst.name}" (${inst.id})`);
    }

    console.log('Database schema verified (sentinela_instances and tenants tables are ready)');
  } catch (err) {
    console.error('Failed to verify schema on startup:', err);
  }
};

app.listen(port, async () => {
  await ensureTableExists();
  console.log(`Sentinela Backend API running on port ${port}`);
});
