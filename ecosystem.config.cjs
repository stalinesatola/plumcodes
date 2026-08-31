// PM2: pm2 start ecosystem.config.cjs
// O app carrega o .env sozinho (src/index.ts -> process.loadEnvFile).
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "deriv-multibot",
      script: "src/index.ts",
      interpreter: "node", // Node >= 22.18 roda .ts direto
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      min_uptime: "30s",
      kill_timeout: 8000,
      time: true,
      env: {
        ENV_FILE: path.join(__dirname, ".env"),
      },
    },
  ],
};
