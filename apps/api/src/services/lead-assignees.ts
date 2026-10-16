/**
 * Lead assignees — resolve VL/VS/BDC de leads
 * Lead guarda apenas os IDs (assigned_vl_id, assigned_vs_id, assigned_bdc_id) sem relação Prisma,
 * então os usuários são buscados em lote e anexados ao resultado.
 */
import type { Prisma } from '@prisma/client';

export type UserSummary = { id: string; name: string; username: string };

type LeadAssigneeIds = {
  assignedVlId: string | null;
  assignedVsId: string | null;
  assignedBdcId?: string | null;
};

export type WithAssignees<T> = T & {
  assignedVl: UserSummary | null;
  assignedVs: UserSummary | null;
  assignedBdc: UserSummary | null;
};

export async function attachAssignees<T extends LeadAssigneeIds>(
  prisma: Pick<Prisma.TransactionClient, 'user'>,
  leads: T[],
): Promise<WithAssignees<T>[]> {
  const ids = new Set<string>();
  for (const lead of leads) {
    if (lead.assignedVlId) ids.add(lead.assignedVlId);
    if (lead.assignedVsId) ids.add(lead.assignedVsId);
    if (lead.assignedBdcId) ids.add(lead.assignedBdcId);
  }

  const users = ids.size
    ? await prisma.user.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, name: true, username: true },
      })
    : [];
  const byId = new Map(users.map(u => [u.id, u]));
  const resolve = (id: string | null | undefined) => (id ? byId.get(id) ?? null : null);

  return leads.map(lead => ({
    ...lead,
    assignedVl: resolve(lead.assignedVlId),
    assignedVs: resolve(lead.assignedVsId),
    assignedBdc: resolve(lead.assignedBdcId),
  }));
}

export async function attachLeadAssignees<L extends LeadAssigneeIds, A extends { lead: L }>(
  prisma: Pick<Prisma.TransactionClient, 'user'>,
  appointments: A[],
): Promise<(Omit<A, 'lead'> & { lead: WithAssignees<L> })[]> {
  const leads = await attachAssignees(prisma, appointments.map(a => a.lead));
  return appointments.map((appointment, i) => ({ ...appointment, lead: leads[i] }));
}
