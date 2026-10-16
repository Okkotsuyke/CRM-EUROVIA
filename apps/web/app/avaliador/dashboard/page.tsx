'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ValidationPanel from './validation-panel';

// Tipos
interface OverviewData {
  totalLeads: number;
  totalSales: number;
  totalFlow: number;
  totalAppointments: number;
  conversionRate: number;
  showRate: number;
  storesCount: number;
}

interface StoreMetrics {
  storeId: string;
  storeName: string;
  plaza: string;
  leads: number;
  appointments: number;
  flow: number;
  sales: number;
  conversionRate: number;
  showRate: number;
}

interface VlMetrics {
  vlId: string;
  vlName: string;
  username: string;
  storeName: string;
  leads: number;
  leadsToVs: number;
  appointments: number;
  flow: number;
  sales: number;
  conversionRate: number;
  appointmentRate: number;
}

interface MediaMetrics {
  mediaName: string;
  category: string;
  leads: number;
  sales: number;
  conversionRate: number;
}

interface ProductivityData {
  vlId: string;
  vlName: string;
  username: string;
  storeName: string;
  plaza: string;
  leadsWaiting: number;
  leadsLate: number;
  leadsPendingToday: number;
  leadsFuture: number;
  leadsTotal: number;
  appointmentsToday: number;
  confirmedVisits: number;
  salesSuccess: number;
  averageContactMinutes: number | null;
  priorityClients: number;
  forwardedToVs: number;
}

interface TrendData {
  date: string;
  leads: number;
  appointments: number;
  flow: number;
  sales: number;
  conversionRate: number;
}

// Funções utilitárias
function formatNumber(num: number): string {
  return num.toLocaleString('pt-BR');
}

function formatPercent(num: number | undefined): string {
  if (num === undefined || num === null) return '—';
  return `${num.toFixed(1)}%`;
}

