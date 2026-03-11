require("dotenv").config({ quiet: true });

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { z } = require("zod");
const { randomUUID, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@base44/sdk");

const STATUT_INTERVENANT = [
  "disponible",
  "en_intervention",
  "indisponible",
  "conge",
];

const STATUT_INTERVENTION = [
  "planifiee",
  "en_cours",
  "terminee",
  "annulee",
];

const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "rh-planning.json");
const base44AppId = process.env.BASE44_APP_ID || "";
const base44Token = process.env.BASE44_TOKEN || "";
const base44ServerUrl = process.env.BASE44_SERVER_URL || "https://base44.app";
const base44IntervenantEntity =
  process.env.BASE44_INTERVENANT_ENTITY || "Intervenant";
const base44InterventionEntity =
  process.env.BASE44_INTERVENTION_ENTITY || "Intervention";
const base44PointageEntity = process.env.BASE44_POINTAGE_ENTITY || "Pointage";
const forcedDataSource = (process.env.DATA_SOURCE || "").toLowerCase();
const mcpSharedSecret = process.env.MCP_SHARED_SECRET || "";
const runtimeEnv = (process.env.NODE_ENV || "").toLowerCase();
const rawDisableMcpAuth =
  process.env.DISABLE_MCP_AUTH ?? process.env.DISABLE_MCP_AUTH_IN_DEV;
const disableMcpAuth =
  rawDisableMcpAuth != null
    ? String(rawDisableMcpAuth).toLowerCase() !== "false"
    : runtimeEnv !== "production";

const defaultStore = {
  intervenants: [
    {
      id: "int_001",
      prenom: "Sofia",
      nom: "Martin",
      email: "sofia.martin@example.com",
      telephone: "0600000001",
      statut: "disponible",
      specialites: ["chauffage", "maintenance"],
      couleur: "#3b82f6",
    },
    {
      id: "int_002",
      prenom: "Liam",
      nom: "Bernard",
      email: "liam.bernard@example.com",
      telephone: "0600000002",
      statut: "en_intervention",
      specialites: ["electricite"],
      couleur: "#10b981",
    },
    {
      id: "int_003",
      prenom: "Nora",
      nom: "Petit",
      email: "nora.petit@example.com",
      telephone: "0600000003",
      statut: "conge",
      specialites: ["plomberie"],
      couleur: "#f59e0b",
    },
  ],
  interventions: [
    {
      id: "iv_001",
      client_nom: "Boulangerie du Centre",
      date_intervention: "2026-03-10T08:00:00.000Z",
      duree_minutes: 120,
      statut: "planifiee",
      intervenant_id: "int_001",
      adresse: "10 Rue de la Republique, Paris",
      notes: "Controle annuel.",
      created_at: "2026-03-09T10:00:00.000Z",
    },
    {
      id: "iv_002",
      client_nom: "Residence Horizon",
      date_intervention: "2026-03-10T09:30:00.000Z",
      duree_minutes: 90,
      statut: "en_cours",
      intervenant_id: "int_002",
      adresse: "22 Avenue Victor Hugo, Lyon",
      notes: "Panne tableau electrique.",
      created_at: "2026-03-09T10:15:00.000Z",
    },
  ],
  pointages: [],
};

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(defaultStore, null, 2), "utf8");
  }
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(dataFile, "utf8");
  const parsed = JSON.parse(raw);
  return {
    intervenants: Array.isArray(parsed.intervenants) ? parsed.intervenants : [],
    interventions: Array.isArray(parsed.interventions) ? parsed.interventions : [],
    pointages: Array.isArray(parsed.pointages) ? parsed.pointages : [],
  };
}

function writeStore(store) {
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), "utf8");
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function buildWindow(dateIntervention, dureeMinutes) {
  const start = new Date(dateIntervention).getTime();
  const end = start + Number(dureeMinutes || 60) * 60 * 1000;
  return { start, end };
}

function hasOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

let base44Client;
const sseTransports = {};

function getDataSource() {
  if (forcedDataSource === "local") return "local";
  if (forcedDataSource === "base44") return "base44";
  return base44AppId ? "base44" : "local";
}

function getBase44Client() {
  if (!base44AppId) {
    throw new Error(
      "BASE44_APP_ID manquant. Configure BASE44_APP_ID pour activer le mode Base44.",
    );
  }

  if (!base44Client) {
    const clientConfig = {
      appId: base44AppId,
      serverUrl: base44ServerUrl,
    };

    if (base44Token) {
      clientConfig.token = base44Token;
    }

    base44Client = createClient(clientConfig);
  }

  return base44Client;
}

