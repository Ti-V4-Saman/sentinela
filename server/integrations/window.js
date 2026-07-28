// Janela determinística (dia local anterior) + chave de idempotência (Etapa B — integração em lote).
//
// Módulo PURO: nenhuma chamada a `Date.now()`/`new Date()` sem argumentos, nenhuma dependência
// externa de datas/timezone. O instante "agora" é SEMPRE recebido via parâmetro `nowUtc: Date`
// — quem chama em produção passa `new Date()`; os testes passam datas fixas.
//
// Cálculo de offset de timezone sem libs externas:
//   Formatamos o instante UTC (`nowUtc`) usando `Intl.DateTimeFormat(..., { timeZone, ... })` com
//   `formatToParts`, obtendo os componentes de calendário/hora "vistos" naquele timezone. Depois
//   reconstituímos esses mesmos componentes como se fossem UTC (`Date.UTC(...)`) — a diferença entre
//   esse valor reconstituído e o instante original é exatamente o offset do timezone naquele
//   instante (em ms). Essa é a técnica padrão sem dependências para obter offset/DST por Intl.
//
// DST (mudança de horário): a janela é sempre definida pelas FRONTEIRAS DE DIA LOCAL (00:00 a
// 00:00 do dia seguinte, hora local do timezone da integração), nunca por um span fixo de 24h.
// Em dias de transição de horário de verão, o dia local pode ter 23h (spring-forward, "pula" uma
// hora) ou 25h (fall-back, "repete" uma hora) de span em UTC. Isso é INTENCIONAL: a semântica do
// produto é "todas as mensagens do dia de calendário local X", não "as últimas 24 horas".

const MS_PER_MINUTE = 60 * 1000;

// Formata um instante UTC nos componentes de calendário/hora vistos em `timeZone`.
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  // `hour` pode vir '24' em alguns runtimes/ICU para meia-noite; normaliza para '00'.
  if (map.hour === '24') map.hour = '00';
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// Offset do timezone (em ms, a somar a um instante local-como-UTC para obter o UTC real) no
// instante `date`. offset = (instante "lido" no tz, tratado como UTC) - (instante UTC real).
function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

// Converte uma data/hora de calendário LOCAL (ano/mês/dia/hora/min, sem timezone) no timezone
// dado para o instante UTC correspondente. Resolve o offset por aproximação de ponto fixo (o
// offset pode variar entre o palpite inicial e o instante real perto de transições de DST).
function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Primeira aproximação: offset no instante "como se fosse UTC".
  let offset = tzOffsetMs(new Date(naiveUtcMs), timeZone);
  let candidate = naiveUtcMs - offset;
  // Refinar uma vez com o offset no candidato (cobre a maioria dos casos perto de transições).
  const offset2 = tzOffsetMs(new Date(candidate), timeZone);
  if (offset2 !== offset) {
    candidate = naiveUtcMs - offset2;
  }
  return new Date(candidate);
}

function parseRunAtTime(runAtTime) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(runAtTime || ''));
  if (!m) throw new Error(`window: run_at_time inválido: ${JSON.stringify(runAtTime)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`window: run_at_time fora de faixa: ${runAtTime}`);
  return { hour, minute };
}

// Calcula a janela devida (dia local anterior completo) e o instante `dueAt` (run_at_time de hoje,
// no timezone da integração), ambos convertidos para UTC.
//
// Retorna `null` se:
//  - `nowUtc < dueAt` (ainda não venceu o horário de disparo de hoje), OU
//  - `cfg.last_run_window_end` já cobre a janela (`last_run_window_end >= end`) — idempotência:
//    não reprocessa uma janela já registrada como concluída em execuções anteriores do job.
export function computeDueWindow(cfg, nowUtc) {
  if (cfg.frequency !== 'daily') {
    throw new Error(`window: frequency não suportada: ${cfg.frequency}`);
  }
  const { timezone } = cfg;
  const { hour, minute } = parseRunAtTime(cfg.run_at_time);

  // "Hoje", no calendário local do timezone, no instante nowUtc.
  const nowLocal = zonedParts(nowUtc, timezone);

  // dueAt = run_at_time de hoje, no timezone.
  const dueAt = zonedTimeToUtc(
    { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day, hour, minute },
    timezone
  );

  if (nowUtc.getTime() < dueAt.getTime()) {
    return null;
  }

  // Janela = dia local ANTERIOR completo [00:00, 24:00) local, convertido para UTC.
  // "Ontem" local: usamos Date.UTC sobre os componentes de calendário para subtrair 1 dia com
  // segurança (aritmética de calendário, não de instante).
  const todayAsUtcNoon = Date.UTC(nowLocal.year, nowLocal.month - 1, nowLocal.day, 12, 0, 0);
  const yesterdayAsUtcNoon = todayAsUtcNoon - 24 * 60 * MS_PER_MINUTE;
  const yesterday = new Date(yesterdayAsUtcNoon);
  const yYear = yesterday.getUTCFullYear();
  const yMonth = yesterday.getUTCMonth() + 1;
  const yDay = yesterday.getUTCDate();

  const start = zonedTimeToUtc({ year: yYear, month: yMonth, day: yDay, hour: 0, minute: 0 }, timezone);
  const end = zonedTimeToUtc(
    { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day, hour: 0, minute: 0 },
    timezone
  );

  if (cfg.last_run_window_end != null && cfg.last_run_window_end.getTime() >= end.getTime()) {
    return null;
  }

  return { start, end, dueAt };
}

// Trunca um Date para segundos (remove milissegundos) e retorna ISO estável para compor a chave.
function isoNoMillis(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Chave de idempotência determinística e estável. Formato:
//   t{tenant}-i{integration}-{startISO}_{endISO}-v{schema}-p{part}
// Distinta sempre que qualquer campo mudar; <= 120 caracteres.
export function idempotencyKey({ tenantId, integrationId, windowStart, windowEnd, schemaVersion, part }) {
  const key = `t${tenantId}-i${integrationId}-${isoNoMillis(windowStart)}_${isoNoMillis(windowEnd)}-v${schemaVersion}-p${part}`;
  if (key.length > 120) {
    throw new Error(`window: idempotencyKey excedeu 120 caracteres (${key.length}): ${key}`);
  }
  return key;
}

// Reenvio manual: reusa a janela JÁ ARMAZENADA no batch (não recalcula), garantindo que o reenvio
// produza a MESMA idempotencyKey do batch original.
export function manualResendWindow(batch) {
  return { start: batch.window_start, end: batch.window_end };
}
