/**
 * Production seed for CRM Eurovia.
 *
 * This script only writes to the CRM PostgreSQL database. It never connects
 * to Syonet and therefore cannot insert, update or delete Syonet data.
 *
 * Required environment:
 *   CRM_EVALUATOR_USERNAME
 *   CRM_EVALUATOR_PASSWORD
 */
import { PrismaClient, Plaza, MediaCategory } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const stores = [
  { shortName: 'Dunas', syonetName: 'VIASUL DUNAS - CE', plaza: Plaza.FORTALEZA, city: 'Fortaleza', state: 'CE', timezone: 'America/Fortaleza' },
  { shortName: 'Washington Soares', syonetName: 'BYD WASHINGTON SOARES - CE', plaza: Plaza.FORTALEZA, city: 'Fortaleza', state: 'CE', timezone: 'America/Fortaleza' },
  { shortName: 'Iguatemi', syonetName: 'EUROVIA IGUATEMI - BA', plaza: Plaza.SALVADOR, city: 'Salvador', state: 'BA', timezone: 'America/Bahia' },
  { shortName: 'Lauro', syonetName: 'EUROVIA LAURO - BA', plaza: Plaza.SALVADOR, city: 'Salvador', state: 'BA', timezone: 'America/Bahia' },
  { shortName: 'Bonocô', syonetName: 'VIA 1 BONOCO - BA', plaza: Plaza.SALVADOR, city: 'Salvador', state: 'BA', timezone: 'America/Bahia' },
  { shortName: 'Paralela', syonetName: 'NISSAN PARALELA - BA', plaza: Plaza.SALVADOR, city: 'Salvador', state: 'BA', timezone: 'America/Bahia' },
  { shortName: 'Caminho das Árvores', syonetName: 'BYD CAMINHO DAS ARVORES - BA', plaza: Plaza.SALVADOR, city: 'Salvador', state: 'BA', timezone: 'America/Bahia' },
];

const mediaSources = [
  ['CONVERX','CONVERX',MediaCategory.PAID],['DIRECT','DIRECT',MediaCategory.ORGANIC],
  ['FACEBOOKADS','FACEBOOK ADS',MediaCategory.PAID],['FB','FACEBOOK',MediaCategory.PAID],
  ['Facebook','FACEBOOK',MediaCategory.PAID],['GOOGLE','GOOGLE',MediaCategory.PAID],
  ['Google','GOOGLE',MediaCategory.PAID],['GOOGLESM','GOOGLE SM',MediaCategory.PAID],
  ['GOOGLESMDISCOVERY','GOOGLE SM DISCOVERY',MediaCategory.PAID],['IG','INSTAGRAM',MediaCategory.PAID],
  ['Instagram','INSTAGRAM',MediaCategory.PAID],['INSTAGRAM','INSTAGRAM',MediaCategory.PAID],
  ['INDICACAO LEADS','INDICACAO LEADS',MediaCategory.REFERRAL],['LEADFY','LEADFY',MediaCategory.PAID],
  ['Leadfy','LEADFY',MediaCategory.PAID],['LEADFY FACEBOOK','LEADFY FACEBOOK',MediaCategory.PAID],
  ['LWLCO','LWLCO',MediaCategory.PAID],['OLX','OLX',MediaCategory.PAID],
  ['ORGANICO','ORGANICO',MediaCategory.ORGANIC],['Organico','ORGANICO',MediaCategory.ORGANIC],
  ['OUTROS','OUTROS',MediaCategory.OTHER],['WEBMOTORS','WEBMOTORS',MediaCategory.PAID],
  ['WHATSAPP','WHATSAPP',MediaCategory.OTHER],['WHATSAPP BDC','WHATSAPP BDC',MediaCategory.OTHER],
  ['WHATSAPP FACEBOOK','WHATSAPP FACEBOOK',MediaCategory.PAID],['TOTAL','TOTAL',MediaCategory.OTHER],
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

async function main() {
  for (const store of stores) {
    await prisma.store.upsert({
      where: { syonetName: store.syonetName },
      update: store,
      create: store,
    });
  }

  for (const [rawName, normalizedName, category] of mediaSources) {
    await prisma.mediaSource.upsert({
      where: { rawName },
      update: { normalizedName, category },
      create: { rawName, normalizedName, category },
    });
  }

  const allowedStores = (await prisma.store.findMany({
    where: { active: true },
    select: { id: true },
  })).map(s => s.id);

  const username = required('CRM_EVALUATOR_USERNAME');
  const passwordHash = await bcrypt.hash(required('CRM_EVALUATOR_PASSWORD'), 12);

  await prisma.dashboardUser.upsert({
    where: { username },
    update: {
      name: 'Avaliador do Dashboard',
      passwordHash,
      role: 'VIEWER',
      active: true,
      allowedStores,
    },
    create: {
      username,
      name: 'Avaliador do Dashboard',
      passwordHash,
      role: 'VIEWER',
      active: true,
      allowedStores,
    },
  });

  console.log('Production CRM seed completed.');
  console.log('Stores:', allowedStores.length);
  console.log('Evaluator username:', username);
}

main()
  .catch(error => {
    console.error('Production seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
