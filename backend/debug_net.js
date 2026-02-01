const net = require('net');
const url = require('url');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const dbUrl = process.env.DATABASE_URL;
const parsed = new url.URL(dbUrl);
const host = parsed.hostname;
const port = 5432;

console.log(`Connecting to ${host}:${port}...`);

const socket = net.createConnection(port, host, () => {
    console.log('Successfully connected to server!');
    socket.end();
});

socket.on('error', (err) => {
    console.error('Connection failed:', err);
});

socket.setTimeout(5000);
socket.on('timeout', () => {
    console.error('Connection timed out');
    socket.destroy();
});
