/**
 * RESTOPRO — Database Seed Script
 * Provisions development-only test restaurants (Restaurant A and Restaurant B).
 * Never use real production credentials or customer data.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TEST_RESTAURANT_A = {
  id: 'a0000000-0000-0000-0000-000000000001',
  name: 'Spice Garden Restaurant (Test Tenant A)',
  phone_number_id: '111111111111111',
  waba_id: 'WABA_SPICE_GARDEN_TEST_01',
  owner_phone: '+919876543210',
  access_token_encrypted: 'mock_encrypted_token_tenant_a',
  is_active: true
};

const TEST_RESTAURANT_B = {
  id: 'b0000000-0000-0000-0000-000000000002',
  name: 'Ocean Breeze Cafe (Test Tenant B)',
  phone_number_id: '222222222222222',
  waba_id: 'WABA_OCEAN_BREEZE_TEST_02',
  owner_phone: '+919811122233',
  access_token_encrypted: 'mock_encrypted_token_tenant_b',
  is_active: true
};

async function main() {
  console.log('Seeding development test restaurants...');

  const restaurantA = await prisma.restaurant.upsert({
    where: { phone_number_id: TEST_RESTAURANT_A.phone_number_id },
    update: {
      name: TEST_RESTAURANT_A.name,
      owner_phone: TEST_RESTAURANT_A.owner_phone,
      is_active: true
    },
    create: TEST_RESTAURANT_A
  });
  console.log(`  ✅ Seeded Tenant A: ${restaurantA.name} [ID: ${restaurantA.id}, PhoneID: ${restaurantA.phone_number_id}]`);

  const restaurantB = await prisma.restaurant.upsert({
    where: { phone_number_id: TEST_RESTAURANT_B.phone_number_id },
    update: {
      name: TEST_RESTAURANT_B.name,
      owner_phone: TEST_RESTAURANT_B.owner_phone,
      is_active: true
    },
    create: TEST_RESTAURANT_B
  });
  console.log(`  ✅ Seeded Tenant B: ${restaurantB.name} [ID: ${restaurantB.id}, PhoneID: ${restaurantB.phone_number_id}]`);

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

