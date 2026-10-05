# Mankai Sync

A simple sync server for [Mankai](https://github.com/mankai-app/mankai),

## Setup with Docker Compose

1. Copy the example config:

   ```sh
   cp config.example.json config.json
   ```

2. Edit `config.json`: set a random JWT secret of at least 32 characters and choose your username and password. Keep the default host, port, and database path.

3. Build and start the server:

   ```sh
   docker compose up --build -d
   ```

The server runs at `http://localhost:3000`. Data is saved in the `data` Docker volume.
