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
  it('filtro team_id → conversas das instâncias da equipe (team_instances)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?team_id=900100').set('Authorization', bearer(ADMIN)); // team_instances → __i1__ (W1)
      expect(chatIds(r.body)).toEqual(['CH1']);
    });
  });
  it('filtro user_id → conversas das instâncias do usuário (user_instances)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?user_id=900011').set('Authorization', bearer(ADMIN)); // user_instances → __i1__ (W1)
      expect(chatIds(r.body)).toEqual(['CH1']);
    });
  });
  it('filtro type (tipo da última mensagem) → CH1 termina em áudio', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?type=audio').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH1']);
    });
  });
  it('filtro keyword → conversas que contêm a palavra na mensagem', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?keyword=ru').set('Authorization', bearer(ADMIN)); // "grupo" (CH2)
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
  it('13. busca por palavra-chave nas mensagens filtra (caminho LIKE — curto)', async () => {
    // Termo curto (<3) → caminho LIKE, que funciona em linhas não-commitadas.
    // O caminho FULLTEXT (termo normal) é comprovado nos unit tests de messageTextSearch
    // (o índice FTS do InnoDB não enxerga linhas não-commitadas na transação de teste).
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CH1/messages?search=nd').set('Authorization', bearer(USER1));
      expect(r.body.messages.map((m) => m.id)).toEqual(['m1']); // 'ola mundo' contém 'nd'
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

// ---- Item 4: datas ----
describe('GET /api/chats — datas normalizadas', () => {
  it('date_to=YYYY-MM-DD inclui o dia INTEIRO (limite exclusivo no dia seguinte)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?date_to=2026-07-01').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH1']); // CH1 (07-01 10:02) incluída, apesar do date-only
    });
  });
  it('date_to=YYYY-MM-DD do último dia inclui mensagens até o fim do dia', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?date_to=2026-07-03').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH1', 'CH2', 'CH4']); // CH4 (07-03 08:00) incluída
    });
  });
  it('datetime ISO é aceito', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?date_from=2026-07-02T00:00:00').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CH2', 'CH4']);
    });
  });
  it('data inválida/ambígua → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/chats?date_from=01/07/2026').set('Authorization', bearer(ADMIN))).status).toBe(400);
      expect((await request(app).get('/api/chats?date_to=2026-13-40').set('Authorization', bearer(ADMIN))).status).toBe(400);
      expect((await request(app).get('/api/chats?date_from=ontem').set('Authorization', bearer(ADMIN))).status).toBe(400);
    });
  });
  it('date_from > date_to → resultado vazio (sem erro)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?date_from=2026-07-05&date_to=2026-07-01').set('Authorization', bearer(ADMIN));
      expect(r.status).toBe(200); expect(r.body.chats).toEqual([]);
    });
  });
});

describe('GET /api/chats — validação semântica de datetime', () => {
  const get = (c, q) => request(makeApp(c)).get(`/api/chats?${q}`).set('Authorization', bearer(ADMIN));
  const cases = [
    ['1. 2026-02-30 (dia inexistente)', 'date_from=2026-02-30', 400],
    ['2. 2025-02-29 (não bissexto)', 'date_from=2025-02-29', 400],
    ['3. 2024-02-29 (bissexto válido)', 'date_from=2024-02-29', 200],
    ['4. hora 24:00:00', 'date_from=2026-07-27T24:00:00', 400],
    ['5. minuto 60', 'date_from=2026-07-27T10:60:00', 400],
    ['6. segundo 60', 'date_from=2026-07-27T10:00:60', 400],
    ['7. datetime válido sem timezone', 'date_from=2026-07-27T10:00:00', 200],
    ['8. datetime com Z', 'date_from=2026-07-27T10:00:00Z', 400],
    ['9. datetime com offset -03:00', 'date_from=2026-07-27T23:00:00-03:00', 400],
    ['fração de segundo sem tz', 'date_from=2026-07-27T10:00:00.500', 400],
  ];
  for (const [label, q, status] of cases) {
    it(label + ` → ${status}`, async () => {
      await withTx(async (c) => { await seed(c); expect((await get(c, q)).status).toBe(status); });
    });
  }
  it('mensagem de timezone é específica (Z/offset)', async () => {
    await withTx(async (c) => {
      await seed(c);
      const r = await get(c, 'date_from=2026-07-27T10:00:00Z');
      expect(r.body.error).toMatch(/timezone/i);
    });
  });
  it('10. datetime inválido não vira 500 (é barrado com 400 antes da query)', async () => {
    await withTx(async (c) => {
      await seed(c);
      for (const q of ['date_from=2026-02-30T10:00:00', 'date_to=2026-07-27T25:61:99', 'date_from=2026-07-27T10:00:00Z']) {
        const r = await get(c, q);
        expect(r.status).toBe(400); // nunca 500 (erro do MySQL)
      }
    });
  });
});

