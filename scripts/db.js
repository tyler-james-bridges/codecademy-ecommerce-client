const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { databaseUrl } = require('../src/config');

async function main() {
  const pool = new Pool({ connectionString: databaseUrl(process.argv.includes('--test')) });
  try {
    await pool.query(await fs.readFile(path.join(__dirname, '../sql/schema.sql'), 'utf8'));
    const payments = path.join(__dirname, '../sql/payment-schema.sql');
    try { await pool.query(await fs.readFile(payments, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (process.argv.includes('--catalog')) {
      // Idempotent public demo catalog; no administrator or credentials are created.
      const products = [
        ['DESK-LAMP', 'Adjustable Desk Lamp', 'Fictional warm-light desk lamp.', 3499, 30],
        ['NOTEBOOK', 'Recycled Paper Notebook', 'Fictional dotted notebook.', 899, 100],
        ['MUG', 'Ceramic Office Mug', 'Fictional 350 ml ceramic mug.', 1499, 60],
        ['CABLE-TRAY', 'Under-desk Cable Tray', 'Fictional steel cable organizer.', 2499, 25],
        ['PLANTER', 'Small Indoor Planter', 'Fictional ceramic planter.', 1999, 40],
      ];
      for (const product of products) await pool.query(`INSERT INTO products (sku, name, description, price_cents, stock)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (sku) DO NOTHING`, product);
    }
    console.log('Ecommerce schema is ready.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Database setup failed; check the private connection configuration.'); process.exitCode = 1; });
