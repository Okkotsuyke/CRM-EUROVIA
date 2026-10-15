/**
 * Dashboard service — cálculo de KPIs
 * Todas as datas em UTC; timezone da loja convertido na query
 */
import { PrismaClient, Plaza, UserRole, AppointmentStatus } from '@prisma/client';
import { storeIdFilter } from './store-scope';

type DashboardFilters = {
  startDate: Date;
  endDate: Date;
  granularity?: 'day' | 'month' | 'year';
  plaza?: Plaza | 'ALL';
  storeIds?: string[];
  mediaIds?: string[];
  vlUserIds?: string[];
  vsUserIds?: string[];
  eventTypes?: string[];
};

type AuthUser = { id: string; role: UserRole; storeId: string | null };

/**
 * safeRate: retorna null quando denominador é zero (não "0% fake")
 */
function safeRate(numerator: number, denominator: number, decimals = 2): number | null {
  if (denominator === 0) return null;
  const factor = Math.pow(10, decimals);
  return Math.round((numerator / denominator) * 100 * factor) / factor;
}

// ── Where clauses reutilizáveis ─────────────────────────────

function buildLeadWhere(filters: DashboardFilters, user: AuthUser) {
  return {
    receivedAt: { gte: filters.startDate, lte: filters.endDate },
    storeId: storeIdFilter(user, filters.storeIds),
    ...(filters.mediaIds?.length ? { mediaSourceId: { in: filters.mediaIds } } : {}),
    ...(filters.vlUserIds?.length ? { assignedVlId: { in: filters.vlUserIds } } : {}),
    ...(filters.vsUserIds?.length ? { assignedVsId: { in: filters.vsUserIds } } : {}),
    ...(filters.eventTypes?.length ? { eventType: { in: filters.eventTypes } } : {}),
  };
}

function buildAppointmentWhere(filters: DashboardFilters, user: AuthUser) {
  return {
    appointmentDate: { gte: filters.startDate, lte: filters.endDate },
    status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
    storeId: storeIdFilter(user, filters.storeIds),
  };
}

function buildFlowWhere(filters: DashboardFilters, user: AuthUser) {
  return {
    flowDate: { gte: filters.startDate, lte: filters.endDate },
    storeId: storeIdFilter(user, filters.storeIds),
  };
}

function buildSalesWhere(filters: DashboardFilters, user: AuthUser) {
  return {
    saleDate: { gte: filters.startDate, lte: filters.endDate },
    tipoVenda: 'Venda Seminovos',
    storeId: storeIdFilter(user, filters.storeIds),
    ...(filters.vsUserIds?.length ? { vsUserId: { in: filters.vsUserIds } } : {}),
    ...(filters.mediaIds?.length ? { mediaSourceId: { in: filters.mediaIds } } : {}),
  };
}

// ── Overview ───────────────────────────────────────────────

async function getOverview(prisma: PrismaClient, filters: DashboardFilters, user: AuthUser) {
  const [leads, appointments, storeFlow, sales] = await Promise.all([
    prisma.lead.count({ where: buildLeadWhere(filters, user) }),
    prisma.appointment.count({ where: buildAppointmentWhere(filters, user) }),
    prisma.flowEvent.count({ where: buildFlowWhere(filters, user) }),
    prisma.sale.count({ where: buildSalesWhere(filters, user) }),
  ]);

  const lastSync = await prisma.syncRun.findFirst({
    where: { status: 'SUCCESS' },
    orderBy: { finishedAt: 'desc' },
    select: { finishedAt: true },
  });

  return {
    leadsReceived: leads,
    appointments,
    storeFlow,
    sales,
    conversionLeadSale: safeRate(sales, leads),
    conversionLeadAppointment: safeRate(appointments, leads),
    conversionLeadFlow: safeRate(storeFlow, leads),
    lastSyncAt: lastSync?.finishedAt?.toISOString() ?? null,
  };
}

// ── By Store ───────────────────────────────────────────────

