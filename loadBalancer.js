// ---------------------------
// Clustered Load Balancer with Graceful Shutdown and Health Check
// ---------------------------

const cluster = require("cluster");
const os = require("os");
const http = require("http");
const process = require("process");
const app = require("./app"); // Express app

const numCpus = os.cpus().length;
const PORT = process.env.PORT || 3001;
const WORKER_SHUTDOWN_TIMEOUT = 30_000; // 30 seconds
const log = (...args) => console.log(new Date().toISOString(), ...args);

if (cluster.isPrimary) {
  // ---------------------------
  // MASTER PROCESS
  // ---------------------------
  log(`[master ${process.pid}] Primary process starting`);
  log(`[master] Configured to use ${numCpus} workers`);

  if (cluster.SCHED_RR) {
    cluster.schedulingPolicy = cluster.SCHED_RR;
  }

  const workerStatus = {}; // Track readiness of workers

  // Spawn workers
  for (let i = 0; i < numCpus; i++) {
    const worker = cluster.fork();
    log(`[master] Worker ${worker.process.pid} started`);
  }

  // Listen for worker ready messages
  cluster.on("message", (worker, message) => {
    if (message.type === "ready") {
      workerStatus[worker.process.pid] = "ready";
      log(`[master] Worker ${worker.process.pid} is ready`);
    }
  });

  // Restart a crashed worker with delay
  cluster.on("exit", (worker, code, signal) => {
    log(
      `[master] Worker ${worker.process.pid} exited (code=${code}, signal=${signal}). Restarting in 2s...`
    );
    setTimeout(() => {
      const newWorker = cluster.fork();
      log(`[master] Worker ${newWorker.process.pid} started`);
    }, 2000);
  });

  // Health check server on separate port
  const HEALTH_PORT = 3000;
  const healthServer = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const totalWorkers = Object.keys(cluster.workers).length;
      const readyWorkers = Object.values(workerStatus).filter(
        (s) => s === "ready"
      ).length;
      const status = {
        totalWorkers,
        readyWorkers,
        allWorkersReady: totalWorkers === readyWorkers,
        workers: workerStatus,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status, null, 2));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  healthServer.listen(HEALTH_PORT, () => {
    log(`[master] Health check server listening on port ${HEALTH_PORT}`);
  });

  // Handle graceful shutdown
  const shutDown = () => {
    log("[master] Shutdown signal received. Disconnecting workers...");
    cluster.disconnect(() => {
      log("[master] All workers disconnected. Exiting.");
      process.exit(0);
    });

    setTimeout(() => {
      log("[master] Force shutdown (timeout reached).");
      process.exit(1);
    }, WORKER_SHUTDOWN_TIMEOUT + 5000).unref();
  };

  process.on("SIGTERM", shutDown);
  process.on("SIGINT", shutDown);

  process.on("uncaughtException", (error) => {
    log("[master] Uncaught Exception:", error);
    process.exit(1);
  });
} else {
  // ---------------------------
  // WORKER PROCESS
  // ---------------------------
  const server = http.createServer(app);
  const connections = new Set();

  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  server.listen(PORT, () => {
    log(`[worker ${process.pid}] Listening on port ${PORT}`);
    process.send && process.send({ type: "ready", pid: process.pid }); // Notify master
  });

  const gracefulShutdown = (signal) => {
    log(
      `[worker ${process.pid}] Received ${signal}. Closing server gracefully...`
    );

    server.close((error) => {
      if (error) {
        log(`[worker ${process.pid}] Error closing server:`, error);
        process.exit(1);
      }

      const forceCloseTimeout = setTimeout(() => {
        log(
          `[worker ${process.pid}] Forcing shutdown of remaining connections.`
        );
        connections.forEach((socket) => socket.destroy());
        process.exit(0);
      }, WORKER_SHUTDOWN_TIMEOUT);

      const interval = setInterval(() => {
        if (connections.size === 0) {
          clearInterval(interval);
          clearTimeout(forceCloseTimeout);
          process.exit(0);
        }
      }, 500);
    });
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  process.on("uncaughtException", (error) => {
    log(`[worker ${process.pid}] Uncaught Exception:`, error);
    gracefulShutdown("uncaughtException");
    setTimeout(() => process.exit(1), 5000).unref();
  });

  process.on("unhandledRejection", (reason) => {
    log(`[worker ${process.pid}] Unhandled Rejection:`, reason);
  });
}
