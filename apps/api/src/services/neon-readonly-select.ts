/**
 * CRM Eurovia — explicit read-only projections for Neon staging.
 * Never expose rawPayload/rawData or password fields to the browser.
 */
import type { Prisma } from '@prisma/client';

export const neonLeadSelect = {
  id: true, syonetLeadId: true, storeId: true, mediaSourceId: true,
  mediaRaw: true, receivedAt: true, integrationDate: true,
  status: true, statusNormalized: true, priorityFlag: true,
  assignedVlId: true, assignedVsId: true, assignedBdcId: true,
  eventType: true, department: true, tipoVenda: true, origem: true,
  createdAt: true, updatedAt: true,
  store: { select: {
    id: true, shortName: true, plaza: true, city: true,
    state: true, timezone: true, active: true,
  } },
  mediaSource: { select: {
    id: true, rawName: true, normalizedName: true,
    category: true, active: true,
  } },
} satisfies Prisma.LeadSelect;

export const neonLeadDetailSelect = {
  ...neonLeadSelect,
  leadEvents: {
    select: {
      id: true, leadId: true, eventType: true,
      eventDate: true, userId: true, description: true, createdAt: true,
      user: { select: { id: true, name: true, username: true } },
    },
    orderBy: { eventDate: 'desc' },
    take: 50,
  },
  appointments: {
    select: {
      id: true, leadId: true, storeId: true,
      appointmentDate: true, confirmedFlag: true, status: true,
      createdByUserId: true, createdAt: true, updatedAt: true,
    },
    orderBy: { appointmentDate: 'desc' },
    take: 50,
  },
  sale: {
    select: {
      id: true, leadId: true, storeId: true,
      saleDate: true, tipoVenda: true, amount: true,
      status: true, createdAt: true,
    },
  },
} satisfies Prisma.LeadSelect;

export const neonAppointmentSelect = {
  id: true, leadId: true, storeId: true,
  appointmentDate: true, confirmedFlag: true, status: true,
  createdByUserId: true, syonetReference: true,
  createdAt: true, updatedAt: true,
  lead: { select: {
    id: true, storeId: true, syonetLeadId: true, status: true,
    statusNormalized: true, assignedVlId: true, assignedVsId: true,
    assignedBdcId: true,
  } },
  store: { select: {
    id: true, shortName: true, plaza: true,
    city: true, state: true, timezone: true,
  } },
  createdByUser: { select: { id: true, name: true, username: true } },
} satisfies Prisma.AppointmentSelect;