// ---- Item 2: resolução determinística do contato ----
// tenant t1, admin 900050. Instância W1/i1. Contatos C1(Alice), C5(Eve).
// CHR: recebida(C1) → enviada(sem contato)     → contato = Alice
// CHI: recebida(C5) → interna(sem contato)      → contato = Eve
// CHM: recebida(C1) → recebida(C5)              → contato = Eve (mais recente não-nulo)
// CHN: enviada(sem) → interna(sem)              → contato = null
async function seedContacts(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1')");
  await conn.query("INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES (900050,900001,'Admin','a@__test__','x','admin','active')");
  await conn.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001)");
  await conn.query("INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES ('__i1__',900001,900050,'A','t1','W1')");
  await conn.query(`INSERT INTO contacts (id,tenant_id,phone,name) VALUES
    ('C1',900001,'5531900000001','Alice'),('C5',900001,'5531900000005','Eve')`);
  await conn.query(`INSERT INTO chats (id,tenant_id,title,is_group) VALUES
    ('CHR',900001,NULL,0),('CHI',900001,NULL,0),('CHM',900001,NULL,1),('CHN',900001,NULL,0)`);
  await conn.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('r1',900001,'CHR','C1','oi','text',0,0,'2026-07-01 10:00:00','W1'),
    ('r2',900001,'CHR',NULL,'resposta enviada','text',1,0,'2026-07-01 10:05:00','W1'),
    ('i1',900001,'CHI','C5','oi eve','text',0,0,'2026-07-01 10:00:00','W1'),
    ('i2',900001,'CHI',NULL,'nota interna','text',0,1,'2026-07-01 10:05:00','W1'),
    ('mm1',900001,'CHM','C1','de alice','text',0,0,'2026-07-01 10:00:00','W1'),
    ('mm2',900001,'CHM','C5','de eve','text',0,0,'2026-07-01 10:05:00','W1'),
    ('n1',900001,'CHN',NULL,'enviada','text',1,0,'2026-07-01 10:00:00','W1'),
    ('n2',900001,'CHN',NULL,'interna','text',0,1,'2026-07-01 10:05:00','W1')`);
}
const byId = (body) => Object.fromEntries(body.chats.map((c) => [c.id, c]));

describe('GET /api/chats — contato determinístico (última msg pode não ter contato)', () => {
  it('1. recebida-com-contato + enviada-sem-contato → mantém o contato', async () => {
    await withTx(async (c) => {
      await seedContacts(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(ADMIN));
      expect(byId(r.body).CHR.contact).toMatchObject({ name: 'Alice', phone: '5531900000001' });
      expect(byId(r.body).CHR.lastMessage.direction).toBe('outgoing'); // última msg real preservada
    });
  });
  it('2. última mensagem interna sem contato → usa o contato anterior', async () => {
    await withTx(async (c) => {
      await seedContacts(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(ADMIN));
      expect(byId(r.body).CHI.contact.name).toBe('Eve');
    });
  });
  it('3. vários contatos não-nulos → o mais recente', async () => {
    await withTx(async (c) => {
      await seedContacts(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(ADMIN));
      expect(byId(r.body).CHM.contact.name).toBe('Eve');
    });
  });
  it('4. ausência total de contato → contato nulo', async () => {
    await withTx(async (c) => {
      await seedContacts(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats').set('Authorization', bearer(ADMIN));
      expect(byId(r.body).CHN.contact).toEqual({ id: null, name: null, displayName: null, phone: null, identified: false, type: null });
    });
  });
  it('5. busca por nome/telefone funciona mesmo com última msg sem contato; sem multiplicar linhas', async () => {
    await withTx(async (c) => {
      await seedContacts(c); const app = makeApp(c);
      const byName = await request(app).get('/api/chats?search=Alice').set('Authorization', bearer(ADMIN));
      expect(chatIds(byName.body)).toEqual(['CHR']); expect(byName.body.total).toBe(1);
      const byPhone = await request(app).get('/api/chats?search=5531900000001').set('Authorization', bearer(ADMIN));
      expect(chatIds(byPhone.body)).toEqual(['CHR']);
    });
  });
});

// ---- Item 5: chat_id ambíguo entre tenants ----
async function seedAmbiguous(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900000,NULL,'Super','s@__test__','x','superadmin','active'),
    (900050,900001,'Admin','a@__test__','x','admin','active')`);
  await conn.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001),('W3',900002)");
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES
    ('__i1__',900001,900050,'A','t1','W1'),('__i3__',900002,900050,'C','t3','W3')`);
  await conn.query(`INSERT INTO contacts (id,tenant_id,phone,name) VALUES
    ('C1',900001,'5531900000001','Alice'),('C3',900002,'5531900000003','Carol')`);
  await conn.query(`INSERT INTO chats (id,tenant_id,title,is_group) VALUES ('SAME',900001,'T1chat',0),('SAME',900002,'T2chat',0)`);
  await conn.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('a1',900001,'SAME','C1','no tenant 1','text',0,0,'2026-07-01 10:00:00','W1'),
    ('a3',900002,'SAME','C3','no tenant 2','text',0,0,'2026-07-01 10:00:00','W3')`);
}

