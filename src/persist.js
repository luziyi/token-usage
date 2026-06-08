const initSqlJs = require('sql.js');

let sqlWasm = null;
async function getSqlJs() {
  if (!sqlWasm) sqlWasm = await initSqlJs();
  return sqlWasm;
}

module.exports = { getSqlJs };