function getEntity(client, entityName) {
  const handler = client.entities?.[entityName];
  if (!handler) {
    throw new Error(
      `Entite Base44 introuvable: ${entityName}. Verifie BASE44_INTERVENANT_ENTITY / BASE44_INTERVENTION_ENTITY / BASE44_POINTAGE_ENTITY.`,
    );
  }
  return handler;
}

async function listIntervenantsData({ statut, search, limit }) {
  if (getDataSource() === "local") {
    const store = readStore();
    const term = normalizeText(search);

    return store.intervenants
      .filter((item) => !statut || item.statut === statut)
      .filter((item) => {
        if (!term) return true;
        const haystack = [
          item.prenom,
          item.nom,
          item.email,
          item.telephone,
          ...(Array.isArray(item.specialites) ? item.specialites : []),
        ]
          .map(normalizeText)
          .join(" ");
        return haystack.includes(term);
      })
      .slice(0, limit);
  }

  const client = getBase44Client();
  const entity = getEntity(client, base44IntervenantEntity);
  const cappedLimit = Math.min(Math.max(limit, 1), 5000);
  const initial = statut
    ? await entity.filter({ statut }, "-created_date", cappedLimit)
    : await entity.list("-created_date", cappedLimit);
  const term = normalizeText(search);

  return initial
    .filter((item) => {
      if (!term) return true;
      const haystack = [
        item.prenom,
        item.nom,
        item.email,
        item.telephone,
        ...(Array.isArray(item.specialites) ? item.specialites : []),
      ]
        .map(normalizeText)
        .join(" ");
      return haystack.includes(term);
    })
    .slice(0, limit);
}

async function listInterventionsData({
  date_from,
  date_to,
  intervenant_id,
  statut,
  limit,
}) {
  const fromTs = date_from ? new Date(date_from).getTime() : null;
  const toTs = date_to ? new Date(date_to).getTime() : null;

  if (date_from && Number.isNaN(fromTs)) {
    throw new Error("date_from invalide. Utilise un format ISO date.");
  }
  if (date_to && Number.isNaN(toTs)) {
    throw new Error("date_to invalide. Utilise un format ISO date.");
  }

  let interventions;
  if (getDataSource() === "local") {
    const store = readStore();
    interventions = store.interventions;
  } else {
    const client = getBase44Client();
    const entity = getEntity(client, base44InterventionEntity);
    const query = {};
    if (intervenant_id) query.intervenant_id = intervenant_id;
    if (statut) query.statut = statut;
    const cappedLimit = Math.min(Math.max(limit, 1), 5000);
    interventions =
      Object.keys(query).length > 0
        ? await entity.filter(query, "date_intervention", cappedLimit)
        : await entity.list("date_intervention", cappedLimit);
  }

  return interventions
    .filter((item) => !intervenant_id || item.intervenant_id === intervenant_id)
    .filter((item) => !statut || item.statut === statut)
    .filter((item) => {
      const ts = new Date(item.date_intervention).getTime();
      if (Number.isNaN(ts)) return false;
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
      return true;
    })
    .sort(
      (a, b) =>
        new Date(a.date_intervention).getTime() -
        new Date(b.date_intervention).getTime(),
    )
    .slice(0, limit);
}

