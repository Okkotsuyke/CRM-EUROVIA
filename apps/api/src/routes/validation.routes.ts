/**
 * Routes: Validation
 * Endpoints para validação de dados pelo cliente terceiro
 * USA SYONET DIRETAMENTE para buscar dados em tempo real
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationStatus, ValidationItemType } from '@prisma/client';
import { authenticateDashboard } from '../middleware/auth.middleware';
import { STORE_MAPPING } from '../services/syonet-client';
import { extractLeadsData, SyonetRealConfig } from '../services/syonet-real-client';

/**
 * Configuracao carregada SOMENTE no momento de uma consulta aprovada.
 * A API Eurovia inicia sem credenciais Syonet quando a integracao
 * de leitura estiver desativada ou nao configurada.
 */
function getSyonetReadConfig(): SyonetRealConfig {
  const { SYONET_URL, SYONET_USERNAME, SYONET_PASSWORD } = process.env;
  if (!SYONET_URL || !SYONET_USERNAME || !SYONET_PASSWORD) {
    throw new Error('Consulta Syonet indisponivel: integracao nao configurada');
  }
  return {
    baseUrl: SYONET_URL,
    username: SYONET_USERNAME,
    password: SYONET_PASSWORD,
    headless: true,
    timeout: 120000,
  };
}

const ValidationItemSchema = z.object({
  itemType: z.enum(['LEAD', 'SALE', 'APPOINTMENT', 'STORE', 'VL_CONSULTANT', 'MEDIA', 'OVERALL']),
  itemId: z.string().optional(),
  status: z.enum(['CORRETO', 'INCORRETO']),
  feedback: z.string().min(3).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
});

type ValidationItemInput = z.infer<typeof ValidationItemSchema>;

declare module 'fastify' {
  interface FastifyRequest {
    allowedSyonetStoreIds: Set<string>;
  }
}

