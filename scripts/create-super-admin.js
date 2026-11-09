#!/usr/bin/env node
/**
 * RESTOPRO — Super Admin Bootstrap CLI Script
 *
 * Securely provisions the initial platform owner / Super Admin account.
 * Usage:
 *   node scripts/create-super-admin.js --email "admin@restopro.com" --password "YourStrongPassword" --name "Platform Owner"
 * Or via environment variables:
 *   ADMIN_EMAIL="admin@restopro.com" ADMIN_PASSWORD="YourStrongPassword" ADMIN_NAME="Platform Owner" node scripts/create-super-admin.js
 */

const readline = require('readline');
const prisma = require('../src/config/database');
const { hashPassword } = require('../src/utils/password');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--email' && args[i + 1]) {
      parsed.email = args[++i];
    } else if (arg === '--password' && args[i + 1]) {
      parsed.password = args[++i];
    } else if (arg === '--name' && args[i + 1]) {
      parsed.name = args[++i];
    }
  }
  return parsed;
}

function askQuestion(query, hidden = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function main() {
  console.log('============================================================');
  console.log('       RESTOPRO — SUPER ADMIN BOOTSTRAP UTILITY             ');
  console.log('============================================================\n');

  const cliArgs = parseArgs();
  let email = cliArgs.email || process.env.ADMIN_EMAIL;
  let password = cliArgs.password || process.env.ADMIN_PASSWORD;
  let name = cliArgs.name || process.env.ADMIN_NAME;

  // If in interactive mode and arguments are missing, prompt user
  if (process.stdin.isTTY) {
    if (!name) {
      name = await askQuestion('Enter Admin Full Name: ');
    }
    if (!email) {
      email = await askQuestion('Enter Admin Email: ');
    }
    if (!password) {
      password = await askQuestion('Enter Admin Password (min 8 chars): ');
    }
  }

  // Validate inputs
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    console.error('❌ Error: Admin name is required.');
    process.exit(1);
  }

  if (!email || !isValidEmail(email)) {
    console.error('❌ Error: A valid email address is required.');
    process.exit(1);
  }

  if (!password || typeof password !== 'string' || password.length < 8) {
    console.error('❌ Error: Password must be at least 8 characters long.');
    process.exit(1);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const trimmedName = name.trim();

  try {
    // Check if admin user already exists
    const existing = await prisma.adminUser.findUnique({
      where: { email: normalizedEmail }
    });

    if (existing) {
      console.error(`\n❌ Administrator account "${normalizedEmail}" already exists.`);
      console.error('To securely recover or reset the password for an existing administrator without leaking');
      console.error('credentials in command history, please use the interactive recovery utility:');
      console.error('   node scripts/reset-admin-password.js\n');
      process.exit(1);
    }

    console.log(`Generating cryptographically secure password hash for ${normalizedEmail}...`);
    const passwordHash = await hashPassword(password);

    const admin = await prisma.$transaction(async (tx) => {
      const createdAdmin = await tx.adminUser.create({
        data: {
          name: trimmedName,
          email: normalizedEmail,
          password_hash: passwordHash,
          role: 'SUPER_ADMIN',
          is_active: true
        }
      });

      await tx.auditLog.create({
        data: {
          admin_user_id: createdAdmin.id,
          action: 'ADMIN_BOOTSTRAP_CREATED',
          entity_type: 'AdminUser',
          entity_id: createdAdmin.id,
          metadata: {
            createdVia: 'CLI_BOOTSTRAP',
            timestamp: new Date().toISOString()
          }
        }
      });

      return createdAdmin;
    });

    console.log('\n✅ [SUCCESS] Super Admin account created successfully!\n');
    console.log(`  ID:        ${admin.id}`);
    console.log(`  Name:      ${admin.name}`);
    console.log(`  Email:     ${admin.email}`);
    console.log(`  Role:      ${admin.role}`);
    console.log(`  Active:    ${admin.is_active}`);
    console.log(`  Created:   ${admin.created_at.toISOString()}\n`);
    console.log('Security Note: Plaintext credentials and password hashes are never displayed.\n');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error creating Super Admin:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = { isValidEmail, parseArgs };
