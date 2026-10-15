/**
 * Productivity service — Página 2: Produtividade por VL
 */
import { PrismaClient, UserRole, LeadStatusNormalized, AppointmentStatus } from '@prisma/client';
import { storeIdFilter } from './store-scope';

type ProductivityFilters = {
  consultantId?: string;
  storeId?: string;
  plaza?: string;
  status?: LeadStatusNormalized[];
  priority?: boolean;
  date?: string; // YYYY-MM-DD
};

type AuthUser = { id: string; role: UserRole; storeId: string | null };

// ── Status normalizado mapping ─────────────────────────────
// Estes status dependem dos dados reais do Syonet.
// MVP: usar enum predefinido; mapear via regra configurável.

const STATUS_MAPPING: Record<string, LeadStatusNormalized> = {
  // TODO: mapear a partir dos status reais do Syonet após CSV import
  // Por ora, usar status Syonet direto como normalizado
};

function normalizeStatus(s: string): LeadStatusNormalized {
  const upper = s.toUpperCase().trim();
  if (upper.includes('AGUARD') || upper === 'PENDING') return LeadStatusNormalized.AGUARDANDO;
  if (upper.includes('ATRAS') || upper.includes('LATE')) return LeadStatusNormalized.ATRASADO;
  if (upper.includes('PENDENTE') || upper.includes('PEND_DIA')) return LeadStatusNormalized.PENDENTE_DIA;
  if (upper.includes('FUTURO') || upper.includes('FUTURE')) return LeadStatusNormalized.FUTURO;
  if (upper.includes('ENCAMINH') || upper.includes('TRANSFER')) return LeadStatusNormalized.ENCAMINHADO;
  if (upper.includes('VEND') || upper.includes('SOLD')) return LeadStatusNormalized.VENDIDO;
  return LeadStatusNormalized.AGUARDANDO; // default
}

// ── Portfolio summary por VL ────────────────────────────────

async function getPortfolioSummary(prisma: PrismaClient, userId: string, filters: ProductivityFilters, user: AuthUser) {
  const where: any = {
    assignedVlId: userId,
    storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
  };

  if (filters.status?.length) {
    where.statusNormalized = { in: filters.status };
  }
  if (filters.priority) {
    where.priorityFlag = true;
  }

  const [total, aguardando, atrasado, pendenteDia, futuro, prioridade, trabalhados] =
    await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.count({ where: { ...where, statusNormalized: LeadStatusNormalized.AGUARDANDO } }),
      prisma.lead.count({ where: { ...where, statusNormalized: LeadStatusNormalized.ATRASADO } }),
      prisma.lead.count({ where: { ...where, statusNormalized: LeadStatusNormalized.PENDENTE_DIA } }),
      prisma.lead.count({ where: { ...where, statusNormalized: LeadStatusNormalized.FUTURO } }),
      prisma.lead.count({ where: { ...where, priorityFlag: true } }),
      // Trabalhados = snapshot mais recente
      prisma.productivitySnapshot.findFirst({
        where: { userId, storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined) },
        orderBy: { periodEnd: 'desc' },
        select: { leadsXVendedorLoja: true, leadsXOperadorBdc: true },
      }),
    ]);

  return {
    total,
    aguardando,
    atrasado,
    pendenteDia,
    futuro,
    prioridade,
    trabalhados:
      (trabalhados?.leadsXVendedorLoja ?? 0) + (trabalhados?.leadsXOperadorBdc ?? 0),
  };
}

// ── Leads da carteira ──────────────────────────────────────

async function getPortfolioLeads(prisma: PrismaClient, userId: string, filters: ProductivityFilters, user: AuthUser) {
  const where: any = {
    assignedVlId: userId,
    storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
  };

  if (filters.status?.length) {
    where.statusNormalized = { in: filters.status };
  }
  if (filters.priority) {
    where.priorityFlag = true;
  }

  const leads = await prisma.lead.findMany({
    where,
    include: {
      store: { select: { shortName: true } },
      mediaSource: { select: { normalizedName: true } },
    },
    orderBy: [
      { priorityFlag: 'desc' },
      { receivedAt: 'desc' },
    ],
    take: 500, // limite razoável
  });

  // Próximo agendamento por lead
  const leadIds = leads.map(l => l.id);
  const nextAppointments = await prisma.appointment.findMany({
    where: {
      leadId: { in: leadIds },
      storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
      appointmentDate: { gte: new Date() },
    },
    select: { leadId: true, appointmentDate: true },
    orderBy: { appointmentDate: 'asc' },
  });
  const appointmentMap = new Map(nextAppointments.map(a => [a.leadId, a.appointmentDate]));

  return leads.map(l => ({
    id: l.id,
    syonetLeadId: l.syonetLeadId,
    storeName: l.store.shortName,
    mediaNormalizedName: l.mediaSource?.normalizedName ?? null,
    status: l.status,
    statusNormalized: l.statusNormalized ?? normalizeStatus(l.status),
    priorityFlag: l.priorityFlag,
    receivedAt: l.receivedAt.toISOString(),
    lastContactAt: null, // TODO: via lead_events
    nextAppointmentDate: appointmentMap.get(l.id)?.toISOString() ?? null,
    assignedVlName: null,
  }));
}

// ── Agenda do dia ──────────────────────────────────────────