export async function validationRoutes(fastify: FastifyInstance) {

  fastify.addHook('preHandler', authenticateDashboard);
  fastify.addHook('preHandler', async (request, reply) => {
    const permittedStoreIds = request.dashboardUser.allowedStores;
    if (!permittedStoreIds?.length) {
      return reply.status(403).send({
        success: false, error: 'Avaliador sem lojas autorizadas',
      });
    }
    // O JWT nao decide o escopo. Mapeamos a lista atual da base Eurovia
    // para IDs externos Syonet, sem realizar operacao de escrita.
    const stores = await fastify.prisma.store.findMany({
      where: { id: { in: permittedStoreIds }, active: true },
      select: { syonetName: true },
    });
    const names = new Set(stores.map(store => store.syonetName.trim().toUpperCase()));
    const externalIds = Object.values(STORE_MAPPING)
      .filter(meta => meta.syonetId !== undefined && names.has(meta.syonetName.trim().toUpperCase()))
      .map(meta => 'syonet_' + meta.syonetId);
    request.allowedSyonetStoreIds = new Set(externalIds);
    if (!request.allowedSyonetStoreIds.size) {
      return reply.status(403).send({
        success: false, error: 'Loja do avaliador sem mapeamento autorizado',
      });
    }
  });

  /**
   * GET /api/v1/dashboard/validation/leads
   * Lista leads do SYONET para validação (tempo real)
   */
  fastify.get('/leads', async (request, reply) => {
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    console.log(`📊 Syonet: Buscando leads de ${startDate} até ${endDate}`);

    try {
      // Calcular range de datas
      let dateRange: { start: Date; end: Date } | undefined;
      if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateRange = { start, end };
      }

      // Buscar leads direto do Syonet
      const leads = (await extractLeadsData(getSyonetReadConfig(), dateRange))
        .filter(lead => request.allowedSyonetStoreIds.has(lead.storeId));

      console.log(`✅ Syonet: ${leads.length} leads encontrados`);

      // Buscar validações existentes do nosso banco
      const leadIds = leads.map(l => l.id);
      const validations = await fastify.prisma.validationReport.findMany({
        where: {
          dashboardUserId: request.dashboardUser.id,
          itemType: 'LEAD',
          itemId: { in: leadIds },
        },
      });

      const validationMap = new Map(validations.map(v => [v.itemId, v]));

      return {
        success: true,
        data: leads.map(lead => ({
          ...lead,
          receivedAt: lead.receivedAt instanceof Date ? lead.receivedAt.toISOString() : lead.receivedAt,
          validation: validationMap.get(lead.id) || null,
        })),
        _meta: {
          source: 'syonet',
          dateRange,
          total: leads.length,
        },
      };
    } catch (error: any) {
      console.error('❌ Erro ao buscar leads do Syonet:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao conectar com Syonet',
        details: error.message,
      });
    }
  });

  /**
   * GET /api/v1/dashboard/validation/summary
   * Retorna resumo das validações do cliente + dados do Syonet
   */
  fastify.get('/summary', async (request, reply) => {
    const { id: userId } = request.dashboardUser;
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    console.log(`📊 Syonet: Buscando resumo de ${startDate} até ${endDate}`);

    try {
      // Buscar validações existentes
      const periodFilter: any = {};
      if (startDate) {
        periodFilter.createdAt = { gte: new Date(startDate + 'T00:00:00Z') };
      }
      if (endDate) {
        periodFilter.createdAt = { ...periodFilter.createdAt, lte: new Date(endDate + 'T23:59:59Z') };
      }

      const validations = await fastify.prisma.validationReport.findMany({
        where: {
          dashboardUserId: userId,
          ...(Object.keys(periodFilter).length > 0 ? periodFilter : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      // Buscar dados em tempo real do Syonet
      let dateRange: { start: Date; end: Date } | undefined;
      if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateRange = { start, end };
      }

      let syonetData = { leadsCount: 0, salesCount: 0 };
      try {
        const leads = (await extractLeadsData(getSyonetReadConfig(), dateRange))
        .filter(lead => request.allowedSyonetStoreIds.has(lead.storeId));
        syonetData.leadsCount = leads.length;
        console.log(`✅ Syonet: ${leads.length} leads no período`);
      } catch (err) {
        console.warn('⚠️ Erro ao buscar leads do Syonet:', err);
      }

      // Agrupar validações por tipo
      const byType: Record<string, Record<string, number>> = {};
      for (const v of validations) {
        if (!byType[v.itemType]) {
          byType[v.itemType] = { CORRETO: 0, INCORRETO: 0 };
        }
        byType[v.itemType][v.status]++;
      }

      return {
        success: true,
        data: {
          total: validations.length,
          byType,
          recent: validations.slice(0, 10),
          syonet: syonetData,
        },
      };
    } catch (error: any) {
      console.error('❌ Erro no summary:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao buscar dados',
        details: error.message,
      });
    }
  });

  /**
   * GET /api/v1/dashboard/validation/kpis
   * Lista KPIs do SYONET para validação (tempo real)
   */
  fastify.get('/kpis', async (request, reply) => {
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    console.log(`📊 Syonet: Buscando KPIs de ${startDate} até ${endDate}`);

    try {
      // Calcular range de datas
      let dateRange: { start: Date; end: Date } | undefined;
      if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateRange = { start, end };
      }

      // Buscar dados do Syonet
      const leads = (await extractLeadsData(getSyonetReadConfig(), dateRange))
        .filter(lead => request.allowedSyonetStoreIds.has(lead.storeId));

      // Agregar por loja
      const storeMetrics: Record<string, { leads: number; sales: number; conversionRate: number }> = {};

      for (const lead of leads) {
        const storeKey = lead.storeId || 'unknown';
        if (!storeMetrics[storeKey]) {
          storeMetrics[storeKey] = { leads: 0, sales: 0, conversionRate: 0 };
        }
        storeMetrics[storeKey].leads++;

        // Se tem venda, contar
        if (lead.status === 'FECHADO' || lead.status === 'VENDIDO') {
          storeMetrics[storeKey].sales++;
        }
      }

      // Calcular taxa de conversão
      for (const storeKey of Object.keys(storeMetrics)) {
        const m = storeMetrics[storeKey];
        m.conversionRate = m.leads > 0 ? (m.sales / m.leads) * 100 : 0;
      }

      // Mapear para formato de saída
      const kpiData = Object.entries(storeMetrics).map(([storeId, metrics]) => ({
        storeId,
        storeName: storeId, // O Syonet não retorna nome da loja diretamente
        plaza: 'Carregando...',
        leadsCount: metrics.leads,
        salesCount: metrics.sales,
        appointmentsCount: 0,
        conversionRate: Math.round(metrics.conversionRate * 100) / 100,
      }));

      console.log(`✅ Syonet: ${kpiData.length} lojas com dados`);

      return {
        success: true,
        data: kpiData,
        _meta: {
          source: 'syonet',
          dateRange,
          totalLeads: leads.length,
        },
      };
    } catch (error: any) {
      console.error('❌ Erro ao buscar KPIs do Syonet:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao conectar com Syonet',
        details: error.message,
      });
    }
  });

  /**
   * GET /api/v1/dashboard/validation/sales
   * Lista vendas do SYONET (tempo real)
   */
  fastify.get('/sales', async (request, reply) => {
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    console.log(`📊 Syonet: Buscando vendas de ${startDate} até ${endDate}`);

    try {
      // Buscar leads do Syonet (que inclui vendas)
      let dateRange: { start: Date; end: Date } | undefined;
      if (startDate && endDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateRange = { start, end };
      }

      const leads = (await extractLeadsData(getSyonetReadConfig(), dateRange))
        .filter(lead => request.allowedSyonetStoreIds.has(lead.storeId));

      // Filtrar apenas leads com vendas (status FECHADO ou VENDIDO)
      const sales = leads.filter(l =>
        l.status === 'FECHADO' ||
        l.status === 'VENDIDO'
      );

      // Buscar validações existentes
      const saleIds = sales.map(s => s.id);
      const validations = await fastify.prisma.validationReport.findMany({
        where: {
          dashboardUserId: request.dashboardUser.id,
          itemType: 'SALE',
          itemId: { in: saleIds },
        },
      });

      const validationMap = new Map(validations.map(v => [v.itemId, v]));

      return {
        success: true,
        data: sales.map(sale => ({
          ...sale,
          receivedAt: sale.receivedAt instanceof Date ? sale.receivedAt.toISOString() : sale.receivedAt,
          validation: validationMap.get(sale.id) || null,
        })),
        _meta: {
          source: 'syonet',
          dateRange,
          total: sales.length,
        },
      };
    } catch (error: any) {
      console.error('❌ Erro ao buscar vendas do Syonet:', error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao conectar com Syonet',
        details: error.message,
      });
    }
  });

  /**
   * POST /api/v1/dashboard/validation/validate
   * Marca um item como válido ou inválido
   */
  fastify.post('/validate', async (request, reply) => {
    let body: ValidationItemInput;
    try {
      body = ValidationItemSchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: 'Dados inválidos',
        details: err,
      });
    }

    const { id: userId } = request.dashboardUser;
    // Validacao granular deve conhecer a loja do registro externo.
    // Ate existir vinculo confiavel para cada entidade, falhar fechado.
    if (body.itemType === 'STORE') {
      if (!body.itemId ||
          (!request.dashboardUser.allowedStores.includes(body.itemId) &&
           !request.allowedSyonetStoreIds.has(body.itemId))) {
        return reply.status(403).send({
          success: false, error: 'Loja nao autorizada para validacao',
        });
      }
    } else if (body.itemType !== 'OVERALL') {
      return reply.status(503).send({
        success: false, error: 'Validacao granular indisponivel ate homologacao do vinculo de loja',
      });
    }

    // Validar feedback quando INCORRETO
    if (body.status === 'INCORRETO' && (!body.feedback || body.feedback.length < 3)) {
      return reply.status(400).send({
        success: false,
        error: 'Descrição do problema é obrigatória (mínimo 3 caracteres)',
      });
    }

    // Verificar se já existe validação para este item
    const existing = await fastify.prisma.validationReport.findFirst({
      where: {
        itemType: body.itemType as ValidationItemType,
        itemId: body.itemId || null,
        dashboardUserId: userId,
        periodStart: body.periodStart ? new Date(body.periodStart) : null,
        periodEnd: body.periodEnd ? new Date(body.periodEnd) : null,
      },
    });

    if (existing) {
      // Atualizar validação existente
      const updated = await fastify.prisma.validationReport.update({
        where: { id: existing.id },
        data: {
          status: body.status as ValidationStatus,
          feedback: body.feedback || null,
        },
      });

      return {
        success: true,
        data: updated,
        message: 'Validação atualizada com sucesso',
      };
    }

    // Criar nova validação
    const validation = await fastify.prisma.validationReport.create({
      data: {
        itemType: body.itemType as ValidationItemType,
        itemId: body.itemId || null,
        status: body.status as ValidationStatus,
        feedback: body.feedback || null,
        dashboardUserId: userId,
        periodStart: body.periodStart ? new Date(body.periodStart) : null,
        periodEnd: body.periodEnd ? new Date(body.periodEnd) : null,
      },
    });

    return {
      success: true,
      data: validation,
      message: 'Validação registrada com sucesso',
    };
  });

  /**
   * DELETE /api/v1/dashboard/validation/:id
   * Remove uma validação
   */
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const { id: userId } = request.dashboardUser;

    const validation = await fastify.prisma.validationReport.findUnique({
      where: { id },
    });

    if (!validation) {
      return reply.status(404).send({ success: false, error: 'Validação não encontrada' });
    }

    if (validation.dashboardUserId !== userId) {
      return reply.status(403).send({ success: false, error: 'Sem permissão para excluir esta validação' });
    }

    await fastify.prisma.validationReport.delete({ where: { id } });

    return {
      success: true,
      message: 'Validação removida com sucesso',
    };
  });
}

export default validationRoutes;