async function getByStore(prisma: PrismaClient, filters: DashboardFilters, user: AuthUser) {
  // Pegar todas as lojas (filtradas por praça se aplicável)
  const stores = await prisma.store.findMany({
    where: {
      active: true,
      ...(filters.plaza && filters.plaza !== 'ALL' ? { plaza: filters.plaza } : {}),
      id: storeIdFilter(user, filters.storeIds),
    },
    orderBy: { plaza: 'asc' },
  });

  const leadWhere = buildLeadWhere(filters, user);
  const appointmentWhere = buildAppointmentWhere(filters, user);
  const flowWhere = buildFlowWhere(filters, user);
  const salesWhere = buildSalesWhere(filters, user);

  const rows = await Promise.all(
    stores.map(async (store) => {
      const [leads, appointments, storeFlow, sales] = await Promise.all([
        prisma.lead.count({ where: { ...leadWhere, storeId: store.id } }),
        prisma.appointment.count({ where: { ...appointmentWhere, storeId: store.id } }),
        prisma.flowEvent.count({ where: { ...flowWhere, storeId: store.id } }),
        prisma.sale.count({ where: { ...salesWhere, storeId: store.id } }),
      ]);

      return {
        storeId: store.id,
        storeName: store.shortName,
        plaza: store.plaza,
        leads,
        appointments,
        storeFlow,
        sales,
        conversionRate: safeRate(sales, leads),
        appointmentRate: safeRate(appointments, leads),
        flowRate: safeRate(storeFlow, leads),
      };
    }),
  );

  // Totais por praça
  const fortalezaRows = rows.filter(r => r.plaza === Plaza.FORTALEZA);
  const salvadorRows = rows.filter(r => r.plaza === Plaza.SALVADOR);

  const sumRow = (arr: typeof rows, label: string, plaza?: Plaza) => ({
    storeId: plaza ?? null,
    storeName: label,
    plaza: plaza ?? null,
    leads: arr.reduce((s, r) => s + r.leads, 0),
    appointments: arr.reduce((s, r) => s + r.appointments, 0),
    storeFlow: arr.reduce((s, r) => s + r.storeFlow, 0),
    sales: arr.reduce((s, r) => s + r.sales, 0),
    conversionRate: safeRate(
      arr.reduce((s, r) => s + r.sales, 0),
      arr.reduce((s, r) => s + r.leads, 0),
    ),
    appointmentRate: safeRate(
      arr.reduce((s, r) => s + r.appointments, 0),
      arr.reduce((s, r) => s + r.leads, 0),
    ),
    flowRate: safeRate(
      arr.reduce((s, r) => s + r.storeFlow, 0),
      arr.reduce((s, r) => s + r.leads, 0),
    ),
    isPlazaRow: true,
  });

  return {
    stores: rows,
    plazas: [
      sumRow(fortalezaRows, 'Fortaleza', Plaza.FORTALEZA),
      sumRow(salvadorRows, 'Salvador', Plaza.SALVADOR),
    ],
    total: sumRow(rows, 'Geral'),
  };
}

// ── By Media ───────────────────────────────────────────────

async function getByMedia(prisma: PrismaClient, filters: DashboardFilters, user: AuthUser) {
  const leadWhere = buildLeadWhere(filters, user);
  const salesWhere = buildSalesWhere(filters, user);

  const totalLeads = await prisma.lead.count({ where: leadWhere });

  const mediaRows = await prisma.mediaSource.findMany({
    where: { active: true },
    orderBy: { normalizedName: 'asc' },
  });

  const rows = await Promise.all(
    mediaRows.map(async (media) => {
      const [leads, appointments, storeFlow, sales] = await Promise.all([
        prisma.lead.count({ where: { ...leadWhere, mediaSourceId: media.id } }),
        prisma.appointment.count({
          where: {
            ...buildAppointmentWhere(filters, user),
            lead: { mediaSourceId: media.id },
          },
        }),
        prisma.flowEvent.count({
          where: { ...buildFlowWhere(filters, user), lead: { mediaSourceId: media.id } },
        }),
        prisma.sale.count({ where: { ...salesWhere, mediaSourceId: media.id } }),
      ]);

      return {
        mediaId: media.id,
        mediaNormalizedName: media.normalizedName,
        mediaCategory: media.category,
        leads,
        appointments,
        storeFlow,
        sales,
        conversionRate: safeRate(sales, leads),
        appointmentRate: safeRate(appointments, leads),
        flowRate: safeRate(storeFlow, leads),
        sharePercent: safeRate(leads, totalLeads),
      };
    }),
  );

  return rows.filter(r => r.leads > 0);
}