async function getTodayAgenda(prisma: PrismaClient, userId: string, filters: ProductivityFilters, user: AuthUser) {
  const today = filters.date ? new Date(filters.date) : new Date();
  const startOfDay = new Date(today);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today);
  endOfDay.setHours(23, 59, 59, 999);

  const selectedConsultant = user.role === 'VL_CONSULTANT'
    ? userId : filters.consultantId;

  const appointments = await prisma.appointment.findMany({
    where: {
      appointmentDate: { gte: startOfDay, lte: endOfDay },
      status: { notIn: [AppointmentStatus.CANCELLED] },
      storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
      ...(selectedConsultant ? { createdByUserId: selectedConsultant } : {}),
    },
    include: {
      lead: {
        select: {
          id: true,
          syonetLeadId: true,
          assignedVlId: true,
          assignedVsId: true,
          store: { select: { shortName: true } },
        },
      },
    },
    orderBy: { appointmentDate: 'asc' },
  });

  // Verificar se há venda gerada no dia para cada lead
  const leadIds = appointments.map(a => a.leadId);
  const salesToday = await prisma.sale.findMany({
    where: {
      leadId: { in: leadIds },
      storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
      saleDate: { gte: startOfDay, lte: endOfDay },
    },
    select: { leadId: true },
  });
  const salesSet = new Set(salesToday.map(s => s.leadId));

  const vlNames = await prisma.user.findMany({
    where: {
      id: { in: appointments.map(a => a.lead.assignedVlId).filter(Boolean) as string[] },
      storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
    },
    select: { id: true, name: true },
  });
  const vlMap = new Map(vlNames.map(v => [v.id, v.name]));

  const vsNames = await prisma.user.findMany({
    where: {
      id: { in: appointments.map(a => a.lead.assignedVsId).filter(Boolean) as string[] },
      storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
    },
    select: { id: true, name: true },
  });
  const vsMap = new Map(vsNames.map(v => [v.id, v.name]));

  return appointments.map(a => ({
    id: a.id,
    leadId: a.leadId,
    leadName: a.lead.syonetLeadId,
    storeName: a.lead.store.shortName,
    appointmentDate: a.appointmentDate.toISOString(),
    confirmedFlag: a.confirmedFlag,
    status: a.status,
    vlName: a.lead.assignedVlId ? vlMap.get(a.lead.assignedVlId) ?? null : null,
    vsName: a.lead.assignedVsId ? vsMap.get(a.lead.assignedVsId) ?? null : null,
    saleGenerated: salesSet.has(a.leadId),
  }));
}

// ── Todos consultores com portfólio ───────────────────────

async function getAllConsultantsPortfolio(prisma: PrismaClient, filters: ProductivityFilters, user: AuthUser) {
  const isRestricted = user.role === 'VL_CONSULTANT';

  const consultants = await prisma.user.findMany({
    where: {
      role: UserRole.VL_CONSULTANT,
      active: true,
      storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
      ...(isRestricted ? { id: user.id } : {}),
      ...(filters.consultantId ? { id: filters.consultantId } : {}),
    },
    include: { store: true },
  });

  return Promise.all(
    consultants.map(async (vl) => {
      const summary = await getPortfolioSummary(prisma, vl.id, filters, user);
      const today = filters.date ?? new Date().toISOString().split('T')[0];

      const [appointmentsToday, confirmedToday, salesToday, lastSnapshot] = await Promise.all([
        prisma.appointment.count({
          where: {
            createdByUserId: vl.id,
            storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
            appointmentDate: {
              gte: new Date(today + 'T00:00:00Z'),
              lte: new Date(today + 'T23:59:59Z'),
            },
            status: { notIn: [AppointmentStatus.CANCELLED] },
          },
        }),
        prisma.appointment.count({
          where: {
            createdByUserId: vl.id,
            storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
            appointmentDate: {
              gte: new Date(today + 'T00:00:00Z'),
              lte: new Date(today + 'T23:59:59Z'),
            },
            confirmedFlag: true,
          },
        }),
        prisma.sale.count({
          where: {
            vlUserId: vl.id,
            storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined),
            saleDate: {
              gte: new Date(today + 'T00:00:00Z'),
              lte: new Date(today + 'T23:59:59Z'),
            },
          },
        }),
        prisma.productivitySnapshot.findFirst({
          where: { userId: vl.id, storeId: storeIdFilter(user, filters.storeId ? [filters.storeId] : undefined) },
          orderBy: { periodEnd: 'desc' },
        }),
      ]);

      return {
        userId: vl.id,
        userName: vl.name,
        username: vl.username,
        storeName: vl.store?.shortName ?? null,
        statusCounts: summary,
        appointmentsToday,
        confirmedToday,
        salesToday,
        leadsXVendedorLoja: lastSnapshot?.leadsXVendedorLoja ?? 0,
        leadsXOperadorBdc: lastSnapshot?.leadsXOperadorBdc ?? 0,
        totalWorkedPortfolio:
          (lastSnapshot?.leadsXVendedorLoja ?? 0) + (lastSnapshot?.leadsXOperadorBdc ?? 0),
      };
    }),
  );
}

export const productivityService = {
  getPortfolioSummary,
  getPortfolioLeads,
  getTodayAgenda,
  getAllConsultantsPortfolio,
};
