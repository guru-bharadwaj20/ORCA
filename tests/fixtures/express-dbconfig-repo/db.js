const { Pool } = require('pg');

module.exports = new Pool({
  host: process.env.PGHOST,
  port: 5432,
  database: 'app',
});