// ── By Consultant (VL) ─────────────────────────────────────

async function getByConsultant(prisma: PrismaClient, filters: DashboardFilters, user: AuthUser) {
  const isRestricted = user.role === 'VL_CONSULTANT';

  const vlUsers = await prisma.user.findMany({
    where: {
      role: UserRole.VL_CONSULTANT,
      active: true,
      ...(isRestricted ? { id: user.id } : {}),
      storeId: storeIdFilter(user, filters.storeIds),
      ...(filters.vlUserIds?.length ? { id: { in: filters.vlUserIds } } : {}),
    },
    include: { store: true },
  });

  const leadWhere = buildLeadWhere(filters, user);
  const appointmentWhere = buildAppointmentWhere(filters, user);
  const salesWhere = buildSalesWhere(filters, user);

  const rows = await Promise.all(
    vlUsers.map(async (vl) => {
      const [leads, appointments, storeFlow, sales] = await Promise.all([
        prisma.lead.count({ where: { ...leadWhere, assignedVlId: vl.id } }),
        prisma.appointment.count({ where: { ...appointmentWhere, createdByUserId: vl.id } }),
        prisma.flowEvent.count({
          where: {
            ...buildFlowWhere(filters, user),
            lead: { assignedVlId: vl.id },
          },
        }),
        prisma.sale.count({ where: { ...salesWhere, vlUserId: vl.id } }),
      ]);

      // Encaminhados
      const [toVs, toBdc] = await Promise.all([
        prisma.lead.count({ where: { ...leadWhere, assignedVlId: vl.id, assignedVsId: { not: null } } }),
        prisma.lead.count({ where: { ...leadWhere, assignedVlId: vl.id, assignedBdcId: { not: null } } }),
      ]);

      return {
        userId: vl.id,
        userName: vl.name,
        username: vl.username,
        role: 'VL_CONSULTANT' as const,
        storeId: vl.storeId,
        storeName: vl.store?.shortName ?? null,
        leads,
        leadsToVs: toVs,
        leadsToBdc: toBdc,
        appointments,
        storeFlow,
        sales,
        conversionRate: safeRate(sales, leads),
        averageContactHours: null, // calculado via ProductivitySnapshot se disponível
        lastSyncAt: null,
      };
    }),
  );

  return rows;
}

// ── By Seller (VS) ────────────────────────────────────────

async function getBySeller(prisma: PrismaClient, filters: DashboardFilters, user: AuthUser) {
  const vsUsers = await prisma.user.findMany({
    where: {
      role: UserRole.VS_SELLER,
      active: true,
      storeId: storeIdFilter(user, filters.storeIds),
      ...(filters.vsUserIds?.length ? { id: { in: filters.vsUserIds } } : {}),
    },
    include: { store: true },
  });

  const leadWhere = buildLeadWhere(filters, user);
  const salesWhere = buildSalesWhere(filters, user);

  const rows = await Promise.all(
    vsUsers.map(async (vs) => {
      const [leads, appointments, storeFlow, sales] = await Promise.all([
        prisma.lead.count({ where: { ...leadWhere, assignedVsId: vs.id } }),
        prisma.appointment.count({
          where: {
            ...buildAppointmentWhere(filters, user),
            lead: { assignedVsId: vs.id },
          },
        }),
        prisma.flowEvent.count({
          where: { ...buildFlowWhere(filters, user), lead: { assignedVsId: vs.id } },
        }),
        prisma.sale.count({ where: { ...salesWhere, vsUserId: vs.id } }),
      ]);

      return {
        userId: vs.id,
        userName: vs.name,
        username: vs.username,
        role: 'VS_SELLER' as const,
        storeId: vs.storeId,
        storeName: vs.store?.shortName ?? null,
        leads,
        appointments,
        storeFlow,
        sales,
        conversionRate: safeRate(sales, leads),
        appointmentRate: safeRate(appointments, leads),
        flowRate: safeRate(storeFlow, leads),
      };
    }),
  );

  return rows;
}

export const dashboardService = {
  getOverview,
  getByStore,
  getByMedia,
  getByConsultant,
  getBySeller,
};
