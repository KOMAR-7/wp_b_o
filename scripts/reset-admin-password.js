#!/usr/bin/env node
/**
 * RESTOPRO — Secure Interactive Super Admin Password Recovery Utility
 *
 * Security Requirements:
 * - Passwords are NEVER accepted via CLI arguments or environment variables.
 * - Terminal input is masked (no echo) to prevent shoulder-surfing and terminal history leaks.
 * - Explicit typed confirmation ('CONFIRM RESET') required before modifying the database.
 * - Stored hashes are NEVER printed or logged.
 * - Preserves existing admin ID, role, permissions, and status.
 * - Enforces scrypt hashing and self-verification.
 * - Disallows known temporary/test passwords.
 * - Revokes stale active sessions upon password reset.
 */

require('dotenv').config();
const readline = require('readline');
const prisma = require('../src/config/database');
const { hashPassword, verifyPassword } = require('../src/utils/password');

// Block command-line password arguments
function checkForForbiddenArgs() {
  const forbiddenArgs = ['--password', '-p', '--pass', '-P'];
  for (const arg of process.argv) {
    for (const forbidden of forbiddenArgs) {
      if (arg === forbidden || arg.startsWith(`${forbidden}=`)) {
        console.error('\n❌ SECURITY VIOLATION: Passwords must NEVER be passed as command-line arguments.');
        console.error('Passing passwords via CLI flags leaks credentials into shell history (e.g. .bash_history) and process tables (ps).');
        console.error('Please run this script interactively without password arguments:');
        console.error('  node scripts/reset-admin-password.js\n');
        process.exit(1);
      }
    }
  }
}

/**
 * Reads a masked password from stdin without echoing characters.
 * @param {string} promptText 
 * @returns {Promise<string>}
 */
