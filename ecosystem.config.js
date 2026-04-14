module.exports = {
  apps: [
    {
      name: "whatsapp-ai-agent",
      script: "server.js",
      // Removed hardcoded cwd to make it portable across different VPS folders
      watch: false,
      max_memory_restart: "1G",
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      max_restarts: 10,
      kill_timeout: 15000,               // Allow enough time for Chromium to close
      restart_delay: 2000,
      listen_timeout: 15000,
      env: {
        NODE_ENV: "production",
        // The PORT will be read from .env but we can override it here if needed
      }
    }
  ]
};