async function createInterventionData({
  client_nom,
  date_intervention,
  intervenant_id,
  duree_minutes,
  adresse,
  notes,
  statut,
}) {
  const startTs = new Date(date_intervention).getTime();
  if (Number.isNaN(startTs)) {
    throw new Error("date_intervention invalide. Utilise un format ISO date.");
  }

  if (getDataSource() === "local") {
    const store = readStore();
    const intervenant = store.intervenants.find((it) => it.id === intervenant_id);
    if (!intervenant) {
      throw new Error(`Intervenant introuvable: ${intervenant_id}`);
    }

    if (["indisponible", "conge"].includes(intervenant.statut)) {
      throw new Error(
        `Intervenant ${intervenant.prenom} ${intervenant.nom} non disponible (${intervenant.statut}).`,
      );
    }

    const incomingWindow = buildWindow(date_intervention, duree_minutes);
    const conflict = store.interventions.find((item) => {
      if (item.intervenant_id !== intervenant_id) return false;
      if (item.statut === "annulee") return false;
      return hasOverlap(
        incomingWindow,
        buildWindow(item.date_intervention, item.duree_minutes),
      );
    });

    if (conflict) {
      throw new Error(
        `Conflit planning avec intervention ${conflict.id} (${conflict.date_intervention}).`,
      );
    }

    const intervention = {
      id: `iv_${randomUUID().slice(0, 8)}`,
      client_nom,
      date_intervention: new Date(startTs).toISOString(),
      duree_minutes,
      statut,
      intervenant_id,
      adresse: adresse || "",
      notes: notes || "",
      created_at: new Date().toISOString(),
    };

    store.interventions.push(intervention);
    writeStore(store);
    return { intervention, intervenant };
  }

  const client = getBase44Client();
  const intervenantEntity = getEntity(client, base44IntervenantEntity);
  const interventionEntity = getEntity(client, base44InterventionEntity);

  const intervenant = await intervenantEntity.get(intervenant_id);
  if (!intervenant) {
    throw new Error(`Intervenant introuvable: ${intervenant_id}`);
  }

  if (["indisponible", "conge"].includes(intervenant.statut)) {
    throw new Error(
      `Intervenant ${intervenant.prenom} ${intervenant.nom} non disponible (${intervenant.statut}).`,
    );
  }

  const existing = await interventionEntity.filter(
    { intervenant_id },
    "date_intervention",
    5000,
  );
  const incomingWindow = buildWindow(date_intervention, duree_minutes);
  const conflict = existing.find((item) => {
    if (item.statut === "annulee") return false;
    return hasOverlap(
      incomingWindow,
      buildWindow(item.date_intervention, item.duree_minutes),
    );
  });

  if (conflict) {
    throw new Error(
      `Conflit planning avec intervention ${conflict.id} (${conflict.date_intervention}).`,
    );
  }

  const intervention = await interventionEntity.create({
    client_nom,
    date_intervention: new Date(startTs).toISOString(),
    duree_minutes,
    statut,
    intervenant_id,
    adresse: adresse || "",
    notes: notes || "",
  });

  return { intervention, intervenant };
}

async function listPointagesData({
  date_from,
  date_to,
  intervenant_id,
  intervention_id,
  limit,
}) {
  const fromTs = date_from ? new Date(date_from).getTime() : null;
  const toTs = date_to ? new Date(date_to).getTime() : null;

  if (date_from && Number.isNaN(fromTs)) {
    throw new Error("date_from invalide. Utilise un format ISO date.");
  }
  if (date_to && Number.isNaN(toTs)) {
    throw new Error("date_to invalide. Utilise un format ISO date.");
  }

  let pointages;
  if (getDataSource() === "local") {
    const store = readStore();
    pointages = store.pointages;
  } else {
    const client = getBase44Client();
    const entity = getEntity(client, base44PointageEntity);
    const query = {};
    if (intervenant_id) query.intervenant_id = intervenant_id;
    if (intervention_id) query.intervention_id = intervention_id;
    const cappedLimit = Math.min(Math.max(limit, 1), 5000);
    pointages =
      Object.keys(query).length > 0
        ? await entity.filter(query, "date_pointage", cappedLimit)
        : await entity.list("date_pointage", cappedLimit);
  }

  return pointages
    .filter((item) => !intervenant_id || item.intervenant_id === intervenant_id)
    .filter((item) => !intervention_id || item.intervention_id === intervention_id)
    .filter((item) => {
      const ts = new Date(item.date_pointage).getTime();
      if (Number.isNaN(ts)) return false;
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
      return true;
    })
    .sort((a, b) => new Date(a.date_pointage).getTime() - new Date(b.date_pointage).getTime())
    .slice(0, limit);
}

async function createPointageData({
  intervenant_id,
  intervention_id,
  date_pointage,
  action,
  notes,
}) {
  const datePointage = date_pointage || new Date().toISOString();
  const pointageTs = new Date(datePointage).getTime();
  if (Number.isNaN(pointageTs)) {
    throw new Error("date_pointage invalide. Utilise un format ISO date.");
  }

  if (getDataSource() === "local") {
    const store = readStore();
    const intervenant = store.intervenants.find((it) => it.id === intervenant_id);
    if (!intervenant) {
      throw new Error(`Intervenant introuvable: ${intervenant_id}`);
    }

    if (
      intervention_id &&
      !store.interventions.find((it) => it.id === intervention_id)
    ) {
      throw new Error(`Intervention introuvable: ${intervention_id}`);
    }

    const pointage = {
      id: `pt_${randomUUID().slice(0, 8)}`,
      intervenant_id,
      intervention_id: intervention_id || "",
      date_pointage: new Date(pointageTs).toISOString(),
      action: action || "",
      notes: notes || "",
      created_at: new Date().toISOString(),
    };
    store.pointages.push(pointage);
    writeStore(store);
    return pointage;
  }

  const client = getBase44Client();
  const intervenantEntity = getEntity(client, base44IntervenantEntity);
  const pointageEntity = getEntity(client, base44PointageEntity);

  const intervenant = await intervenantEntity.get(intervenant_id);
  if (!intervenant) {
    throw new Error(`Intervenant introuvable: ${intervenant_id}`);
  }

  return pointageEntity.create({
    intervenant_id,
    intervention_id: intervention_id || "",
    date_pointage: new Date(pointageTs).toISOString(),
    action: action || "",
    notes: notes || "",
  });
}