function formatTime(minutes: number | undefined): string {
  if (!minutes) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

// Componentes
function KpiCard({ title, value, subtitle, icon, variant = 'default' }: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const variantStyles = {
    default: 'border-slate-700',
    success: 'border-green-500 bg-green-500/5',
    warning: 'border-yellow-500 bg-yellow-500/5',
    danger: 'border-red-500 bg-red-500/5',
  };

  const iconStyles = {
    default: 'text-slate-400',
    success: 'text-green-400',
    warning: 'text-yellow-400',
    danger: 'text-red-400',
  };

  return (
    <div className={`p-4 rounded-xl border ${variantStyles[variant]} transition-all`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-slate-400">{title}</span>
        <span className={iconStyles[variant]}>{icon}</span>
      </div>
      <div className="text-2xl font-bold text-white mb-1">{value}</div>
      {subtitle && <div className="text-xs text-slate-500">{subtitle}</div>}
    </div>
  );
}

// Componente principal
export default function AvaliadorDashboardPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'stores' | 'vl' | 'media' | 'productivity' | 'validation'>('overview');

  // Filtros
  const [dateRange, setDateRange] = useState<'today' | '7d' | '30d' | 'month'>('30d');

  // Dados
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [stores, setStores] = useState<StoreMetrics[]>([]);
  const [vlMetrics, setVlMetrics] = useState<VlMetrics[]>([]);
  const [mediaMetrics, setMediaMetrics] = useState<MediaMetrics[]>([]);
  const [productivity, setProductivity] = useState<ProductivityData[]>([]);
  const [trend, setTrend] = useState<TrendData[]>([]);
  const [syncStatus, setSyncStatus] = useState<any>(null);

  // Verificar autenticação
  useEffect(() => {
    const storedToken = localStorage.getItem('dashboard_token');
    if (!storedToken) {
      router.push('/avaliador/login');
      return;
    }
    setToken(storedToken);
    setLoading(false);
  }, [router]);

  // Calcular datas baseado no range
  const getDateRange = useCallback(() => {
    const end = new Date();
    const start = new Date();

    switch (dateRange) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case '7d':
        start.setDate(start.getDate() - 7);
        break;
      case '30d':
        start.setDate(start.getDate() - 30);
        break;
      case 'month':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
    }

    return {
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
    };
  }, [dateRange]);

  // Buscar dados
  useEffect(() => {
    if (!token) return;

    const fetchData = async () => {
      const { startDate, endDate } = getDateRange();
      const params = `?startDate=${startDate}&endDate=${endDate}`;

      try {
        // Overview
        const overviewRes = await fetch(`/api/eurovia/api/v1/analytics/overview${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (overviewRes.status === 401) {
          localStorage.removeItem('dashboard_token');
          localStorage.removeItem('dashboard_user');
          router.push('/avaliador/login');
          return;
        }
        const overviewData = await overviewRes.json();
        if (overviewData.success) setOverview(overviewData.data);

        // Stores
        const storesRes = await fetch(`/api/eurovia/api/v1/analytics/by-store${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const storesData = await storesRes.json();
        if (storesData.success) setStores(storesData.data);

        // VL
        const vlRes = await fetch(`/api/eurovia/api/v1/analytics/by-vl${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const vlData = await vlRes.json();
        if (vlData.success) setVlMetrics(vlData.data);

        // Media
        const mediaRes = await fetch(`/api/eurovia/api/v1/analytics/by-media${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const mediaData = await mediaRes.json();
        if (mediaData.success) setMediaMetrics(mediaData.data);

        // Productivity
        const prodRes = await fetch(`/api/eurovia/api/v1/analytics/productivity`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const prodData = await prodRes.json();
        if (prodData.success) setProductivity(prodData.data);

        // Trend
        const trendRes = await fetch(`/api/eurovia/api/v1/analytics/trend${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const trendData = await trendRes.json();
        if (trendData.success) setTrend(trendData.data);

        // Sync Status
        const syncRes = await fetch(`/api/eurovia/api/v1/syonet-sync/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const syncData = await syncRes.json();
        if (syncData.success) setSyncStatus(syncData.data);

      } catch (error) {
        console.error('Erro ao buscar dados:', error);
      }
    };

    fetchData();
  }, [token, dateRange, getDateRange, router]);

  const handleLogout = () => {
    localStorage.removeItem('dashboard_token');
    localStorage.removeItem('dashboard_user');
    router.push('/avaliador/login');
  };

  const triggerSync = async () => {
    if (!token) return;
    try {
      await fetch(`/api/eurovia/api/v1/syonet-sync/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      // Recarregar dados
      window.location.reload();
    } catch (error) {
      console.error('Erro ao sincronizar:', error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <h1 className="text-lg font-semibold">CRM Leads Eurovia</h1>
                <p className="text-xs text-slate-500">Dashboard Analítico - Avaliador</p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Date Range */}
              <div className="flex bg-slate-800 rounded-lg p-1">
                {(['today', '7d', '30d', 'month'] as const).map((range) => (
                  <button
                    key={range}
                    onClick={() => setDateRange(range)}
                    className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                      dateRange === range
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {range === 'today' ? 'Hoje' : range === '7d' ? '7 dias' : range === '30d' ? '30 dias' : 'Mês'}
                  </button>
                ))}
              </div>

              {/* Sync Status */}
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <div className={`w-2 h-2 rounded-full ${syncStatus?.status === 'SUCCESS' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                <span>Última sync: {syncStatus?.lastSync ? new Date(syncStatus.lastSync).toLocaleString('pt-BR') : '—'}</span>
              </div>

              {/* Actions */}
              <button
                onClick={triggerSync}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-sm rounded-lg flex items-center gap-2 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Sincronizar
              </button>

              <button
                onClick={handleLogout}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-sm rounded-lg transition-colors"
              >
                Sair
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-1">
            {[
              { id: 'overview', label: 'Visão Geral' },
              { id: 'stores', label: 'Por Loja' },
              { id: 'vl', label: 'Consultores VL' },
              { id: 'media', label: 'Por Mídia' },
              { id: 'productivity', label: 'Produtividade' },
              { id: 'validation', label: 'Validação' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-slate-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Visão Geral */}
        {activeTab === 'overview' && (
          <div className="space-y-8">
            {/* KPIs principais */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <KpiCard
                title="Taxa de Conversão"
                value={formatPercent(overview?.conversionRate)}
                subtitle="Vendas / Leads"
                variant={overview?.conversionRate && overview.conversionRate > 3 ? 'success' : 'default'}
                icon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                }
              />
              <KpiCard
                title="Show Rate"
                value={formatPercent(overview?.showRate)}
                subtitle="Visitas / Agendamentos"
                variant={overview?.showRate && overview.showRate > 50 ? 'success' : 'warning'}
                icon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                }
              />
              <KpiCard
                title="Total de Leads"
                value={formatNumber(overview?.totalLeads || 0)}
                subtitle="No período"
                icon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                }
              />
              <KpiCard
                title="Total de Vendas"
                value={formatNumber(overview?.totalSales || 0)}
                subtitle="Conversões"
                variant="success"
                icon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
              />
              <KpiCard
                title="Agendamentos"
                value={formatNumber(overview?.totalAppointments || 0)}
                subtitle="Total"
                icon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                }
              />
              <KpiCard
                title="Fluxo de Loja"
                value={formatNumber(overview?.totalFlow || 0)}
                subtitle="Visitas"
                icon={
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                }
              />
            </div>

            {/* Gráfico de tendência */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
              <h3 className="text-lg font-semibold mb-4">Tendência de Conversão</h3>
              <div className="h-64 flex items-end gap-1">
                {trend.slice(-14).map((day, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-2">
                    <div
                      className="w-full bg-blue-600 rounded-t transition-all hover:bg-blue-500"
                      style={{ height: `${Math.max(day.conversionRate * 10, 2)}%` }}
                      title={`${day.conversionRate}%`}
                    ></div>
                    <span className="text-xs text-slate-500">
                      {new Date(day.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Resumo por praça */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Fortaleza */}
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-green-500"></span>
                  Fortaleza-CE
                </h3>
                <div className="space-y-4">
                  {stores.filter(s => s.plaza === 'FORTALEZA').map((store, idx) => (
                    <div key={`fortaleza-${store.storeId}-${idx}`} className="flex items-center justify-between">
                      <span className="text-slate-300">{store.storeName}</span>
                      <div className="flex items-center gap-4">
                        <span className="text-2xl font-bold">{formatNumber(store.leads)}</span>
                        <span className="text-green-400 font-medium">{formatPercent(store.conversionRate)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Salvador */}
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-blue-500"></span>
                  Salvador-BA
                </h3>
                <div className="space-y-4">
                  {stores.filter(s => s.plaza === 'SALVADOR').map((store, idx) => (
                    <div key={`salvador-${store.storeId}-${idx}`} className="flex items-center justify-between">
                      <span className="text-slate-300">{store.storeName}</span>
                      <div className="flex items-center gap-4">
                        <span className="text-2xl font-bold">{formatNumber(store.leads)}</span>
                        <span className="text-green-400 font-medium">{formatPercent(store.conversionRate)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Por Loja */}
        {activeTab === 'stores' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-800/50">
                  <tr>
                    <th className="text-left px-6 py-4 text-sm font-medium text-slate-400">Loja</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Praça</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Leads</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Agend.</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Fluxo</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Vendas</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Show Rate</th>
                    <th className="text-right px-6 py-4 text-sm font-medium text-slate-400">Conversão</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {stores.map((store, idx) => (
                    <tr key={`store-${store.storeId}-${idx}`} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-6 py-4 font-medium">{store.storeName}</td>
                      <td className="text-right px-4 py-4 text-slate-400">{store.plaza}</td>
                      <td className="text-right px-4 py-4 font-mono">{formatNumber(store.leads)}</td>
                      <td className="text-right px-4 py-4 font-mono">{formatNumber(store.appointments)}</td>
                      <td className="text-right px-4 py-4 font-mono">{formatNumber(store.flow)}</td>
                      <td className="text-right px-4 py-4 font-mono text-green-400 font-semibold">{formatNumber(store.sales)}</td>
                      <td className="text-right px-4 py-4 font-mono">{formatPercent(store.showRate)}</td>
                      <td className="text-right px-6 py-4 font-mono font-semibold text-blue-400">{formatPercent(store.conversionRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Consultores VL */}
        {activeTab === 'vl' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-800/50">
                  <tr>
                    <th className="text-left px-6 py-4 text-sm font-medium text-slate-400">Consultor VL</th>
                    <th className="text-left px-4 py-4 text-sm font-medium text-slate-400">Loja</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Leads</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">→ VS</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Agend.</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Vendas</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Taxa Agend.</th>
                    <th className="text-right px-6 py-4 text-sm font-medium text-slate-400">Conversão</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {vlMetrics.map((vl, idx) => (
                    <tr key={`vl-${vl.vlId}-${idx}`} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-6 py-4">
                        <div>
                          <span className="font-medium">{vl.vlName}</span>
                          <span className="block text-xs text-slate-500">@{vl.username}</span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-slate-400">{vl.storeName}</td>
                      <td className="text-right px-4 py-4 font-mono">{formatNumber(vl.leads)}</td>
                      <td className="text-right px-4 py-4 font-mono text-blue-400">{formatNumber(vl.leadsToVs)}</td>
                      <td className="text-right px-4 py-4 font-mono">{formatNumber(vl.appointments)}</td>
                      <td className="text-right px-4 py-4 font-mono text-green-400 font-semibold">{formatNumber(vl.sales)}</td>
                      <td className="text-right px-4 py-4 font-mono">{formatPercent(vl.appointmentRate)}</td>
                      <td className="text-right px-6 py-4 font-mono font-semibold text-blue-400">{formatPercent(vl.conversionRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Por Mídia */}
        {activeTab === 'media' && (
          <div className="space-y-6">
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-800/50">
                  <tr>
                    <th className="text-left px-6 py-4 text-sm font-medium text-slate-400">Mídia</th>
                    <th className="text-left px-4 py-4 text-sm font-medium text-slate-400">Categoria</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Leads</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Vendas</th>
                    <th className="text-right px-6 py-4 text-sm font-medium text-slate-400">Conversão</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {mediaMetrics.map((media, idx) => (
                    <tr key={`media-${media.mediaName}-${idx}`} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-6 py-4 font-medium">{media.mediaName}</td>
                      <td className="px-4 py-4">
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          media.category === 'PAID' ? 'bg-purple-500/20 text-purple-400' :
                          media.category === 'ORGANIC' ? 'bg-green-500/20 text-green-400' :
                          'bg-slate-500/20 text-slate-400'
                        }`}>
                          {media.category}
                        </span>
                      </td>
                      <td className="text-right px-4 py-4 font-mono">{formatNumber(media.leads)}</td>
                      <td className="text-right px-4 py-4 font-mono text-green-400">{formatNumber(media.sales)}</td>
                      <td className="text-right px-6 py-4">
                        <span className={`font-mono font-semibold ${
                          media.conversionRate && media.conversionRate > 5 ? 'text-green-400' :
                          media.conversionRate && media.conversionRate > 2 ? 'text-yellow-400' :
                          'text-slate-400'
                        }`}>
                          {formatPercent(media.conversionRate)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Produtividade */}
        {activeTab === 'productivity' && (
          <div className="space-y-6">
            {/* Cards de resumo */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
                <div className="text-sm text-slate-400 mb-1">Agendados Hoje</div>
                <div className="text-3xl font-bold text-white">
                  {productivity.reduce((sum, p) => sum + p.appointmentsToday, 0)}
                </div>
              </div>
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
                <div className="text-sm text-slate-400 mb-1">Confirmados</div>
                <div className="text-3xl font-bold text-green-400">
                  {productivity.reduce((sum, p) => sum + p.confirmedVisits, 0)}
                </div>
              </div>
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
                <div className="text-sm text-slate-400 mb-1">Vendas Hoje</div>
                <div className="text-3xl font-bold text-blue-400">
                  {productivity.reduce((sum, p) => sum + p.salesSuccess, 0)}
                </div>
              </div>
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
                <div className="text-sm text-slate-400 mb-1">Leads Atrasados</div>
                <div className="text-3xl font-bold text-red-400">
                  {productivity.reduce((sum, p) => sum + p.leadsLate, 0)}
                </div>
              </div>
            </div>

            {/* Tabela de VLs */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full">
                <thead className="bg-slate-800/50">
                  <tr>
                    <th className="text-left px-6 py-4 text-sm font-medium text-slate-400">Consultor VL</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Aguardando</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Atrasados</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Pendentes</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Futuros</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Prioritários</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Encaminhados</th>
                    <th className="text-right px-4 py-4 text-sm font-medium text-slate-400">Tempo Médio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {productivity.map((vl, idx) => (
                    <tr key={`prod-${vl.vlId}-${idx}`} className="hover:bg-slate-800/30 transition-colors">
                      <td className="px-6 py-4">
                        <div>
                          <span className="font-medium">{vl.vlName}</span>
                          <span className="block text-xs text-slate-500">{vl.storeName}</span>
                        </div>
                      </td>
                      <td className="text-right px-4 py-4 font-mono">{vl.leadsWaiting}</td>
                      <td className="text-right px-4 py-4 font-mono text-red-400">{vl.leadsLate}</td>
                      <td className="text-right px-4 py-4 font-mono text-yellow-400">{vl.leadsPendingToday}</td>
                      <td className="text-right px-4 py-4 font-mono text-blue-400">{vl.leadsFuture}</td>
                      <td className="text-right px-4 py-4 font-mono text-purple-400">{vl.priorityClients}</td>
                      <td className="text-right px-4 py-4 font-mono text-green-400">{vl.forwardedToVs}</td>
                      <td className="text-right px-6 py-4 font-mono">{formatTime(vl.averageContactMinutes ?? undefined)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Validação */}
        {activeTab === 'validation' && (
          <div className="mt-6">
            <ValidationPanel />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 mt-12">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <p className="text-center text-sm text-slate-500">
            CRM Leads Eurovia — Dashboard Analítico | Dados sincronizados do Syonet
          </p>
        </div>
      </footer>
    </div>
  );
}
