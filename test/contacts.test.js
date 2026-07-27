import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createContactTypesRouter } from '../server/routes/contactTypes.js';
import { createContactsRouter } from '../server/routes/contacts.js';
import { createChatsRouter } from '../server/routes/chats.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/contact-types', authenticate, createContactTypesRouter(conn));
  a.use('/api/contacts', authenticate, createContactsRouter(conn));
  a.use('/api/chats', authenticate, createChatsRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

const SUPER = { userId: 900000, tenantId: null, role: 'superadmin' };
const ADMIN1 = { userId: 900050, tenantId: 900001, role: 'admin' };
const ADMIN2 = { userId: 900060, tenantId: 900002, role: 'admin' };
const USER1 = { userId: 900011, tenantId: 900001, role: 'usuario' };

// t1: contatos K1/K2 (mesmo telefone 5531900000001), K3 (outro), K4 (sem telefone).
// t2: Z1. Chats CH1(K1), CH3(K3) em t1; CHZ(Z1) em t2. Instância de captura W1(t1)/W9(t2).
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900000,NULL,'Super','s@__test__','x','superadmin','active'),
    (900050,900001,'Admin1','a1@__test__','x','admin','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900060,900002,'Admin2','a2@__test__','x','admin','active')`);
  await conn.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001),('W9',900002)");
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES
    ('__i1__',900001,900050,'A','t1','W1'),('__i9__',900002,900060,'Z','t9','W9')`);
  await conn.query("INSERT INTO user_instances (user_id,instance_id) VALUES (900011,'__i1__')");
  await conn.query(`INSERT INTO contacts (id,tenant_id,phone,name) VALUES
    ('K1',900001,'5531900000001','Alice'),
    ('K2',900001,'5531900000001','Alice Dup'),
    ('K3',900001,'5531900000002','Bob'),
    ('K4',900001,NULL,'SemFone'),
    ('Z1',900002,'5531900000009','Zara')`);
  await conn.query(`INSERT INTO chats (id,tenant_id,title,is_group) VALUES
    ('CH1',900001,NULL,0),('CH3',900001,NULL,0),('CHZ',900002,NULL,0)`);
  await conn.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('m1',900001,'CH1','K1','oi alice','text',0,0,'2026-07-01 10:00:00','W1'),
    ('m3',900001,'CH3','K3','oi bob','text',0,0,'2026-07-02 10:00:00','W1'),
    ('mz',900002,'CHZ','Z1','oi zara','text',0,0,'2026-07-01 10:00:00','W9')`);
}

// cria um tipo e retorna seu id
async function makeType(app, actor, name, color = 'info', extra = {}) {
  const r = await request(app).post('/api/contact-types').set('Authorization', bearer(actor)).send({ name, color, ...extra });
  return r;
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('contact_types — CRUD + isolamento', () => {
  it('admin cria tipo e lista', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const cr = await makeType(app, ADMIN1, 'Lead', 'info');
      expect(cr.status).toBe(201);
      expect(cr.body).toMatchObject({ name: 'Lead', color: 'info', contactCount: 0 });
      const list = await request(app).get('/api/contact-types').set('Authorization', bearer(ADMIN1));
      expect(list.body.map((t) => t.name)).toEqual(['Lead']);
    });
  });
  it('nome duplicado no mesmo tenant → 409', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await makeType(app, ADMIN1, 'Lead');
      const dup = await makeType(app, ADMIN1, 'Lead');
      expect(dup.status).toBe(409);
    });
  });
  it('color inválido → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await makeType(app, ADMIN1, 'X', 'roxo-neon');
      expect(r.status).toBe(400);
    });
  });
  it('isolamento: admin2 não vê tipo de t1', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await makeType(app, ADMIN1, 'Lead');
      const list = await request(app).get('/api/contact-types').set('Authorization', bearer(ADMIN2));
      expect(list.body).toEqual([]);
    });
  });
  it('mesmo nome pode existir em tenants diferentes', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await makeType(app, ADMIN1, 'Lead')).status).toBe(201);
      expect((await makeType(app, ADMIN2, 'Lead')).status).toBe(201);
    });
  });
  it('update tipo (nome + cor)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const id = (await makeType(app, ADMIN1, 'Lead')).body.id;
      const up = await request(app).put(`/api/contact-types/${id}`).set('Authorization', bearer(ADMIN1)).send({ name: 'Cliente', color: 'success' });
      expect(up.status).toBe(200);
      expect(up.body).toMatchObject({ name: 'Cliente', color: 'success' });
    });
  });
  it('delete tipo desvincula contatos e remove', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const id = (await makeType(app, ADMIN1, 'Lead')).body.id;
      await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ contactTypeId: id });
      const del = await request(app).delete(`/api/contact-types/${id}`).set('Authorization', bearer(ADMIN1));
      expect(del.status).toBe(200);
      // K1 continua identificado, mas sem tipo.
      const [rows] = await c.query("SELECT contact_type_id, identification_source FROM contacts WHERE tenant_id=900001 AND id='K1'");
      expect(rows[0].contact_type_id).toBeNull();
      expect(rows[0].identification_source).toBe('manual');
      const list = await request(app).get('/api/contact-types').set('Authorization', bearer(ADMIN1));
      expect(list.body).toEqual([]);
    });
  });
  it('usuário comum não acessa tipos (403)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/contact-types').set('Authorization', bearer(USER1));
      expect(r.status).toBe(403);
    });
  });
  it('superadmin exige tenantId para criar; com tenantId cria', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const semTid = await request(app).post('/api/contact-types').set('Authorization', bearer(SUPER)).send({ name: 'X' });
      expect(semTid.status).toBe(400);
      const comTid = await request(app).post('/api/contact-types').set('Authorization', bearer(SUPER)).send({ name: 'X', tenantId: 900001 });
      expect(comTid.status).toBe(201);
    });
  });
});