function createServer() {
  const server = new McpServer(
    {
      name: "local-base44-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "ping",
    {
      description: "Use this when you need to validate MCP connectivity quickly.",
      inputSchema: {
        message: z.string().optional(),
      },
    },
    async ({ message }) => {
      return {
        content: [
          {
            type: "text",
            text: `pong${message ? `: ${message}` : ""}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "addition",
    {
      description: "Use this when you need a simple test tool with numeric input.",
      inputSchema: {
        a: z.number(),
        b: z.number(),
      },
    },
    async ({ a, b }) => {
      const result = a + b;
      return {
        content: [
          {
            type: "text",
            text: `${a} + ${b} = ${result}`,
          },
        ],
        structuredContent: {
          a,
          b,
          result,
        },
      };
    },
  );

  server.registerTool(
    "planning_data_source_status",
    {
      description:
        "Use this when you need to check whether tools are using local data or real Base44 entities.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const source = getDataSource();
      const configured = {
        data_source: source,
        forced_data_source: forcedDataSource || null,
        base44_app_id_configured: Boolean(base44AppId),
        base44_token_configured: Boolean(base44Token),
        base44_server_url: base44ServerUrl,
        base44_intervenant_entity: base44IntervenantEntity,
        base44_intervention_entity: base44InterventionEntity,
        base44_pointage_entity: base44PointageEntity,
      };

      return {
        content: [
          {
            type: "text",
            text: `Data source active: ${source}.`,
          },
        ],
        structuredContent: configured,
      };
    },
  );

  server.registerTool(
    "rh_list_intervenants",
    {
      description: "Use this when you need to list RH team members and their status.",
      inputSchema: {
        statut: z.enum(STATUT_INTERVENANT).optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ statut, search, limit }) => {
      const result = await listIntervenantsData({ statut, search, limit });

      return {
        content: [
          {
            type: "text",
            text: `${result.length} intervenant(s) trouve(s) [source: ${getDataSource()}].`,
          },
        ],
        structuredContent: {
          source: getDataSource(),
          count: result.length,
          intervenants: result,
        },
      };
    },
  );

  server.registerTool(
    "planning_list_interventions",
    {
      description:
        "Use this when you need to read planning interventions with filters by date, status, or assignee.",
      inputSchema: {
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        intervenant_id: z.string().optional(),
        statut: z.enum(STATUT_INTERVENTION).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ date_from, date_to, intervenant_id, statut, limit }) => {
      const interventions = await listInterventionsData({
        date_from,
        date_to,
        intervenant_id,
        statut,
        limit,
      });

      return {
        content: [
          {
            type: "text",
            text: `${interventions.length} intervention(s) trouvee(s) [source: ${getDataSource()}].`,
          },
        ],
        structuredContent: {
          source: getDataSource(),
          count: interventions.length,
          interventions,
        },
      };
    },
  );

  server.registerTool(
    "planning_create_intervention",
    {
      description:
        "Use this when you need to create a new planning intervention for an intervenant.",
      inputSchema: {
        client_nom: z.string().min(2),
        date_intervention: z.string(),
        intervenant_id: z.string(),
        duree_minutes: z.number().int().min(15).max(720).default(60),
        adresse: z.string().optional(),
        notes: z.string().optional(),
        statut: z.enum(STATUT_INTERVENTION).default("planifiee"),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      client_nom,
      date_intervention,
      intervenant_id,
      duree_minutes,
      adresse,
      notes,
      statut,
    }) => {
      const { intervention, intervenant } = await createInterventionData({
        client_nom,
        date_intervention,
        intervenant_id,
        duree_minutes,
        adresse,
        notes,
        statut,
      });

      return {
        content: [
          {
            type: "text",
            text: `Intervention ${intervention.id} creee pour ${intervenant.prenom} ${intervenant.nom} [source: ${getDataSource()}].`,
          },
        ],
        structuredContent: {
          source: getDataSource(),
          created: true,
          intervention,
        },
      };
    },
  );

  server.registerTool(
    "pointage_list",
    {
      description:
        "Use this when you need to read pointage entries with optional date, intervention, or intervenant filters.",
      inputSchema: {
        date_from: z.string().optional(),
        date_to: z.string().optional(),
        intervenant_id: z.string().optional(),
        intervention_id: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ date_from, date_to, intervenant_id, intervention_id, limit }) => {
      const pointages = await listPointagesData({
        date_from,
        date_to,
        intervenant_id,
        intervention_id,
        limit,
      });

      return {
        content: [
          {
            type: "text",
            text: `${pointages.length} pointage(s) trouve(s) [source: ${getDataSource()}].`,
          },
        ],
        structuredContent: {
          source: getDataSource(),
          count: pointages.length,
          pointages,
        },
      };
    },
  );

  server.registerTool(
    "pointage_create",
    {
      description:
        "Use this when you need to create a pointage event linked to an intervenant and optionally an intervention.",
      inputSchema: {
        intervenant_id: z.string(),
        intervention_id: z.string().optional(),
        date_pointage: z.string().optional(),
        action: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ intervenant_id, intervention_id, date_pointage, action, notes }) => {
      const pointage = await createPointageData({
        intervenant_id,
        intervention_id,
        date_pointage,
        action,
        notes,
      });

      return {
        content: [
          {
            type: "text",
            text: `Pointage ${pointage.id} cree [source: ${getDataSource()}].`,
          },
        ],
        structuredContent: {
          source: getDataSource(),
          created: true,
          pointage,
        },
      };
    },
  );

  return server;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "mcp-session-id, mcp-protocol-version",
  );
}

function matchesSecret(value) {
  if (!mcpSharedSecret) return true;
  if (!value) return false;

  const provided = Buffer.from(String(value));
  const expected = Buffer.from(mcpSharedSecret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function isAuthorized(req) {
  if (disableMcpAuth) return true;
  if (!mcpSharedSecret) return true;

  const direct =
    req.header("x-mcp-secret") ||
    req.header("x-api-key") ||
    req.header("authorization");

  if (direct && !direct.toLowerCase().startsWith("bearer ")) {
    return matchesSecret(direct);
  }

  const bearer = req.header("authorization");
  if (bearer && bearer.toLowerCase().startsWith("bearer ")) {
    return matchesSecret(bearer.slice("bearer ".length));
  }

  return false;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });
ensureStore();

app.use((req, res, next) => {
  setCors(res);
  next();
});

app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "mcp-server" });
});

app.use(["/mcp", "/sse", "/messages"], (req, res, next) => {
  if (req.method === "OPTIONS") return next();

  if (!isAuthorized(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }

  return next();
});

app.options("/mcp", (_req, res) => {
  res.status(204).end();
});

app.options("/sse", (_req, res) => {
  res.status(204).end();
});

app.options("/messages", (_req, res) => {
  res.status(204).end();
});

app.post("/mcp", async (req, res) => {
  try {
    // Stateless mode is more compatible with clients that don't establish
    // a separate SSE stream after initialize.
    const server = createServer();
    const statelessTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(statelessTransport);
    await statelessTransport.handleRequest(req, res, req.body);

    res.on("close", async () => {
      await statelessTransport.close();
      await server.close();
    });
  } catch (error) {
    console.error("MCP request error:", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "MCP endpoint reachable. Use POST /mcp for JSON-RPC requests.",
  });
});

// Legacy MCP HTTP+SSE transport compatibility for clients expecting text/event-stream.
app.get("/sse", async (_req, res) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    sseTransports[transport.sessionId] = transport;

    res.on("close", () => {
      delete sseTransports[transport.sessionId];
    });

    const server = createServer();
    await server.connect(transport);

    transport.onclose = async () => {
      delete sseTransports[transport.sessionId];
      await server.close();
    };
  } catch (error) {
    console.error("SSE init error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessionId ? sseTransports[sessionId] : undefined;

  if (!transport) {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No SSE transport found for sessionId",
      },
      id: null,
    });
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("SSE message error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.delete("/mcp", async (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, (error) => {
  if (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }

  console.log(`MCP local server running at http://localhost:${port}/mcp`);
  if (disableMcpAuth) {
    console.log(
      "MCP auth disabled (set DISABLE_MCP_AUTH=false to enforce auth).",
    );
  } else {
    console.log("MCP auth enabled.");
  }
});
