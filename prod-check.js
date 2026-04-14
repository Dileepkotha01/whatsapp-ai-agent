require('dotenv').config();

const REQUIRED_PROD_ENV = [
  'ANTHROPIC_API_KEY',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'ADMIN_WHATSAPP_NUMBER',
  'BACKEND_API_URL',
  'FRONTEND_URL',
  'BOT_UPLOAD_TOKEN',
  'SESSION_SECRET',
  'DEPLOYMENT_URL',
  'NODE_ENV'
];

console.log('🔍 Starting Production Readiness Check...\n');

let failed = false;
REQUIRED_PROD_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing: ${key}`);
    failed = true;
  } else {
    console.log(`✅ Found:   ${key}`);
  }
});

if (process.env.NODE_ENV !== 'production') {
  console.warn('\n⚠️  Warning: NODE_ENV is not set to "production".');
}

if (failed) {
  console.error('\n🛑 Production check FAILED. Please fix your .env file before deploying.');
  process.exit(1);
} else {
  console.log('\n🚀 All systems green! Codes are ready for Hostinger VPS deployment.');
  process.exit(0);
}
