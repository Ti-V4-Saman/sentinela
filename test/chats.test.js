import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createChatsRouter } from '../server/routes/chats.js';
import { createInstancesRouter } from '../server/routes/instances.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/chats', authenticate, createChatsRouter(conn));
  a.use('/api/instances', authenticate, createInstancesRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

const SUPER = { userId: 900000, tenantId: null, role: 'superadmin' };
const ADMIN = { userId: 900050, tenantId: 900001, role: 'admin' };
const GESTOR = { userId: 900040, tenantId: 900001, role: 'gestor' };
const USER1 = { userId: 900011, tenantId: 900001, role: 'usuario' }; // vê W1/CH1
const USER2 = { userId: 900012, tenantId: 900001, role: 'usuario' }; // i0 (capture_wid NULL) → nada
const USERT2 = { userId: 900013, tenantId: 900002, role: 'usuario' }; // t2, sem user_instances → nada

// Modelo:
// instances (captura): W1,W2,W3(t2),W4 (+ tenant)
// sentinela_instances: i1→W1, i2→W2, i3→W3(t2), i4→W4, i0→NULL (todas t1 exceto i3)
// teams t1: 900100 (team_instances i1), 900101 (team_instances i2), geridas por gestor 900040
// user_instances: 900011→i1 ; 900012→i0(NULL)
// team_users: membro 900014 (dono de i4/W4) na equipe 900100 — para provar que gestor NÃO herda pessoais
// chats: CH1(t1,W1,ind), CH2(t1,W2,grupo), CH3(t2,W3), CH4(t1,W4), CHV(t1,W1, vazio)
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900000,NULL,'Super','s@__test__','x','superadmin','active'),
    (900050,900001,'Admin','a@__test__','x','admin','active'),
    (900040,900001,'Gestor','g@__test__','x','gestor','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900012,900001,'U2','u2@__test__','x','usuario','active'),
    (900014,900001,'U4','u4@__test__','x','usuario','active'),
    (900013,900002,'U3','u3@__test__','x','usuario','active')`);
  await conn.query(`INSERT INTO instances (wid,tenant_id) VALUES
    ('W1',900001),('W2',900001),('W3',900002),('W4',900001)`);
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES
    ('__i1__',900001,900011,'A','t1','W1'),
    ('__i2__',900001,900012,'B','t2','W2'),
    ('__i3__',900002,900013,'C','t3','W3'),
    ('__i4__',900001,900014,'D','t4','W4'),
    ('__i0__',900001,900012,'Z','t0',NULL)`);
  await conn.query("INSERT INTO teams (id,tenant_id,name) VALUES (900100,900001,'Eq1'),(900101,900001,'Eq2')");
  await conn.query("INSERT INTO team_managers (team_id,user_id) VALUES (900100,900040),(900101,900040)");
  await conn.query("INSERT INTO team_instances (team_id,instance_id) VALUES (900100,'__i1__'),(900101,'__i2__')");
  await conn.query("INSERT INTO team_users (team_id,user_id) VALUES (900100,900014)"); // membro dono de i4/W4
  await conn.query("INSERT INTO user_instances (user_id,instance_id) VALUES (900011,'__i1__'),(900012,'__i0__')");
  await conn.query(`INSERT INTO contacts (id,tenant_id,phone,name) VALUES
    ('C1',900001,'5531900000001','Alice'),
    ('C2',900001,'5531900000002','Bob'),
    ('C3',900002,'5531900000003','Carol'),
    ('C4',900001,'5531900000004','Dan')`);
  await conn.query(`INSERT INTO chats (id,tenant_id,title,is_group) VALUES
    ('CH1',900001,'Alice',0),
    ('CH2',900001,'Grupo X',1),
    ('CH3',900002,'Carol',0),
    ('CH4',900001,'Dan',0),
    ('CHV',900001,'Vazio',0)`);
  await conn.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('m1',900001,'CH1','C1','ola mundo','text',0,0,'2026-07-01 10:00:00','W1'),
    ('m2',900001,'CH1','C1','tudo certo por aqui','text',1,0,'2026-07-01 10:01:00','W1'),
    ('m3',900001,'CH1','C1','transcricao do audio recebido','audio',0,0,'2026-07-01 10:02:00','W1'),
    ('m4',900001,'CH2','C2','mensagem no grupo','text',0,0,'2026-07-02 09:00:00','W2'),
    ('m5',900002,'CH3','C3','conversa de outro tenant','text',0,0,'2026-07-01 11:00:00','W3'),
    ('m6',900001,'CH4','C4','mensagem da instancia do membro','text',0,0,'2026-07-03 08:00:00','W4')`);
}

const chatIds = (body) => body.chats.map((c) => c.id).sort();

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('GET /api/chats — RBAC / isolamento', () => {
  it('1. superadmin vê todas as conversas (todos os tenants)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(SUPER));
      expect(r.status).toBe(200);
      expect(chatIds(r.body)).toEqual(['CH1', 'CH2', 'CH3', 'CH4']); // CHV não tem mensagens
    });
  });
  it('2. admin limitado ao próprio tenant', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH1', 'CH2', 'CH4']); // sem CH3 (t2)
    });
  });
  it('3. gestor limitado às equipes (team_instances), não ao tenant', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(GESTOR));
      expect(chatIds(r.body)).toEqual(['CH1', 'CH2']); // W1+W2; sem CH4(W4) nem CH3(t2)
    });
  });
  it('4. usuário limitado às próprias instâncias (user_instances)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(USER1));
      expect(chatIds(r.body)).toEqual(['CH1']);
    });
  });
  it('6. usuário não vê instância só porque é do mesmo tenant', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(USER2)); // i0 NULL
      expect(r.body).toEqual({ page: 1, limit: 20, total: 0, chats: [] });
    });
  });
  it('bridge5. gestor NÃO herda instância pessoal de membro (W4 não está em team_instances)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(GESTOR));
      expect(chatIds(r.body)).not.toContain('CH4');
    });
  });
  it('19. tenant sem chats visíveis → lista vazia (USERT2)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(USERT2));
      expect(r.body.total).toBe(0); expect(r.body.chats).toEqual([]);
    });
  });
});

describe('GET /api/chats — filtros, paginação, ordenação, busca', () => {
  it('8+9. paginação no banco + ordenação por última atividade desc', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const p1 = await request(app).get('/api/chats?limit=1&page=1').set('Authorization', bearer(ADMIN));
      expect(p1.body.total).toBe(3); expect(p1.body.chats).toHaveLength(1);
      expect(p1.body.chats[0].id).toBe('CH4'); // 2026-07-03 é a mais recente
      const p2 = await request(app).get('/api/chats?limit=1&page=2').set('Authorization', bearer(ADMIN));
      expect(p2.body.chats[0].id).toBe('CH2'); // 2026-07-02
      const p3 = await request(app).get('/api/chats?limit=1&page=3').set('Authorization', bearer(ADMIN));
      expect(p3.body.chats[0].id).toBe('CH1'); // 2026-07-01
    });
  });
  it('10. filtro is_group=1 → só grupos', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?is_group=1').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH2']);
    });
  });
  it('11. busca por nome do contato', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?search=Alice').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH1']);
    });
  });
  it('12. busca por telefone do contato', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?search=5531900000002').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH2']);
    });
  });
  it('14. filtro por data (last activity)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?date_from=2026-07-02 00:00:00').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH2', 'CH4']); // exclui CH1 (07-01)
    });
  });
  it('17. parâmetros inválidos → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/chats?is_group=xyz').set('Authorization', bearer(ADMIN))).status).toBe(400);
      expect((await request(app).get('/api/chats?date_from=nao-e-data').set('Authorization', bearer(ADMIN))).status).toBe(400);
    });
  });
  it('18. limite máximo de paginação é respeitado (cap 100)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?limit=9999').set('Authorization', bearer(ADMIN));
      expect(r.body.limit).toBe(100);
    });
  });
  it('filtro instance_id (sentinela_instances.id) → só aquela instância', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?instance_id=__i2__').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH2']);
    });
  });
});

describe('GET /api/chats/:id/messages — thread, filtros, isolamento', () => {
  it('retorna mensagens em ordem cronológica; direção diferencia enviada/recebida', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH1/messages').set('Authorization', bearer(USER1));
      expect(r.status).toBe(200);
      expect(r.body.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
      expect(r.body.messages[0].direction).toBe('incoming');
      expect(r.body.messages[1].direction).toBe('outgoing');
      expect(r.body.messages[1].sender).toEqual({ self: true });
      expect(r.body.messages[0].sender.phone).toBe('5531900000001');
    });
  });
  it('15+16. filtro por tipo + áudio com transcrição', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH1/messages?type=audio').set('Authorization', bearer(USER1));
      expect(r.body.messages).toHaveLength(1);
      expect(r.body.messages[0].type).toBe('audio');
      expect(r.body.messages[0].text).toContain('transcricao');
    });
  });
  it('13. busca por palavra-chave nas mensagens (FULLTEXT)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH1/messages?search=mundo').set('Authorization', bearer(USER1));
      expect(r.body.messages.map((m) => m.id)).toEqual(['m1']);
    });
  });
  it('14. filtro por data na thread', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH1/messages?date_from=2026-07-01 10:01:30').set('Authorization', bearer(USER1));
      expect(r.body.messages.map((m) => m.id)).toEqual(['m3']);
    });
  });
  it('5. chat de outro tenant → 404 (indistinguível de inexistente)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH3/messages').set('Authorization', bearer(USER1));
      expect(r.status).toBe(404);
    });
  });
  it('6. chat de instância não visível → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH2/messages').set('Authorization', bearer(USER1)); // CH2=W2
      expect(r.status).toBe(404);
    });
  });
  it('7. chat inexistente → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/NAOEXISTE/messages').set('Authorization', bearer(ADMIN));
      expect(r.status).toBe(404);
    });
  });
  it('bridge12. escopo vazio (USER2) → 404 sem consultar mensagens', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH1/messages').set('Authorization', bearer(USER2));
      expect(r.status).toBe(404);
    });
  });
  it('20. chat sem mensagens (admin) → 200 com lista vazia', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CHV/messages').set('Authorization', bearer(ADMIN));
      expect(r.status).toBe(200); expect(r.body.messages).toEqual([]); expect(r.body.total).toBe(0);
    });
  });
});

describe('PUT /api/instances/:id/capture-wid — ponte (superadmin/admin)', () => {
  it('bridge7. mapear um capture_wid já usado → 409', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/instances/__i0__/capture-wid').set('Authorization', bearer(ADMIN)).send({ captureWid: 'W1' });
      expect(r.status).toBe(409);
    });
  });
  it('bridge8. mapear capture de outro tenant → 403', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/instances/__i0__/capture-wid').set('Authorization', bearer(ADMIN)).send({ captureWid: 'W3' }); // W3=t2
      expect(r.status).toBe(403);
    });
  });
  it('bridge11. capture_wid inexistente em instances → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/instances/__i0__/capture-wid').set('Authorization', bearer(ADMIN)).send({ captureWid: 'WNONE' });
      expect(r.status).toBe(404);
    });
  });
  it('mapear capture válida do mesmo tenant → 200 e passa a ver as conversas', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      // instância de captura W4 nova para i0? W4 já é de i4. Use W4 desvinculando i4 antes.
      await c.query("UPDATE sentinela_instances SET capture_wid=NULL WHERE id='__i4__'");
      const set = await request(app).put('/api/instances/__i0__/capture-wid').set('Authorization', bearer(ADMIN)).send({ captureWid: 'W4' });
      expect(set.status).toBe(200);
      await c.query("INSERT INTO user_instances (user_id,instance_id) VALUES (900012,'__i0__') ON DUPLICATE KEY UPDATE user_id=user_id");
      const r = await request(app).get('/api/chats').set('Authorization', bearer(USER2));
      expect(chatIds(r.body)).toEqual(['CH4']);
    });
  });
  it('bridge9. nulificar a ponte revoga o acesso imediatamente', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const before = await request(app).get('/api/chats').set('Authorization', bearer(USER1));
      expect(chatIds(before.body)).toEqual(['CH1']);
      const clr = await request(app).put('/api/instances/__i1__/capture-wid').set('Authorization', bearer(ADMIN)).send({ captureWid: null });
      expect(clr.status).toBe(200);
      const after = await request(app).get('/api/chats').set('Authorization', bearer(USER1));
      expect(after.body.chats).toEqual([]);
    });
  });
  it('bridge10. admin continua limitado ao tenant (não é afetado pela ponte)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH1', 'CH2', 'CH4']); // sempre o tenant t1
    });
  });
  it('usuário comum não pode alterar capture_wid (403)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/instances/__i1__/capture-wid').set('Authorization', bearer(USER1)).send({ captureWid: 'W2' });
      expect(r.status).toBe(403);
    });
  });
});
