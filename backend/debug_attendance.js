const { initDb } = require('./db');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

async function run() {
    await initDb();

    const dbPath = path.join(__dirname, 'database.sqlite');
    const filebuffer = fs.readFileSync(dbPath);
    const SQL = await initSqlJs();
    const db = new SQL.Database(filebuffer);

    console.log("--- Diagnostics ---");

    // Count Employees
    const empCount = db.exec("SELECT COUNT(*) FROM employees")[0].values[0][0];
    console.log(`Total Employees: ${empCount}`);

    // Count Shifts
    const shiftCount = db.exec("SELECT COUNT(*) FROM shift_entries")[0].values[0][0];
    console.log(`Total Shifts: ${shiftCount}`);

    // Count Orphaned Shifts
    const orphanedCount = db.exec(`
    SELECT COUNT(*) 
    FROM shift_entries s 
    LEFT JOIN employees e ON s.employee_id = e.employee_id 
    WHERE e.employee_id IS NULL
  `)[0].values[0][0];
    console.log(`Orphaned Shifts (no matching employee): ${orphanedCount}`);

    // List recent shifts
    console.log("\n--- Last 10 Shifts ---");
    const res = db.exec(`
    SELECT s.id, s.employee_id, s.clock_in, e.first_name 
    FROM shift_entries s 
    LEFT JOIN employees e ON s.employee_id = e.employee_id
    ORDER BY s.clock_in DESC 
    LIMIT 10
  `);

    if (res.length > 0) {
        const rows = res[0].values;
        rows.forEach(r => {
            console.log(`ID: ${r[0]}, EmpID: ${r[1]}, Time: ${r[2]}, Name: ${r[3] || 'NULL (Orphaned)'}`);
        });
    } else {
        console.log("No shifts found.");
    }
}

run();