describe('contacts — listagem, contadores, filtros, isolamento', () => {
  it('lista contatos do tenant com contadores', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/contacts').set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(200);
      expect(r.body.counts).toEqual({ total: 4, identified: 0, unidentified: 4 });
      expect(r.body.contacts.map((x) => x.id).sort()).toEqual(['K1', 'K2', 'K3', 'K4']);
    });
  });
  it('filtro status=identified/unidentified', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/contacts/K3/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Bob Cliente' });
      const idf = await request(app).get('/api/contacts?status=identified').set('Authorization', bearer(ADMIN1));
      expect(idf.body.contacts.map((x) => x.id)).toEqual(['K3']);
      const un = await request(app).get('/api/contacts?status=unidentified').set('Authorization', bearer(ADMIN1));
      expect(un.body.contacts.map((x) => x.id).sort()).toEqual(['K1', 'K2', 'K4']);
    });
  });
  it('filtro search (nome/telefone)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const byName = await request(app).get('/api/contacts?search=Bob').set('Authorization', bearer(ADMIN1));
      expect(byName.body.contacts.map((x) => x.id)).toEqual(['K3']);
      const byPhone = await request(app).get('/api/contacts?search=5531900000002').set('Authorization', bearer(ADMIN1));
      expect(byPhone.body.contacts.map((x) => x.id)).toEqual(['K3']);
    });
  });
  it('filtro type_id', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const id = (await makeType(app, ADMIN1, 'Lead')).body.id;
      await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ contactTypeId: id });
      const r = await request(app).get(`/api/contacts?type_id=${id}`).set('Authorization', bearer(ADMIN1));
      // K1 (manual) + K2 (auto, mesmo telefone) herdam o tipo
      expect(r.body.contacts.map((x) => x.id).sort()).toEqual(['K1', 'K2']);
    });
  });
  it('isolamento: admin1 não vê contatos de t2', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/contacts').set('Authorization', bearer(ADMIN1));
      expect(r.body.contacts.some((x) => x.id === 'Z1')).toBe(false);
    });
  });
});

