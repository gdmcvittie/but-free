module.exports = {
  apps: [{
    name: 'butfree-downloader',
    script: 'torrent-node.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '1500M',
    watch: false,
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    time: true
  }]
};