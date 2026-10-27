import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { PrismaClient, Prisma, Risk, Status } from '@prisma/client';
import { z } from 'zod';

export const prisma = new PrismaClient();
export const app = express();

app.use(cors());
app.use(express.json());

const risks: Risk[] = [
  'EMERGENCIA',
  'MUITO_URGENTE',
  'URGENTE',
  'POUCO_URGENTE',
  'NAO_URGENTE',
];

const cpfValid = (input: string) => {
  const cpf = input.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

  for (let len = 9; len <= 10; len++) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    let digit = (sum * 10) % 11;
    if (digit === 10) digit = 0;
    if (digit !== Number(cpf[len])) return false;
  }
  return true;
};

const patientSchema = z.object({
  name: z.string().trim().min(3, 'Informe o nome completo (mínimo de 3 caracteres).'),
  cpf: z.string().trim().refine(cpfValid, 'CPF inválido.'),
  birthDate: z.coerce.date({ invalid_type_error: 'Informe uma data de nascimento válida.' }),
  sex: z.string().trim().min(1, 'Selecione o sexo.'),
  phone: z.string().trim().min(8, 'Informe um telefone com pelo menos 8 caracteres.'),
  address: z.string().trim().min(5, 'Informe um endereço com pelo menos 5 caracteres.'),
});

const triageSchema = z.object({
  patientId: z.string().min(1, 'Selecione um paciente.'),
  symptoms: z.string().trim().min(3, 'Descreva os sintomas (mínimo de 3 caracteres).'),
  observations: z.string().trim().default(''),
  risk: z.nativeEnum(Risk),
});

// Em desenvolvimento local, não exige token para facilitar o uso do frontend.
// Em produção, APP_API_TOKEN é obrigatório e precisa ser enviado como Bearer token.
const auth: express.RequestHandler = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();

  const token = process.env.APP_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'APP_API_TOKEN não está configurado no servidor.' });
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Não autorizado. Verifique o token da API.' });
  }
  return next();
};

app.use('/api', auth);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/patients', async (req, res, next) => {
  try {
    const q = String(req.query.q || '');
    const patients = await prisma.patient.findMany({
      where: q
        ? { OR: [{ name: { contains: q } }, { cpf: { contains: q.replace(/\D/g, '') } }] }
        : {},
      orderBy: { name: 'asc' },
    });
    return res.json(patients);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/patients', async (req, res, next) => {
  try {
    const input = patientSchema.parse(req.body);
    const patient = await prisma.patient.create({
      data: { ...input, cpf: input.cpf.replace(/\D/g, '') },
    });
    return res.status(201).json(patient);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/patients/:id', async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({ where: { id: req.params.id } });
    if (!patient) return res.status(404).json({ error: 'Paciente não encontrado.' });
    return res.json(patient);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/patients/:id', async (req, res, next) => {
  try {
    const input = patientSchema.parse(req.body);
    const patient = await prisma.patient.update({
      where: { id: req.params.id },
      data: { ...input, cpf: input.cpf.replace(/\D/g, '') },
    });
    return res.json(patient);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/triages', async (req, res, next) => {
  try {
    const input = triageSchema.parse(req.body);
    const patient = await prisma.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) return res.status(404).json({ error: 'Paciente não encontrado.' });

    const { patientId, ...triageData } = input;
    const triage = await prisma.triage.create({
      data: { ...triageData, patient: { connect: { id: patientId } } },
      include: { patient: true },
    });
    await prisma.encounter.create({ data: { triageId: triage.id } });
    return res.status(201).json(triage);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/triages', async (_req, res, next) => {
  try {
    const triages = await prisma.triage.findMany({
      include: { patient: true, encounter: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(triages);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/patients/:id/history', async (req, res, next) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: req.params.id },
      include: { triages: { include: { encounter: true }, orderBy: { createdAt: 'desc' } } },
    });
    if (!patient) return res.status(404).json({ error: 'Paciente não encontrado.' });
    return res.json(patient);
  } catch (error) {
    return next(error);
  }
});

const waitMinutes: Record<Risk, number> = {
  EMERGENCIA: 0,
  MUITO_URGENTE: 10,
  URGENTE: 60,
  POUCO_URGENTE: 120,
  NAO_URGENTE: 240,
};

app.get('/api/queue', async (req, res, next) => {
  try {
    const status = req.query.status as Status | undefined;
    const encounters = await prisma.encounter.findMany({
      where: status ? { status } : undefined,
      include: { triage: { include: { patient: true } } },
    });
    encounters.sort(
      (a, b) => risks.indexOf(a.triage.risk) - risks.indexOf(b.triage.risk)
        || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return res.json(encounters.map((encounter) => ({
      ...encounter,
      estimatedWaitMinutes: waitMinutes[encounter.triage.risk],
    })));
  } catch (error) {
    return next(error);
  }
});

app.patch('/api/encounters/:id/status', async (req, res, next) => {
  try {
    const { status } = z.object({
      status: z.enum(['AGUARDANDO', 'EM_ATENDIMENTO', 'CONCLUIDO']),
    }).parse(req.body);
    const encounter = await prisma.encounter.update({
      where: { id: req.params.id },
      data: { status },
    });
    return res.json(encounter);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/docs', (_req, res) => res.json({
  openapi: '3.0.3',
  info: { title: 'HealthCare Triagem API', version: '1.0.0' },
  servers: [{ url: '/api' }],
  paths: {
    '/patients': { get: { summary: 'Lista pacientes' }, post: { summary: 'Cadastra paciente' } },
    '/triages': { get: { summary: 'Lista triagens' }, post: { summary: 'Registra triagem' } },
    '/queue': { get: { summary: 'Fila priorizada' } },
    '/patients/{id}/history': { get: { summary: 'Histórico clínico' } },
  },
}));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    const details = error.issues.map((issue) => {
      const field = issue.path.length ? issue.path.join('.') : 'dados';
      return `${field}: ${issue.message}`;
    });
    return res.status(400).json({ error: `Dados inválidos: ${details.join(' ')}`, details: error.issues });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Este CPF já está cadastrado.' });
    if (error.code === 'P2025') return res.status(404).json({ error: 'Registro não encontrado.' });
  }

  console.error(error);
  return res.status(500).json({ error: 'Erro interno do servidor. Confira o terminal da API.' });
});

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => console.log(`API HealthCare em http://localhost:${port}`));
}
