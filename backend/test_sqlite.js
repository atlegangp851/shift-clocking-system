const sqlite3 = require('sqlite3').verbose();
const path = require('path');

console.log('Testing sqlite3 require...');
try {
    const dbPath = path.join(__dirname, 'test.db');
    const db = new sqlite3.Database(dbPath);

    db.serialize(() => {
        db.run("CREATE TABLE IF NOT EXISTS test (id INT)");
        db.run("INSERT INTO test VALUES (1)");
        db.each("SELECT id FROM test", (err, row) => {
            console.log('Row ID:', row.id);
        });
    });

    db.close((err) => {
        if (err) console.error('Close error:', err);
        else console.log('Database closed successfully');
    });
} catch (err) {
    console.error('SQLite3 generic error:', err);
}