describe('GET /api/chats/:id/messages — chat_id ambíguo entre tenants (item 5)', () => {
  it('superadmin: listagem traz refs distintos; detalhe por ref abre o chat certo', async () => {
    await withTx(async (c) => {
      await seedAmbiguous(c); const app = makeApp(c);
      const list = await request(app).get('/api/chats').set('Authorization', bearer(SUPER));
      const items = list.body.chats.filter((x) => x.id === 'SAME');
      expect(items).toHaveLength(2);
      const refs = items.map((x) => x.ref);
      expect(new Set(refs).size).toBe(2); // refs distintos
      const t1 = items.find((x) => x.title === 'T1chat');
      const t2 = items.find((x) => x.title === 'T2chat');
      const r1 = await request(app).get(`/api/chats/${t1.ref}/messages`).set('Authorization', bearer(SUPER));
      expect(r1.body.messages.map((m) => m.text)).toEqual(['no tenant 1']);
      const r2 = await request(app).get(`/api/chats/${t2.ref}/messages`).set('Authorization', bearer(SUPER));
      expect(r2.body.messages.map((m) => m.text)).toEqual(['no tenant 2']);
    });
  });
  it('superadmin com chat_id CRU ambíguo → 400 orientando usar ref', async () => {
    await withTx(async (c) => {
      await seedAmbiguous(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/SAME/messages').set('Authorization', bearer(SUPER));
      expect(r.status).toBe(400);
    });
  });
  it('admin: chat_id cru resolve sem ambiguidade dentro do próprio tenant', async () => {
    await withTx(async (c) => {
      await seedAmbiguous(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/SAME/messages').set('Authorization', bearer(ADMIN));
      expect(r.status).toBe(200);
      expect(r.body.messages.map((m) => m.text)).toEqual(['no tenant 1']); // só t1
    });
  });
  it('ref de outro tenant para não-superadmin → 404 (RBAC revalida)', async () => {
    await withTx(async (c) => {
      await seedAmbiguous(c); const app = makeApp(c);
      const list = await request(app).get('/api/chats').set('Authorization', bearer(SUPER));
      const t2 = list.body.chats.find((x) => x.title === 'T2chat');
      const r = await request(app).get(`/api/chats/${t2.ref}/messages`).set('Authorization', bearer(ADMIN)); // admin t1
      expect(r.status).toBe(404);
    });
  });
});

// ---- keyword escopado pelos wid visíveis (não vaza por instância não autorizada) ----
// CHX é a MESMA conversa com mensagens em DUAS instâncias do mesmo tenant:
//   WA (autorizada a 900011) contém "xy"  |  WB (NÃO autorizada a 900011) contém "zw".
// CHW só tem WC ("xy"); CHT2 é de outro tenant (WD, "zw"). Termos de 2 chars → caminho LIKE
// (funciona em linhas não-commitadas). user_instances: 900011→iA. gestor 900040 gere Eq1(WA)+Eq2(WB).
async function seedKw(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900050,900001,'Admin','a@__test__','x','admin','active'),
    (900040,900001,'Gestor','g@__test__','x','gestor','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900012,900001,'U2','u2@__test__','x','usuario','active')`);
  await conn.query(`INSERT INTO instances (wid,tenant_id) VALUES
    ('WA',900001),('WB',900001),('WC',900001),('WD',900002)`);
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES
    ('__iA__',900001,900011,'A','ta','WA'),
    ('__iB__',900001,900050,'B','tb','WB'),
    ('__iC__',900001,900050,'C','tc','WC'),
    ('__iD__',900002,900050,'D','td','WD')`);
  await conn.query("INSERT INTO user_instances (user_id,instance_id) VALUES (900011,'__iA__')");
  await conn.query("INSERT INTO teams (id,tenant_id,name) VALUES (900100,900001,'Eq1'),(900101,900001,'Eq2')");
  await conn.query("INSERT INTO team_managers (team_id,user_id) VALUES (900100,900040),(900101,900040)");
  await conn.query("INSERT INTO team_instances (team_id,instance_id) VALUES (900100,'__iA__'),(900101,'__iB__')");
  await conn.query(`INSERT INTO contacts (id,tenant_id,phone,name) VALUES
    ('C1',900001,'5531900000001','Alice'),('C2',900001,'5531900000002','Bob'),('C9',900002,'5531900000009','Zara')`);
  await conn.query(`INSERT INTO chats (id,tenant_id,title,is_group) VALUES
    ('CHX',900001,'Alice',0),('CHW',900001,'Bob',0),('CHT2',900002,'Zara',0)`);
  await conn.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('kA',900001,'CHX','C1','xy alpha','text',0,0,'2026-07-01 10:00:00','WA'),
    ('kB',900001,'CHX','C1','zw beta','text',0,0,'2026-07-01 10:05:00','WB'),
    ('kW',900001,'CHW','C2','xy gamma','text',0,0,'2026-07-01 09:00:00','WC'),
    ('kT',900002,'CHT2','C9','zw delta','text',0,0,'2026-07-01 08:00:00','WD')`);
}

describe('GET /api/chats?keyword — escopo por wid visível (bloqueia vazamento por instância)', () => {
  it('1-4. keyword só na instância NÃO autorizada (WB) → usuário NÃO vê a conversa', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?keyword=zw').set('Authorization', bearer(USER1));
      expect(r.status).toBe(200);
      expect(chatIds(r.body)).toEqual([]); // "zw" só existe em WB (não vinculada a 900011)
    });
  });
  it('5. keyword na instância autorizada (WA) → usuário vê a conversa', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?keyword=xy').set('Authorization', bearer(USER1));
      expect(chatIds(r.body)).toEqual(['CHX']); // "xy" existe em WA
    });
  });
  it('6. admin pesquisa em TODAS as instâncias do próprio tenant (acha via WB), sem vazar t2', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?keyword=zw').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CHX']); // via WB (mesmo tenant); CHT2 (t2) NÃO aparece
    });
  });
  it('7. gestor respeita interseção com team_id (WA): zw some, xy aparece', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const zwEq1 = await request(app).get('/api/chats?keyword=zw&team_id=900100').set('Authorization', bearer(GESTOR));
      expect(chatIds(zwEq1.body)).toEqual([]); // team 900100 → WA; "zw" não está em WA
      const xyEq1 = await request(app).get('/api/chats?keyword=xy&team_id=900100').set('Authorization', bearer(GESTOR));
      expect(chatIds(xyEq1.body)).toEqual(['CHX']);
    });
  });
  it('7b. gestor sem team_id acha via WB (escopo base {WA,WB})', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?keyword=zw').set('Authorization', bearer(GESTOR));
      expect(chatIds(r.body)).toEqual(['CHX']); // "zw" em WB, visível ao gestor via Eq2
    });
  });
  it('8. combinado keyword + instance_id restringe ao wid da instância', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const todos = await request(app).get('/api/chats?keyword=xy').set('Authorization', bearer(ADMIN));
      expect(chatIds(todos.body)).toEqual(['CHW', 'CHX']); // xy em WA (CHX) e WC (CHW)
      const soIA = await request(app).get('/api/chats?keyword=xy&instance_id=__iA__').set('Authorization', bearer(ADMIN));
      expect(chatIds(soIA.body)).toEqual(['CHX']); // WA apenas → CHW (WC) excluída
    });
  });
  it('9. combinado keyword + user_id restringe às instâncias do usuário', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?keyword=xy&user_id=900011').set('Authorization', bearer(ADMIN));
      expect(chatIds(r.body)).toEqual(['CHX']); // 900011 → iA (WA); CHW (WC) excluída
    });
  });
  it('10. escopo vazio (usuário sem instâncias) → nenhum resultado mesmo com keyword', async () => {
    await withTx(async (c) => {
      await seedKw(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats?keyword=xy').set('Authorization', bearer(USER2));
      expect(r.body).toEqual({ page: 1, limit: 20, total: 0, chats: [] });
    });
  });
});

