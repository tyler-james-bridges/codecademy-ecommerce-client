const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { databaseUrl } = require('../src/config');

async function main() {
  const username = process.env.SEED_ADMIN_USERNAME;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!/^[a-z0-9_-]{3,32}$/.test(username || '') ||
      !password || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Set valid private seed administrator credentials.');
  }
  const hash = await bcrypt.hash(password, 10);
  const pool = new Pool({ connectionString: databaseUrl() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO users (username, password_hash, display_name, role)
      VALUES ($1, $2, 'Local Administrator', 'admin')
      ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
      credential_version = users.credential_version + 1,
      role = 'admin', deleted_at = NULL`, [username, hash]);
    const products = [
      ['DESK-LAMP', 'Adjustable Desk Lamp', 'Fictional warm-light desk lamp.', 3499, 30],
      ['NOTEBOOK', 'Recycled Paper Notebook', 'Fictional dotted notebook.', 899, 100],
      ['MUG', 'Ceramic Office Mug', 'Fictional 350 ml ceramic mug.', 1499, 60],
      ['CABLE-TRAY', 'Under-desk Cable Tray', 'Fictional steel cable organizer.', 2499, 25],
      ['PLANTER', 'Small Indoor Planter', 'Fictional ceramic planter.', 1999, 40],
    ];
    for (const product of products) {
      await client.query(`INSERT INTO products (sku, name, description, price_cents, stock)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sku) DO NOTHING`, product);
    }
    await client.query('COMMIT');
    console.log('Fictional catalog and private local administrator are ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(() => { console.error('Seeding failed; check configuration and run db:setup first.'); process.exitCode = 1; });