describe('contacts — identificação manual + propagação por telefone', () => {
  it('identify manual seta campos, source=manual e identified_by', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const typeId = (await makeType(app, ADMIN1, 'Lead')).body.id;
      const r = await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1))
        .send({ displayName: 'Alice VIP', contactTypeId: typeId, linkedUserId: 900011 });
      expect(r.status).toBe(200);
      expect(r.body.contact).toMatchObject({
        id: 'K1', displayName: 'Alice VIP', identified: true, identificationSource: 'manual',
        type: { id: typeId, name: 'Lead', color: 'info' },
        linkedUser: { id: 900011, name: 'U1' },
        identifiedBy: { id: 900050, name: 'Admin1' },
      });
    });
  });
  it('propaga a identidade para OUTRO contato do mesmo telefone (source=auto)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1))
        .send({ displayName: 'Alice VIP' });
      expect(r.body.propagated).toBe(1); // K2 (mesmo telefone)
      const [rows] = await c.query("SELECT display_name, identification_source, identified_by_user_id FROM contacts WHERE tenant_id=900001 AND id='K2'");
      expect(rows[0].display_name).toBe('Alice VIP');
      expect(rows[0].identification_source).toBe('auto');
      expect(rows[0].identified_by_user_id).toBeNull();
    });
  });
  it('identify sem nenhum campo → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({});
      expect(r.status).toBe(400);
    });
  });
  it('tipo de outro tenant → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const t2type = (await makeType(app, ADMIN2, 'LeadT2')).body.id;
      const r = await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ contactTypeId: t2type });
      expect(r.status).toBe(400);
    });
  });
  it('linked_user de outro tenant → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ linkedUserId: 900060 }); // admin2 t2
      expect(r.status).toBe(400);
    });
  });
  it('auto NÃO sobrescreve identificação manual', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      // K2 identificado manualmente primeiro
      await request(app).put('/api/contacts/K2/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Alice Dup MANUAL' });
      // Agora identifica K1 (mesmo telefone) → propagação NÃO deve tocar K2 (manual)
      const r = await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Alice VIP' });
      expect(r.body.propagated).toBe(0);
      const [rows] = await c.query("SELECT display_name, identification_source FROM contacts WHERE tenant_id=900001 AND id='K2'");
      expect(rows[0].display_name).toBe('Alice Dup MANUAL');
      expect(rows[0].identification_source).toBe('manual');
    });
  });
  it('clear identification → volta a não identificado', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Alice VIP' });
      const del = await request(app).delete('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1));
      expect(del.status).toBe(200);
      const [rows] = await c.query("SELECT identification_source, display_name FROM contacts WHERE tenant_id=900001 AND id='K1'");
      expect(rows[0].identification_source).toBeNull();
      expect(rows[0].display_name).toBeNull();
    });
  });
  it('contato sem telefone não propaga (K4)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/contacts/K4/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Fulano' });
      expect(r.body.propagated).toBe(0);
    });
  });
});

describe('contacts — autoidentificação em lote', () => {
  it('POST /auto-identify propaga as manuais por telefone', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      // Identifica K1 manualmente sem gatilho de propagação (simula estado prévio)
      await c.query("UPDATE contacts SET display_name='Alice VIP', identification_source='manual', identified_by_user_id=900050, identified_at=NOW() WHERE tenant_id=900001 AND id='K1'");
      const before = await c.query("SELECT identification_source FROM contacts WHERE tenant_id=900001 AND id='K2'");
      expect(before[0][0].identification_source).toBeNull();
      const r = await request(app).post('/api/contacts/auto-identify').set('Authorization', bearer(ADMIN1)).send({});
      expect(r.status).toBe(200);
      expect(r.body.propagated).toBe(1);
      const [rows] = await c.query("SELECT identification_source, display_name FROM contacts WHERE tenant_id=900001 AND id='K2'");
      expect(rows[0].identification_source).toBe('auto');
      expect(rows[0].display_name).toBe('Alice VIP');
    });
  });
});

describe('integração com conversas (chats)', () => {
  it('GET /api/chats traz displayName + type + identified do contato', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const typeId = (await makeType(app, ADMIN1, 'Lead')).body.id;
      await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Alice VIP', contactTypeId: typeId });
      const r = await request(app).get('/api/chats').set('Authorization', bearer(ADMIN1));
      const ch1 = r.body.chats.find((x) => x.id === 'CH1');
      expect(ch1.title).toBe('Alice VIP'); // display_name vira o título
      expect(ch1.contact).toMatchObject({ displayName: 'Alice VIP', identified: true, type: { name: 'Lead', color: 'info' } });
      const ch3 = r.body.chats.find((x) => x.id === 'CH3');
      expect(ch3.contact.identified).toBe(false);
    });
  });
  it('filtro identified=1/0 na listagem', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Alice VIP' });
      const idf = await request(app).get('/api/chats?identified=1').set('Authorization', bearer(ADMIN1));
      expect(idf.body.chats.map((x) => x.id)).toEqual(['CH1']);
      const un = await request(app).get('/api/chats?identified=0').set('Authorization', bearer(ADMIN1));
      expect(un.body.chats.map((x) => x.id)).toEqual(['CH3']);
    });
  });
  it('identified inválido → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?identified=talvez').set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(400);
    });
  });
  it('thread: sender traz displayName + type', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const typeId = (await makeType(app, ADMIN1, 'Lead')).body.id;
      await request(app).put('/api/contacts/K1/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Alice VIP', contactTypeId: typeId });
      const r = await request(app).get('/api/chats/CH1/messages').set('Authorization', bearer(ADMIN1));
      expect(r.body.messages[0].sender).toMatchObject({ displayName: 'Alice VIP', type: { name: 'Lead' } });
    });
  });
});
