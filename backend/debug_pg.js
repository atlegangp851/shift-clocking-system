const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const dns = require('dns');

// Force IPv4
dns.setDefaultResultOrder('ipv4first');

const dbUrl = process.env.DATABASE_URL;
// Replicate db.js logic
const dbConfig = new URL(dbUrl);
dbConfig.searchParams.delete('sslmode');

const pool = new Pool({
    connectionString: dbConfig.toString(),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
});

console.log('Testing pg connection...');

(async () => {
    try {
        const client = await pool.connect();
        console.log('Successfully connected with pg!');
        const res = await client.query('SELECT NOW()');
        console.log('Query result:', res.rows[0]);
        client.release();
        await pool.end();
    } catch (err) {
        console.error('pg connection failed:', err);
    }
})();
