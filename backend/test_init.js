const { initDb, db } = require('./db');

console.log('Testing initDb...');
initDb()
    .then(() => {
        console.log('initDb success!');
        db.close();
    })
    .catch((err) => {
        console.error('initDb failed:', err);
        process.exit(1);
    });