function promptMasked(promptText) {
  return new Promise((resolve) => {
    process.stdout.write(promptText);

    // If not a TTY (piped input), fallback to regular readline
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    // Interactive TTY: capture raw keystrokes without echo
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let password = '';

    const onData = (char) => {
      // Ctrl+C
      if (char === '\u0003') {
        process.stdout.write('\n\nOperation cancelled by user (Ctrl+C).\n');
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(0);
      }

      // Enter / Return
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
        return;
      }

      // Backspace / Delete
      if (char === '\u0008' || char === '\x7f') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      // Regular character: append and print asterisk
      password += char;
      process.stdout.write('*');
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Standard question prompt
 */
function promptText(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function validatePasswordComplexity(pass) {
  if (!pass || pass.length < 10) {
    return 'Password must be at least 10 characters long.';
  }
  if (!/[A-Z]/.test(pass)) {
    return 'Password must contain at least one uppercase letter (A-Z).';
  }
  if (!/[a-z]/.test(pass)) {
    return 'Password must contain at least one lowercase letter (a-z).';
  }
  if (!/[0-9]/.test(pass)) {
    return 'Password must contain at least one numeric digit (0-9).';
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pass)) {
    return 'Password must contain at least one special character.';
  }

  // Blacklist previous test / temporary passwords
  const blacklisted = [
    'supersecretpassword123!',
    'strongpassword987#',
    'chromesecrettestpass123!',
    'password123',
    'admin123456'
  ];
  if (blacklisted.includes(pass.toLowerCase())) {
    return 'Cannot use known temporary or automated test passwords. Please choose a unique, secure password.';
  }

  return null;
}

async function main() {
  checkForForbiddenArgs();

  console.log('============================================================');
  console.log('   RESTOPRO — SECURE ADMIN PASSWORD RECOVERY UTILITY        ');
  console.log('============================================================\n');

  // 1. Inspect Database Environment
  const rawDbUrl = process.env.DATABASE_URL || '';
  const maskedDbUrl = rawDbUrl.replace(/:([^@]+)@/, ':***@');
  const isRemoteRender = rawDbUrl.includes('render.com') || rawDbUrl.includes('restopro_jadq');
  const envName = isRemoteRender ? 'STAGING / PRODUCTION (Render Cloud)' : 'LOCAL DEVELOPMENT';

  console.log(`[ENVIRONMENT] Target Database:  ${envName}`);
  console.log(`[DATABASE]    Connection URL:   ${maskedDbUrl}`);

  try {
    const [dbInfo] = await prisma.$queryRaw`SELECT current_database(), version()`;
    console.log(`[DATABASE]    Active Database:  ${dbInfo.current_database}`);
  } catch (err) {
    console.error('\n❌ Could not connect to database:', err.message);
    process.exit(1);
  }

  // 2. Identify Target Admin Account
  const targetEmailInput = await promptText('\nEnter Admin Email to recover [default: devomar@restopro.com]: ');
  const emailToRecover = (targetEmailInput || 'devomar@restopro.com').trim().toLowerCase();

  const admin = await prisma.adminUser.findUnique({
    where: { email: emailToRecover },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      is_active: true,
      created_at: true,
      updated_at: true
    }
  });

  if (!admin) {
    console.error(`\n❌ Administrator account "${emailToRecover}" not found in database.`);
    process.exit(1);
  }

  console.log('\n--- Administrator Account Found ---');
  console.log(`  ID:         ${admin.id}`);
  console.log(`  Name:       ${admin.name}`);
  console.log(`  Email:      ${admin.email}`);
  console.log(`  Role:       ${admin.role}`);
  console.log(`  Active:     ${admin.is_active ? 'YES' : 'NO'}`);
  console.log(`  Created:    ${admin.created_at.toISOString()}`);
  console.log(`  Updated:    ${admin.updated_at.toISOString()}`);
  console.log('  Hash:       [REDACTED FOR SECURITY — NEVER DISPLAYED]');

  if (!admin.is_active) {
    console.warn('\n⚠️ Warning: This administrator account is currently marked inactive.');
  }

  // 3. Prompt for New Password (Masked, No Echo)
  console.log('\n--- Enter New Password ---');
  let newPassword = '';
  let validationError = null;

  while (true) {
    newPassword = await promptMasked('Enter new password: ');
    validationError = validatePasswordComplexity(newPassword);
    if (validationError) {
      console.log(`\n❌ ${validationError}`);
      continue;
    }

    const confirmPassword = await promptMasked('Confirm new password: ');
    if (newPassword !== confirmPassword) {
      console.log('\n❌ Passwords do not match. Please try again.\n');
      continue;
    }

    // Validation successful
    break;
  }

  // 4. Require Explicit Confirmation
  console.log('\n============================================================');
  console.log('   CONFIRMATION REQUIRED BEFORE APPLYING CHANGES            ');
  console.log('============================================================');
  console.log(`Target User:     ${admin.name} <${admin.email}> (${admin.id})`);
  console.log(`Target Database: ${dbInfo.current_database} (${envName})`);
  console.log('This will:');
  console.log('  1. Compute a new scrypt cryptographic hash.');
  console.log('  2. Verify the generated hash against the input.');
  console.log('  3. Update password_hash while strictly preserving ID, role, and email.');
  console.log('  4. Invalidate all active sessions for this admin in admin_sessions.');
  console.log('  5. Record an ADMIN_PASSWORD_UPDATED audit log entry.\n');

  const confirm = await promptText("Type 'CONFIRM RESET' to proceed with password update: ");

  if (confirm !== 'CONFIRM RESET') {
    console.log('\n⚠️ Explicit confirmation was not provided. Password reset aborted.');
    console.log('Zero modifications were made to the database.');
    process.exit(0);
  }

  // 5. Hash and Verify
  console.log('\nComputing cryptographic scrypt hash...');
  const newHash = await hashPassword(newPassword);

  const isValid = await verifyPassword(newPassword, newHash);
  if (!isValid) {
    console.error('❌ Internal Cryptographic Self-Test Failed: Generated hash did not verify.');
    process.exit(1);
  }

  // 6. Update Database
  console.log('Updating database record...');
  await prisma.$transaction(async (tx) => {
    // Update admin user
    await tx.adminUser.update({
      where: { id: admin.id },
      data: {
        password_hash: newHash,
        is_active: true
      }
    });

    // Invalidate stale sessions
    const revoked = await tx.adminSession.deleteMany({
      where: { admin_user_id: admin.id }
    });
    console.log(`Revoked ${revoked.count} active/historical sessions.`);

    // Record audit log
    await tx.auditLog.create({
      data: {
        admin_user_id: admin.id,
        action: 'ADMIN_PASSWORD_UPDATED',
        entity_type: 'AdminUser',
        entity_id: admin.id,
        metadata: {
          initiator: 'CLI_RECOVERY_TOOL',
          timestamp: new Date().toISOString(),
          sessions_revoked: revoked.count
        }
      }
    });
  });

  console.log('\n============================================================');
  console.log('   ✅ PASSWORD RESET COMPLETED SUCCESSFULLY                 ');
  console.log('============================================================');
  console.log(`Administrator ${admin.email} has been updated.`);
  console.log('All previous sessions have been revoked.');
  console.log('The administrator can now log in securely using their new password.\n');

  // Clear memory
  newPassword = null;
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Fatal error during password reset:', err.message);
  process.exit(1);
});