// ---- paginação da thread: página 1 = mais recentes; ordem cronológica; sem sobreposição ----
const pad2 = (n) => String(n).padStart(2, '0');
async function seedThread(conn, n) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1')");
  await conn.query("INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES (900050,900001,'Admin','a@__test__','x','admin','active')");
  await conn.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001)");
  await conn.query("INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES ('__i1__',900001,900050,'A','t1','W1')");
  await conn.query("INSERT INTO contacts (id,tenant_id,phone,name) VALUES ('C1',900001,'5531900000001','Alice')");
  await conn.query("INSERT INTO chats (id,tenant_id,title,is_group) VALUES ('CHP',900001,'Alice',0)");
  const rows = [], params = [];
  const base = Date.UTC(2026, 6, 1, 10, 0, 0); // 2026-07-01 10:00:00, +1 min por mensagem
  for (let i = 0; i < n; i++) {
    const d = new Date(base + i * 60000);
    const ts = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    rows.push("(?,900001,'CHP','C1',?, 'text',0,0,?,'W1')");
    params.push(`p${String(i).padStart(3, '0')}`, `msg ${i}`, ts);
  }
  await conn.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES ${rows.join(',')}`, params);
}

describe('GET /api/chats/:id/messages — paginação (mais recentes primeiro, ordem cronológica)', () => {
  it('1-3. >50 msgs: página 1 traz as 50 MAIS RECENTES em ordem cronológica', async () => {
    await withTx(async (c) => {
      await seedThread(c, 120); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CHP/messages?limit=50&page=1').set('Authorization', bearer(ADMIN));
      expect(r.body.total).toBe(120);
      const ids = r.body.messages.map((m) => m.id);
      expect(ids).toHaveLength(50);
      expect(ids[0]).toBe('p070');  // mais antiga DA PÁGINA
      expect(ids[49]).toBe('p119'); // a mais recente do histórico
      const ts = r.body.messages.map((m) => new Date(m.at).getTime());
      expect(ts).toEqual([...ts].sort((a, b) => a - b)); // cronológico crescente
    });
  });
  it('4-5. página 2 traz as 50 anteriores, todas ANTES da página 1, sem sobreposição', async () => {
    await withTx(async (c) => {
      await seedThread(c, 120); const app = makeApp(c);
      const p1 = await request(app).get('/api/chats/CHP/messages?limit=50&page=1').set('Authorization', bearer(ADMIN));
      const p2 = await request(app).get('/api/chats/CHP/messages?limit=50&page=2').set('Authorization', bearer(ADMIN));
      const ids1 = p1.body.messages.map((m) => m.id);
      const ids2 = p2.body.messages.map((m) => m.id);
      expect(ids2[0]).toBe('p020'); expect(ids2[49]).toBe('p069');
      expect(ids2.some((id) => ids1.includes(id))).toBe(false); // sem duplicação
      expect(Math.max(...ids2.map((id) => +id.slice(1)))).toBeLessThan(Math.min(...ids1.map((id) => +id.slice(1))));
    });
  });
  it('7. somando as páginas (prepend) cobre o total sem buracos; além do fim vem vazio', async () => {
    await withTx(async (c) => {
      await seedThread(c, 120); const app = makeApp(c);
      const collect = [];
      for (const page of [1, 2, 3]) {
        const r = await request(app).get(`/api/chats/CHP/messages?limit=50&page=${page}`).set('Authorization', bearer(ADMIN));
        collect.unshift(...r.body.messages.map((m) => m.id)); // prepend, como no frontend
      }
      expect(collect).toHaveLength(120);
      expect(new Set(collect).size).toBe(120); // sem duplicação global
      expect(collect[0]).toBe('p000'); expect(collect[119]).toBe('p119'); // cronológico completo
      const p4 = await request(app).get('/api/chats/CHP/messages?limit=50&page=4').set('Authorization', bearer(ADMIN));
      expect(p4.body.messages).toEqual([]); // nada mais → botão desaparece no frontend
    });
  });
  it('6. empate de timestamp é desempatado por id (ordem estável e cronológica)', async () => {
    await withTx(async (c) => {
      await conn2seedTie(c); const app = makeApp(c);
      const r = await request(app).get('/api/chats/CHT/messages?limit=50').set('Authorization', bearer(ADMIN));
      expect(r.body.messages.map((m) => m.id)).toEqual(['t1a', 't1b', 't1c', 't2a']);
    });
  });
});

// mesmo timestamp em t1a/t1b/t1c (desempate por id asc), t2a um segundo depois.
async function conn2seedTie(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1')");
  await conn.query("INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES (900050,900001,'Admin','a@__test__','x','admin','active')");
  await conn.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001)");
  await conn.query("INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES ('__i1__',900001,900050,'A','t1','W1')");
  await conn.query("INSERT INTO contacts (id,tenant_id,phone,name) VALUES ('C1',900001,'5531900000001','Alice')");
  await conn.query("INSERT INTO chats (id,tenant_id,title,is_group) VALUES ('CHT',900001,'Alice',0)");
  await conn.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('t1a',900001,'CHT','C1','a','text',0,0,'2026-07-01 10:00:00','W1'),
    ('t1b',900001,'CHT','C1','b','text',0,0,'2026-07-01 10:00:00','W1'),
    ('t1c',900001,'CHT','C1','c','text',0,0,'2026-07-01 10:00:00','W1'),
    ('t2a',900001,'CHT','C1','d','text',0,0,'2026-07-01 10:00:01','W1')`);
}
