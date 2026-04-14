const axios = require('axios');
require('dotenv').config();

const PORT = process.env.PORT || 47821;
const VPS_IP = '69.62.79.251'; // Your VPS IP
const DEPLOYMENT_URL = process.env.DEPLOYMENT_URL || `http://localhost:${PORT}`;

// We use localhost for internal VPS checks (best for speed and zero-firewall issues)
// but allow public URL for external checks.
const targetUrl = DEPLOYMENT_URL.includes('localhost') 
  ? `http://localhost:${PORT}/health` 
  : `${DEPLOYMENT_URL.replace(/\/$/, '')}/health`;

async function checkHealth() {
  console.log(`🔍 Checking bot health at: ${targetUrl}`);
  try {
    const res = await axios.get(targetUrl, { timeout: 8000 });
    if (res.status === 200) {
      console.log('✅ Bot is ONLINE and healthy.');
      console.log('Details:', res.data);
    } else {
      console.log(`⚠️  Bot returned status ${res.status}.`);
    }
  } catch (err) {
    console.log('❌ Bot is OFFLINE or unreachable.');
    console.log('Error:', err.message);
    
    if (targetUrl.includes('localhost')) {
      console.log(`\n💡 Tip: If you are running this from your LAPTOP, change the URL to http://${VPS_IP}:${PORT}/health`);
    }
  }
}

checkHealth();
